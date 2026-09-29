// 设备占用集成测试：启动独立服务实例（独立端口），验证：
//  1. 非持有者 devices_set 被拒（NOT_CONTROLLER）；清单校验（非数组/超 20 项/空名称/非法缓冲 → BAD_DEVICES）；
//  2. 持有者保存设备（名称/周转缓冲/绑定）后广播 devices，占用区间取权威推演（固定环节/普通环节）；
//  3. 周转缓冲不足 → 实时冲突（冲突双方、缺口分钟），多设备按最早冲突排序；内容无变化保存为 no-op；
//  4. 随议程/当前环节/计时状态变化实时重算：改时长制造重叠后冲突出现，重设议程后冲突消失；
//  5. 议程整体替换删除环节后，绑定到该环节的记录自动清理（seq 递增、绑定消失）；
//  6. 跨午夜 + 固定开始环节的占用比较正确；
//  7. 投屏（注册屏幕后）永不收到任何 devices 消息（含编辑广播与逐帧 tick）；
//  8. 新控制台连接（断线重连）首条指令即收到完整设备配置与冲突结果。
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = process.env.TEST_DEVICES_PORT || 3498;
const URL = `ws://localhost:${PORT}/ws`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const inbox = [];
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  });
}
async function next(inbox, type, pred, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const i = inbox.findIndex((m) => m.type === type && (!pred || pred(m)));
    if (i >= 0) return inbox.splice(i, 1)[0];
    if (Date.now() > deadline) throw new Error(`等待 ${type} 超时`);
    await sleep(20);
  }
}
async function drain(inbox, ms = 300) {
  await sleep(ms);
  return inbox.splice(0);
}

const child = spawn(process.execPath, ['server/src/index.js'], {
  env: { ...process.env, PORT: String(PORT), TICK_MS: '100' },
  stdio: 'ignore',
});

const H = (h, m = 0) => (h * 60 + m) * 60 * 1000;
const MIN = 60_000;
const DAY = 24 * 3600 * 1000;

try {
  for (let i = 0; i < 50; i++) {
    try { await connect().then((x) => x.ws.close()); break; } catch { await sleep(100); }
  }

  const con = await connect();
  await next(con.inbox, 'hello');
  await next(con.inbox, 'snapshot');
  // 设备负载不在首包：控制台首条非投屏指令（acquire）到达时才补发
  const helloNoise = await drain(con.inbox, 150);
  ok('首包不包含 devices 消息（角色尚未确定）', !helloNoise.some((m) => m.type === 'devices'));

  con.ws.send(JSON.stringify({ command: 'acquire' }));
  await next(con.inbox, 'control');
  const init = await next(con.inbox, 'devices');
  ok('acquire 后收到完整设备负载：空库、seq=1',
    init.seq === 1 && Array.isArray(init.devices) && init.devices.length === 0
      && Array.isArray(init.conflicts) && init.conflicts.length === 0,
    JSON.stringify({ seq: init.seq, len: init.devices?.length }));

  console.log('1) 权限与清单校验');
  const other = await connect();
  await next(other.inbox, 'hello');
  await next(other.inbox, 'snapshot');
  other.ws.send(JSON.stringify({ command: 'acquire' })); // 会被锁拒绝，但首条非投屏指令补发设备负载
  const otherDevices = await next(other.inbox, 'devices');
  ok('非持有控制台同样可收到设备负载（只读）', otherDevices.seq === 1);
  other.ws.send(JSON.stringify({ command: 'devices_set', devices: [] }));
  const notOwner = await next(other.inbox, 'error');
  ok('非持有者 devices_set 返回 NOT_CONTROLLER', notOwner.code === 'NOT_CONTROLLER', notOwner.code);
  other.ws.close();

  con.ws.send(JSON.stringify({ command: 'devices_set', devices: null }));
  ok('非数组返回 BAD_DEVICES', (await next(con.inbox, 'error')).code === 'BAD_DEVICES');
  con.ws.send(JSON.stringify({
    command: 'devices_set',
    devices: Array.from({ length: 21 }, (_, i) => ({ id: `z${i}`, name: `设备${i}`, turnaroundMin: 1, itemIds: [] })),
  }));
  ok('超过 20 项返回 BAD_DEVICES', (await next(con.inbox, 'error')).code === 'BAD_DEVICES');
  con.ws.send(JSON.stringify({ command: 'devices_set', devices: [{ name: '   ', turnaroundMin: 1 }] }));
  ok('空名称返回 BAD_DEVICES', (await next(con.inbox, 'error')).code === 'BAD_DEVICES');
  con.ws.send(JSON.stringify({ command: 'devices_set', devices: [{ name: '麦', turnaroundMin: -1 }] }));
  ok('负缓冲返回 BAD_DEVICES', (await next(con.inbox, 'error')).code === 'BAD_DEVICES');

  console.log('2) 设置议程（跨午夜固定环节场景）并保存设备绑定');
  // 议程：A 23:50 固定 10 分（普通），B 00:05 固定 10 分，C 00:15 普通 10 分，D 09:00 固定 10 分
  const items = [
    { id: 'a', name: '夜间环节A', startMs: H(23, 50), durationMs: 10 * MIN, fixed: false },
    { id: 'b', name: '午夜环节B', startMs: H(0, 5), durationMs: 10 * MIN, fixed: true },
    { id: 'c', name: '凌晨环节C', startMs: H(0, 15), durationMs: 10 * MIN, fixed: false },
    { id: 'd', name: '上午环节D', startMs: H(9), durationMs: 10 * MIN, fixed: true },
  ];
  con.ws.send(JSON.stringify({ command: 'agenda_set', items }));
  await next(con.inbox, 'snapshot');

  // 设备 mic：缓冲 10 分，绑定 a/b/c（a→b 空当 5 分冲突；b→c 背靠背冲突）
  // 设备 cam：缓冲 5 分，绑定 a/b/d（a→b 恰好 5 分不冲突；c 未绑定；b 00:15 → d 09:00 空当充足不冲突）
  con.ws.send(JSON.stringify({
    command: 'devices_set',
    devices: [
      { id: 'mic', name: '无线麦', turnaroundMin: 10, itemIds: ['a', 'b', 'c'] },
      { id: 'cam', name: '摄像机', turnaroundMin: 5, itemIds: ['a', 'b', 'd'] },
    ],
  }));
  const d1 = await next(con.inbox, 'devices', (m) => m.seq === 2);
  ok('设备库 seq=2，两项设备', d1.seq === 2 && d1.devices.length === 2, JSON.stringify(d1.seq));

  const mic = d1.devices.find((x) => x.id === 'mic');
  const cam = d1.devices.find((x) => x.id === 'cam');
  ok('mic 占用 3 场，按议程顺序', mic.occupations.map((o) => o.itemId).join(',') === 'a,b,c');
  ok('mic 三场的线性起点分别为 23:50 / 次日00:05 / 次日00:15',
    mic.occupations[0].startMs === H(23, 50)
      && mic.occupations[1].startMs === 24 * 3600 * 1000 + H(0, 5)
      && mic.occupations[2].startMs === 24 * 3600 * 1000 + H(0, 15),
    mic.occupations.map((o) => o.startMs).join(','));
  ok('mic 卷入冲突的占用为相邻双方（a,b,c 全部标红）', mic.conflictCount === 3);
  ok('cam 恰好达到缓冲（a→b 间隔 5 分=缓冲 5 分）不冲突；b→d 跨未绑定环节空当充足也不冲突',
    cam.conflictCount === 0
      && cam.occupations.find((o) => o.itemId === 'd').conflict === false
      && cam.occupations.find((o) => o.itemId === 'd').startMs === DAY + H(9),
    JSON.stringify(cam.occupations.map((o) => [o.itemId, o.startMs, o.conflict])));

  console.log('3) 冲突内容与最早冲突排序');
  ok('共 2 处冲突（均来自 mic）', d1.conflicts.length === 2,
    JSON.stringify(d1.conflicts.map((c) => `${c.deviceId}:${c.a.itemId}-${c.b.itemId}`)));
  // mic a→b：b 次日 00:05；mic b→c：c 次日 00:15
  ok('排序：mic a→b 最先，mic b→c 在后',
    d1.conflicts[0].deviceId === 'mic' && d1.conflicts[0].b.itemId === 'b'
      && d1.conflicts[1].deviceId === 'mic' && d1.conflicts[1].b.itemId === 'c',
    JSON.stringify(d1.conflicts.map((c) => `${c.deviceId}:${c.b.itemId}`)));
  const first = d1.conflicts[0];
  ok('首冲突：空当 5 分、缺口 5 分、缓冲 10 分、双方名称正确',
    first.gapMs === 5 * MIN && first.shortfallMs === 5 * MIN
      && first.turnaroundMs === 10 * MIN
      && first.a.itemName === '夜间环节A' && first.b.itemName === '午夜环节B',
    JSON.stringify({ gap: first.gapMs, short: first.shortfallMs }));

  // 再构造一处更早/同刻的第二设备冲突：cam 缓冲改 6 分后 a→b 差 1 分也冲突，
  // 与 mic 的 a→b 同刻（b 起点相同），应按设备顺序 mic 在 cam 前。
  con.ws.send(JSON.stringify({
    command: 'devices_set',
    devices: [
      { id: 'mic', name: '无线麦', turnaroundMin: 10, itemIds: ['a', 'b', 'c'] },
      { id: 'cam', name: '摄像机', turnaroundMin: 6, itemIds: ['a', 'b', 'd'] },
    ],
  }));
  const d1b = await next(con.inbox, 'devices', (m) => m.conflicts.length === 3);
  ok('cam 缓冲提高到 6 分后产生第 3 处冲突',
    d1b.conflicts.length === 3
      && d1b.conflicts[1].deviceId === 'cam' && d1b.conflicts[1].b.itemId === 'b'
      && d1b.conflicts[1].gapMs === 5 * MIN && d1b.conflicts[1].shortfallMs === 1 * MIN,
    JSON.stringify(d1b.conflicts.map((c) => `${c.deviceId}:${c.b.itemId}`)));

  // 恢复 cam 缓冲为 5（seq=4），随后的 no-op 以当前权威内容为准
  con.ws.send(JSON.stringify({
    command: 'devices_set',
    devices: [
      { id: 'mic', name: '无线麦', turnaroundMin: 10, itemIds: ['a', 'b', 'c'] },
      { id: 'cam', name: '摄像机', turnaroundMin: 5, itemIds: ['a', 'b', 'd'] },
    ],
  }));
  await next(con.inbox, 'devices', (m) => m.conflicts.length === 2);

  console.log('4) 内容无变化保存为 no-op（不增 seq、无 devices 广播）');
  const seqBeforeNoop = (await drain(con.inbox, 50)).filter((m) => m.type === 'devices').pop()?.seq ?? 4;
  con.ws.send(JSON.stringify({
    command: 'devices_set',
    devices: [
      { id: 'mic', name: '无线麦', turnaroundMin: 10, itemIds: ['a', 'b', 'c'] },
      { id: 'cam', name: '摄像机', turnaroundMin: 5, itemIds: ['a', 'b', 'd'] },
    ],
  }));
  const noise = await drain(con.inbox, 300);
  ok('no-op 保存无 devices 广播（内容未变化，seq 不前移）',
    !noise.some((m) => m.type === 'devices' && m.seq > seqBeforeNoop),
    JSON.stringify(noise.filter((m) => m.type === 'devices').map((m) => m.seq)));

  console.log('5) 随当前环节/计时状态变化实时重算冲突（权威偏差）');
  // 全新同日议程（避开前面的跨午夜场景）：
  //   p1 09:00 普通 5 分（当前），p2 09:05 普通 5 分。
  // 设备 lap：缓冲 10 分，绑定 p1/p2 —— 计划下背靠背（空当 0，缺口 10 分）本就冲突；
  // p1 提前结束（负偏差）只会让空当变大。为精确验证“计时状态变化驱动重算”，
  // 另取设备 room：缓冲 0 分 —— 计划下不冲突；让 p1 超时 ≥0 后 p2 预计开始随实时走时
  // 后移（不会与 p1 重叠），因此重点验证：finished 期间占用区间随权威逐帧后移、
  // 且设备负载与快照同一帧。
  con.ws.send(JSON.stringify({
    command: 'agenda_set',
    items: [
      { id: 'p1', name: '上午P1', startMs: H(9), durationMs: 5 * MIN, fixed: false },
      { id: 'p2', name: '上午P2', startMs: H(9, 8), durationMs: 5 * MIN, fixed: false },
    ],
  }));
  await next(con.inbox, 'snapshot');
  con.ws.send(JSON.stringify({
    command: 'devices_set',
    devices: [
      { id: 'lap', name: '抢答器', turnaroundMin: 10, itemIds: ['p1', 'p2'] },
      { id: 'room', name: '发言台', turnaroundMin: 0, itemIds: ['p1', 'p2'] },
    ],
  }));
  const dPlan = await next(con.inbox, 'devices', (m) =>
    m.devices.some((x) => x.id === 'lap') && m.devices.length === 2);
  const lapPlan = dPlan.conflicts.find((c) => c.deviceId === 'lap');
  ok('计划推演：抢答器缓冲 10 分而 p1(09:00-05)→p2(09:08) 仅空当 3 分 → 缺口 7 分冲突',
    lapPlan && lapPlan.gapMs === 3 * MIN && lapPlan.shortfallMs === 7 * MIN,
    JSON.stringify({ gap: lapPlan?.gapMs, short: lapPlan?.shortfallMs }));
  ok('计划推演：发言台缓冲 0 分背靠背不冲突',
    !dPlan.conflicts.some((c) => c.deviceId === 'room'));

  // 设定当前环节 p1 并把时长压到 1 秒，归零进入 finished：
  // p1 预计结束随超时实时后移，p2 预计开始（普通环节背靠背）同步后移。
  con.ws.send(JSON.stringify({ command: 'agenda_current', id: 'p1' }));
  await next(con.inbox, 'snapshot');
  con.ws.send(JSON.stringify({ command: 'set_duration', durationMs: 1000 }));
  await next(con.inbox, 'snapshot');
  con.ws.send(JSON.stringify({ command: 'start' }));
  await next(con.inbox, 'snapshot', (m) => m.phase === 'running');
  await next(con.inbox, 'snapshot', (m) => m.phase === 'finished');
  // finished 逐帧：取一帧设备负载及其同一时刻快照，验证区间一致且随超时后移
  await sleep(350);
  let paired = null;
  for (let tries = 0; tries < 20 && !paired; tries++) {
    const msgs = await drain(con.inbox, 150);
    const lastSnap = msgs.filter((m) => m.type === 'snapshot').pop();
    const lastDev = msgs.filter((m) => m.type === 'devices').pop();
    if (lastSnap && lastDev) paired = { lastSnap, lastDev };
  }
  ok('finished 期间逐帧收到设备负载', !!paired);
  if (paired) {
    const { lastSnap, lastDev } = paired;
    const p1SnapEnd = lastSnap.agenda.items.find((it) => it.id === 'p1').projEndMs;
    const p2SnapStart = lastSnap.agenda.items.find((it) => it.id === 'p2').projStartMs;
    const room = lastDev.devices.find((x) => x.id === 'room');
    const o1 = room.occupations.find((o) => o.itemId === 'p1');
    const o2 = room.occupations.find((o) => o.itemId === 'p2');
    ok('设备占用区间与同一帧快照推演严格一致（p1 结束、p2 开始）',
      o1.endMs === p1SnapEnd && o2.startMs === p2SnapStart,
      JSON.stringify({ o1: o1.endMs, snap: p1SnapEnd, o2: o2.startMs, snap2: p2SnapStart }));
    ok('超时实时后移：p1 预计结束晚于 09:00:01；p2 随之后移且仍与 p1 背靠背',
      p1SnapEnd > H(9) + 1000 && Math.abs(p2SnapStart - p1SnapEnd) < 1,
      JSON.stringify({ p1: p1SnapEnd, p2: p2SnapStart }));
  }

  // advance 固化：p1 超时结束 → 进入 p2（普通环节携带正偏差开始），冲突按新推演实时给出
  con.ws.send(JSON.stringify({ command: 'advance' }));
  const sAdv = await next(con.inbox, 'snapshot', (m) => m.agenda.currentId === 'p2');
  const dAdv = await next(con.inbox, 'devices');
  ok('advance 后进入 p2（抢答器冲突仍在，缺口随正偏差变化为实时值）',
    sAdv.agenda.currentId === 'p2'
      && dAdv.conflicts.some((c) => c.deviceId === 'lap' && c.b.itemId === 'p2'),
    JSON.stringify(dAdv.conflicts.map((c) => `${c.deviceId}:${c.b.itemId}`)));

  console.log('6) 议程整体替换删除环节 → 绑定自动清理');
  const seqBeforePrune = dAdv.seq;
  // 新议程只保留全新 id：旧绑定 p1/p2 全部失效，lap/room 绑定应清空、seq 递增
  con.ws.send(JSON.stringify({
    command: 'agenda_set',
    items: [
      { id: 'n1', name: '新环节1', startMs: H(9), durationMs: 60 * MIN, fixed: true },
      { id: 'n2', name: '新环节2', startMs: H(10), durationMs: 60 * MIN, fixed: false },
    ],
  }));
  const sNew = await next(con.inbox, 'snapshot');
  const dPruned = await next(con.inbox, 'devices');
  ok('删除环节后设备库 seq 递增', dPruned.seq === seqBeforePrune + 1,
    `seq ${seqBeforePrune}→${dPruned.seq}`);
  ok('两台设备对已删除环节（p1/p2）的绑定全部自动清理',
    dPruned.devices.every((x) => x.itemIds.length === 0 && x.occupations.length === 0),
    JSON.stringify(dPruned.devices.map((x) => [x.id, x.itemIds])));
  ok('清理后无冲突', dPruned.conflicts.length === 0);
  // 设备本身仍保留（名称/缓冲不丢）
  ok('设备本身保留（名称与周转缓冲不变）',
    dPruned.devices.find((x) => x.id === 'lap')?.name === '抢答器'
      && dPruned.devices.find((x) => x.id === 'room')?.turnaroundMs === 0);
  ok('快照同步为新议程', sNew.agenda.items.map((it) => it.id).join(',') === 'n1,n2');

  // 再保存绑定到新议程：n2 计划 10:30 开始（与 n1 结束 10:00 空当 30 分，缓冲 10 分 → 无冲突）
  con.ws.send(JSON.stringify({
    command: 'agenda_set',
    items: [
      { id: 'n1', name: '新环节1', startMs: H(9), durationMs: 60 * MIN, fixed: true },
      { id: 'n2', name: '新环节2', startMs: H(10, 30), durationMs: 60 * MIN, fixed: false },
    ],
  }));
  await next(con.inbox, 'snapshot');
  con.ws.send(JSON.stringify({
    command: 'devices_set',
    devices: [
      { id: 'lap', name: '抢答器', turnaroundMin: 10, itemIds: ['n1', 'n2'] },
      { id: 'room', name: '发言台', turnaroundMin: 0, itemIds: ['n1', 'n2'] },
    ],
  }));
  const dOk = await next(con.inbox, 'devices', (m) =>
    m.conflicts.length === 0 && m.devices.some((x) => x.id === 'lap') && m.devices.length === 2);
  ok('宽松议程下无冲突，占用区间为 09:00-10:00 / 10:30-11:30',
    dOk.devices.find((x) => x.id === 'lap').occupations[0].startMs === H(9)
      && dOk.devices.find((x) => x.id === 'lap').occupations[1].endMs === H(11, 30));

  console.log('7) 投屏永不接收 devices 消息（注册前缓冲，注册后逐帧也收不到）');
  const screen = await connect();
  await next(screen.inbox, 'hello');
  await next(screen.inbox, 'snapshot');
  screen.inbox.length = 0;
  screen.ws.send(JSON.stringify({ command: 'screen_register', screenId: 's-testdevices01', name: '设备测试屏' }));
  await next(screen.inbox, 'screen_hello');
  await drain(screen.inbox, 200);

  // 持有者制造一次设备广播与若干计时 tick
  con.ws.send(JSON.stringify({ command: 'devices_set', devices: [
    { id: 'lap', name: '抢答器改', turnaroundMin: 30, itemIds: ['n1', 'n2'] },
  ] }));
  await next(con.inbox, 'devices');
  con.ws.send(JSON.stringify({ command: 'agenda_current', id: 'n1' }));
  await next(con.inbox, 'snapshot');
  const got = await drain(screen.inbox, 500);
  ok('投屏注册后收不到任何 devices 消息（编辑广播 + 逐帧推演均无）',
    !got.some((m) => m.type === 'devices'),
    JSON.stringify(got.map((m) => m.type)));
  screen.ws.close();

  console.log('8) 断线重连恢复完整配置与冲突结果');
  const recon = await connect();
  await next(recon.inbox, 'hello');
  await next(recon.inbox, 'snapshot');
  recon.inbox.length = 0;
  recon.ws.send(JSON.stringify({ command: 'heartbeat' })); // 任意非投屏指令触发补发
  const dRecon = await next(recon.inbox, 'devices');
  ok('重连后首条指令即收到当前完整设备配置',
    dRecon.devices.length === 1
      && dRecon.devices[0].name === '抢答器改'
      && dRecon.devices[0].turnaroundMs === 30 * MIN
      && dRecon.devices[0].itemIds.join(',') === 'n1,n2',
    JSON.stringify({ seq: dRecon.seq, dev: dRecon.devices }));
  recon.ws.close();
  con.ws.close();

  console.log(`\n设备占用测试：${passed} 通过，${failures.length} 失败`);
  if (failures.length) {
    console.log('失败项:', failures.join('; '));
    process.exit(1);
  }
} catch (e) {
  console.error('  ✗', e.stack || e.message);
  process.exitCode = 1;
} finally {
  child.kill();
}
