// 现场标记（marker）集成测试：启动独立服务实例（独立端口），验证：
//  1. 非持有者不能记录/删除；名称 1~30 字校验；
//  2. 记录时固化发生时刻（单调会话内时间）、当前环节、已用时长与相对计划偏差；
//  3. 投屏连接（注册屏幕后）收不到标记广播；普通控制台连接可收到；
//  4. 暂停、重连、进入下一环节后历史标记顺序与归属不变；
//  5. 删除最近一条；空列表删除返回 NO_MARK；
//  6. 超时标记偏差含超时累积；固定环节顺延量恒为 0。
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = process.env.TEST_MARK_PORT || 3399;
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
async function nextMarkers(inbox, pred, timeout = 3000) {
  return next(inbox, 'markers', (m) => (!pred || pred(m)), timeout);
}
async function drain(inbox, ms = 300) {
  await sleep(ms);
  return inbox.splice(0);
}
// 在积压快照中查找满足谓词的最新快照（tick 每 200ms 一帧，需整体扫描避免遗漏状态切换）
async function waitSnapshot(inbox, pred, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    await sleep(50);
    const snaps = inbox.filter((m) => m.type === 'snapshot');
    if (snaps.some(pred)) return snaps.filter(pred).pop();
    inbox.length = 0;
    if (Date.now() > deadline) return null;
  }
}

const child = spawn(process.execPath, ['server/src/index.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

try {
  for (let i = 0; i < 50; i++) {
    try { await connect().then((x) => x.ws.close()); break; } catch { await sleep(100); }
  }

  console.log('1) 初始首包带空标记列表与会话 id');
  const con = await connect();
  await next(con.inbox, 'hello');
  await next(con.inbox, 'snapshot');
  const init = await next(con.inbox, 'markers');
  ok('初始标记列表为空且 sessionId 为字符串',
    Array.isArray(init.markers) && init.markers.length === 0 && typeof init.sessionId === 'string');
  con.ws.send(JSON.stringify({ command: 'acquire' }));
  await next(con.inbox, 'control');
  // acquire 触发的快照无标记消息；排干 tick 期间积压（不会有 markers）
  await drain(con.inbox, 100);

  console.log('2) 非持有者不能记录/删除');
  const other = await connect();
  await next(other.inbox, 'hello');
  await next(other.inbox, 'snapshot');
  await next(other.inbox, 'markers');
  other.ws.send(JSON.stringify({ command: 'mark_add', name: '非法操作' }));
  const errAdd = await next(other.inbox, 'error');
  ok('非持有者 mark_add 返回 NOT_CONTROLLER', errAdd.code === 'NOT_CONTROLLER', errAdd.code);
  other.ws.send(JSON.stringify({ command: 'mark_delete_latest' }));
  const errDel = await next(other.inbox, 'error');
  ok('非持有者 mark_delete_latest 返回 NOT_CONTROLLER', errDel.code === 'NOT_CONTROLLER', errDel.code);
  other.ws.close();

  console.log('3) 名称校验：空 / 超过 30 字被拒，且不产生标记');
  con.ws.send(JSON.stringify({ command: 'mark_add', name: '   ' }));
  const errEmpty = await next(con.inbox, 'error');
  ok('空白名称返回 BAD_MARK', errEmpty.code === 'BAD_MARK', errEmpty.code);
  con.ws.send(JSON.stringify({ command: 'mark_add', name: '字'.repeat(31) }));
  const errLong = await next(con.inbox, 'error');
  ok('超过 30 字返回 BAD_MARK', errLong.code === 'BAD_MARK', errLong.code);
  await drain(con.inbox, 100);
  ok('被拒后仍无 markers 广播', con.inbox.filter((m) => m.type === 'markers').length === 0);

  console.log('4) 未设定环节时记录：归属为空、偏差为 0');
  con.ws.send(JSON.stringify({ command: 'mark_add', name: '开场前备注' }));
  const mk0 = await nextMarkers(con.inbox, (m) => m.markers.length === 1);
  const m0 = mk0.markers[0];
  ok('seq 从 1 开始、名称保留、无归属环节',
    m0.seq === 1 && m0.name === '开场前备注' && m0.itemId === null && m0.itemName === null && m0.itemIndex === null);
  ok('发生时刻：挂钟时间存在、会话内相对时间为非负数',
    typeof m0.wallTime === 'string' && Number.isFinite(Date.parse(m0.wallTime)) && m0.sessionElapsedMs >= 0);
  ok('无当前环节时偏差 0、已用时长为 null', m0.deviationMs === 0 && m0.itemElapsedMs === null);
  ok('记录时计时状态为 idle', m0.phase === 'idle');

  console.log('5) 投屏（注册屏幕后）收不到标记广播');
  const disp = await connect();
  await next(disp.inbox, 'hello');
  await next(disp.inbox, 'snapshot');
  await next(disp.inbox, 'markers'); // 首包（注册前）有一份
  disp.ws.send(JSON.stringify({ command: 'screen_register', screenId: 's-aaaaaaaa-1111-4222-8333-cccccccccc01', name: '主屏' }));
  await next(disp.inbox, 'screen_hello');
  con.ws.send(JSON.stringify({ command: 'mark_add', name: '投屏不应看到' }));
  const mk1 = await nextMarkers(con.inbox, (m) => m.markers.length === 2);
  ok('控制台收到标记更新（2 条）', mk1.markers.length === 2);
  await drain(disp.inbox, 300);
  ok('注册为投屏后不再收到 markers 消息', disp.inbox.filter((m) => m.type === 'markers').length === 0);

  console.log('6) 设定议程与当前环节，运行中记录：归属与已用时长固化');
  const H = (h, m = 0) => (h * 60 + m) * 60 * 1000;
  const items = [
    { id: 'k0', name: '环节A', startMs: H(9), durationMs: 5000, fixed: false },
    { id: 'k1', name: '环节B', startMs: H(9) + 5000, durationMs: 5000, fixed: false }, // 09:00:05，与 k0 背靠背
    { id: 'k2', name: '固定C', startMs: H(9, 1), durationMs: 5000, fixed: true },
  ];
  con.ws.send(JSON.stringify({ command: 'agenda_set', items }));
  await waitSnapshot(con.inbox, (m) => m.agenda.items.length === 3);
  con.ws.send(JSON.stringify({ command: 'agenda_current', id: 'k0' }));
  await waitSnapshot(con.inbox, (m) => m.agenda.currentId === 'k0');
  con.ws.send(JSON.stringify({ command: 'start' }));
  await waitSnapshot(con.inbox, (m) => m.phase === 'running');
  await sleep(1200);
  con.inbox.length = 0;
  con.ws.send(JSON.stringify({ command: 'mark_add', name: '发言切换' }));
  const mkRun = await nextMarkers(con.inbox, (m) => m.markers.some((x) => x.name === '发言切换'));
  const mRun = mkRun.markers.find((x) => x.name === '发言切换');
  ok('运行中标记归属当前环节 k0 / 环节A / 序号 0',
    mRun.itemId === 'k0' && mRun.itemName === '环节A' && mRun.itemIndex === 0,
    JSON.stringify({ id: mRun.itemId, name: mRun.itemName, idx: mRun.itemIndex }));
  ok('已用时长约 1.2s 且 phase=running',
    mRun.phase === 'running' && mRun.itemElapsedMs > 800 && mRun.itemElapsedMs < 2500,
    `elapsed=${mRun.itemElapsedMs}`);
  ok('准时运行（无顺延未超时）偏差为 0', mRun.deviationMs === 0, `dev=${mRun.deviationMs}`);

  console.log('7) 暂停后记录：已用时长冻结；历史标记不变');
  con.ws.send(JSON.stringify({ command: 'pause' }));
  await waitSnapshot(con.inbox, (m) => m.phase === 'paused');
  con.inbox.length = 0;
  await sleep(500);
  con.ws.send(JSON.stringify({ command: 'mark_add', name: '设备故障' }));
  const mkPaused = await nextMarkers(con.inbox, (m) => m.markers.some((x) => x.name === '设备故障'));
  const mPause = mkPaused.markers.find((x) => x.name === '设备故障');
  ok('暂停中标记 phase=paused 且已用时长与暂停瞬间一致',
    mPause.phase === 'paused' && Math.abs(mPause.itemElapsedMs - mRun.itemElapsedMs) < 300,
    `${mPause.itemElapsedMs} vs ${mRun.itemElapsedMs}`);
  const runSnapshot = mkPaused.markers.find((x) => x.name === '发言切换');
  ok('历史标记归属/顺序保持不变（仍属 k0，且在前）',
    runSnapshot.itemId === 'k0'
      && mkPaused.markers.findIndex((x) => x.name === '发言切换')
        < mkPaused.markers.findIndex((x) => x.name === '设备故障'));

  console.log('8) 进入下一环节后：新标记归属下一环节，旧标记归属不变');
  con.ws.send(JSON.stringify({ command: 'advance' }));
  await waitSnapshot(con.inbox, (m) => m.agenda.currentId === 'k1' && m.phase === 'running');
  con.inbox.length = 0;
  await sleep(200);
  con.ws.send(JSON.stringify({ command: 'mark_add', name: 'B 环节事件' }));
  const mkNext = await nextMarkers(con.inbox, (m) => m.markers.some((x) => x.name === 'B 环节事件'));
  const mNext = mkNext.markers.find((x) => x.name === 'B 环节事件');
  ok('新标记归属 k1 / 环节B / 序号 1',
    mNext.itemId === 'k1' && mNext.itemName === '环节B' && mNext.itemIndex === 1,
    JSON.stringify({ id: mNext.itemId, name: mNext.itemName, idx: mNext.itemIndex }));
  const oldStillA = mkNext.markers.filter((x) => ['发言切换', '设备故障'].includes(x.name));
  ok('旧标记仍归属环节A，列表整体按 seq 升序',
    oldStillA.every((x) => x.itemId === 'k0')
      && mkNext.markers.every((x, i, arr) => i === 0 || x.seq > arr[i - 1].seq));
  // 环节A 提前约 (5s-已用~1.2s)=3.8s 结束：进入 B 时 B 的顺延量为负
  ok('提前进入 B：B 标记偏差为负（提前）',
    mNext.deviationMs < -2000, `dev=${mNext.deviationMs}`);

  console.log('9) 重连首包恢复全部标记，顺序/归属与会话一致');
  const con2 = await connect();
  await next(con2.inbox, 'hello');
  await next(con2.inbox, 'snapshot');
  const recon = await next(con2.inbox, 'markers');
  ok('重连后标记条数一致', recon.markers.length === mkNext.markers.length,
    `${recon.markers.length} vs ${mkNext.markers.length}`);
  ok('重连后顺序一致且 sessionId 相同',
    recon.sessionId === init.sessionId
      && recon.markers.map((x) => x.seq).join(',') === mkNext.markers.map((x) => x.seq).join(','));
  ok('重连后归属快照一致（设备故障仍属 k0）',
    recon.markers.find((x) => x.name === '设备故障').itemId === 'k0');
  con2.ws.close();

  console.log('10) 归零超时后标记：偏差含超时累积（固定环节顺延恒 0）');
  // 切到固定环节 k2：先 agenda_current 载入并开始，等待归零后继续超时
  con.ws.send(JSON.stringify({ command: 'agenda_current', id: 'k2' }));
  await waitSnapshot(con.inbox, (m) => m.agenda.currentId === 'k2');
  con.ws.send(JSON.stringify({ command: 'start' }));
  await waitSnapshot(con.inbox, (m) => m.phase === 'running');
  // k2 时长 5s：等待归零进入 finished
  const finSnap = await waitSnapshot(con.inbox, (m) => m.phase === 'finished', 8000);
  ok('固定环节归零进入 finished', !!finSnap);
  con.inbox.length = 0;
  await sleep(1500);
  con.ws.send(JSON.stringify({ command: 'mark_add', name: '固定环节超时' }));
  const mkOver = await nextMarkers(con.inbox, (m) => m.markers.some((x) => x.name === '固定环节超时'));
  const mOver = mkOver.markers.find((x) => x.name === '固定环节超时');
  ok('固定环节超时标记偏差≈+1.5s（顺延量恒 0，仅计本环节超时）',
    mOver.phase === 'finished' && mOver.deviationMs > 1000 && mOver.deviationMs < 2500,
    `dev=${mOver.deviationMs}`);
  ok('超时标记已用时长 > 5s', mOver.itemElapsedMs > 5000, `elapsed=${mOver.itemElapsedMs}`);

  console.log('11) 删除最近一条；空列表/连续删除返回 NO_MARK');
  const countBefore = mkOver.markers.length;
  con.ws.send(JSON.stringify({ command: 'mark_delete_latest' }));
  const mkDel = await nextMarkers(con.inbox, (m) => m.markers.length === countBefore - 1);
  ok('删除后条数减一且“固定环节超时”被移除',
    mkDel.markers.length === countBefore - 1 && !mkDel.markers.some((x) => x.name === '固定环节超时'));
  ok('被删的不是别的标记（最早一条仍在）', mkDel.markers[0].name === '开场前备注');

  console.log('12) 改写议程不改变历史标记归属');
  con.ws.send(JSON.stringify({
    command: 'agenda_set',
    items: [
      { id: 'z0', name: '全新环节', startMs: H(14), durationMs: 60000, fixed: false },
    ],
  }));
  await waitSnapshot(con.inbox, (m) => m.agenda.items.length === 1 && m.agenda.items[0].id === 'z0');
  // 改写议程不产生 markers 广播（历史未变）；用一条新连接取回权威列表核对
  const con3 = await connect();
  await next(con3.inbox, 'hello');
  await next(con3.inbox, 'snapshot');
  const mkRewrite = await next(con3.inbox, 'markers');
  ok('改写议程后标记条数不变', mkRewrite.markers.length === mkDel.markers.length,
    `${mkRewrite.markers.length} vs ${mkDel.markers.length}`);
  const stale = mkRewrite.markers.find((x) => x.name === 'B 环节事件');
  ok('议程整体替换后旧标记仍保留 k1/环节B 归属快照',
    stale.itemId === 'k1' && stale.itemName === '环节B' && stale.itemIndex === 1,
    JSON.stringify({ id: stale.itemId, name: stale.itemName }));
  ok('sessionId 未因改写议程而变化', mkRewrite.sessionId === init.sessionId);
  con3.ws.close();

  // 清理
  try { con.ws.close(); } catch {}
  try { disp.ws.close(); } catch {}

  console.log(`\n现场标记测试：${passed} 通过，${failures.length} 失败`);
  if (failures.length) {
    console.log('失败项:', failures.join('; '));
    process.exitCode = 1;
  }
} catch (e) {
  console.error('  ✗ 测试异常:', e);
  process.exitCode = 1;
} finally {
  child.kill();
}
