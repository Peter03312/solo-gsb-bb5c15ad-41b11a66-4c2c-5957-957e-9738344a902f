// 端到端冒烟测试：直接对运行中的服务端建立 WebSocket 连接。
// 用法：先启动服务端（PORT=3000），再执行 node test/e2e.mjs
import { WebSocket } from 'ws';

const PORT = process.env.PORT || 3000;
const URL = `ws://localhost:${PORT}/ws`;

let passed = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name} ${extra}`);
  }
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function next(inbox, type, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const i = inbox.findIndex((m) => m.type === type);
    if (i >= 0) return inbox.splice(i, 1)[0];
    if (Date.now() > deadline) throw new Error(`等待 ${type} 超时`);
    await sleep(20);
  }
}

// 等待满足谓词的快照；跳过（丢弃）积压中不匹配的旧快照，避免 tick 积压造成误判
async function nextSnap(inbox, pred, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (let i = 0; i < inbox.length; i++) {
      if (inbox[i].type === 'snapshot' && pred(inbox[i])) {
        return inbox.splice(i, 1)[0];
      }
    }
    if (Date.now() > deadline) throw new Error('等待匹配快照超时');
    await sleep(20);
  }
}

async function drain(inbox, timeout = 400) {
  await sleep(timeout);
  const out = inbox.splice(0);
  return out;
}

async function main() {
  console.log('1) 连接与初始快照');
  const a = await connect();
  await next(a.inbox, 'hello');
  const s0 = await next(a.inbox, 'snapshot');
  ok('初始 phase=idle', s0.phase === 'idle');
  ok('初始剩余=默认5分钟', s0.remainingMs === 300000, `got ${s0.remainingMs}`);
  ok('初始无持有者', s0.locked === false && s0.holderId === null);
  ok('版本号为正整数', Number.isInteger(s0.version) && s0.version > 0);

  console.log('2) 唯一控制权：第二个控制台被拒');
  const b = await connect();
  await next(b.inbox, 'hello');
  await next(b.inbox, 'snapshot');
  a.ws.send(JSON.stringify({ command: 'acquire' }));
  const granted = await next(a.inbox, 'control');
  ok('A 获得控制权', granted.granted === true);
  b.ws.send(JSON.stringify({ command: 'acquire' }));
  const denied = await next(b.inbox, 'control');
  ok('B 被拒绝且 reason=locked', denied.granted === false && denied.reason === 'locked');
  ok('拒绝消息单播给 B 且带持有者 id',
    denied.targetId != null && denied.holderId != null);
  const sLock = (await drain(a.inbox, 300)).filter((m) => m.type === 'snapshot').pop();
  ok('快照广播 locked=true', !!(sLock && sLock.locked));

  console.log('3) 非持有者指令被拒');
  b.ws.send(JSON.stringify({ command: 'start' }));
  const err = await next(b.inbox, 'error');
  ok('B 执行 start 返回 NOT_CONTROLLER', err.code === 'NOT_CONTROLLER');

  console.log('4) 设定短时长（2.5s）并开始');
  a.ws.send(JSON.stringify({ command: 'set_duration', durationMs: 2500 }));
  const sSet = await next(a.inbox, 'snapshot');
  ok('set_duration 生效', sSet.durationMs === 2500 && sSet.remainingMs === 2500);
  a.ws.send(JSON.stringify({ command: 'start' }));
  const sRun = await next(a.inbox, 'snapshot');
  ok('开始后 phase=running', sRun.phase === 'running');
  ok('剩余≤60s 时 warning=true', sRun.warning === true, JSON.stringify(sRun));

  console.log('5) tick 版本严格递增、剩余时间递减');
  const ticks = (await drain(a.inbox, 700)).filter((m) => m.type === 'snapshot');
  let mono = true;
  for (let i = 1; i < ticks.length; i++) {
    if (!(ticks[i].version > ticks[i - 1].version) || !(ticks[i].remainingMs <= ticks[i - 1].remainingMs + 1)) {
      mono = false;
    }
  }
  ok('tick 版本递增且剩余不增', mono && ticks.length >= 2, `ticks=${ticks.length}`);

  console.log('6) 暂停/继续保持同一剩余时间');
  a.ws.send(JSON.stringify({ command: 'pause' }));
  const sPaused = await nextSnap(a.inbox, (m) => m.phase === 'paused');
  ok('暂停后 phase=paused', sPaused.phase === 'paused');
  const frozen = sPaused.remainingMs;
  const pausedSnaps = (await drain(a.inbox, 400)).filter((m) => m.type === 'snapshot');
  ok('暂停期间无广播或全部冻结',
    pausedSnaps.every((m) => m.phase === 'paused' && m.remainingMs === frozen),
    JSON.stringify(pausedSnaps.map((m) => m.remainingMs)));
  a.ws.send(JSON.stringify({ command: 'resume' }));
  const sResume = await nextSnap(a.inbox, (m) => m.phase === 'running');
  ok('继续后 phase=running', sResume.phase === 'running');
  ok('继续起点≈冻结值', Math.abs(sResume.remainingMs - frozen) < 100, `${sResume.remainingMs} vs ${frozen}`);

  console.log('7) 归零自动 finished');
  // 当前计时约在运行，等其归零（2.5s 总长，已用约 1.5s）
  let sFin;
  for (let i = 0; i < 60; i++) {
    const m = await next(a.inbox, 'snapshot', 5000).catch(() => null);
    if (m && m.phase === 'finished') { sFin = m; break; }
  }
  ok('归零 phase=finished', !!sFin);
  ok('归零 remaining=0', sFin && sFin.remainingMs === 0);
  ok('归零 finished=true', sFin && sFin.finished === true);
  const after = (await drain(a.inbox, 600)).filter((m) => m.type === 'snapshot');
  ok('finished 后不再周期广播', after.length === 0, `got ${after.length}`);

  console.log('8) 重置恢复完整时长且 warning 解除');
  a.ws.send(JSON.stringify({ command: 'reset', durationMs: 500 }));
  const badReset = await next(a.inbox, 'error');
  ok('reset 非法时长被拒(<1s)', badReset.code === 'INVALID_DURATION');
  a.ws.send(JSON.stringify({ command: 'reset', durationMs: 120000 }));
  const sReset = await next(a.inbox, 'snapshot');
  ok('重置后 idle 且 120s', sReset.phase === 'idle' && sReset.remainingMs === 120000);
  ok('>60s warning=false', sReset.warning === false);

  console.log('9) 投屏重连恢复同一剩余时间');
  a.ws.send(JSON.stringify({ command: 'set_duration', durationMs: 30000 }));
  await next(a.inbox, 'snapshot');
  a.ws.send(JSON.stringify({ command: 'start' }));
  await next(a.inbox, 'snapshot');
  await sleep(1200);
  const c = await connect();
  await next(c.inbox, 'hello');
  const sRecv = await next(c.inbox, 'snapshot');
  ok('新连接立即收到 running 快照', sRecv.phase === 'running');
  ok('恢复剩余≈28.8s（同一计时）', Math.abs(sRecv.remainingMs - 28800) < 1200, `got ${sRecv.remainingMs}`);
  c.ws.close();

  console.log('10) 断线立即释放控制权，他人可接管');
  a.ws.close();
  await sleep(300);
  b.ws.send(JSON.stringify({ command: 'acquire' }));
  const take = await next(b.inbox, 'control');
  ok('A 断线后 B 获得控制权', take.granted === true);

  console.log('11) 主动释放');
  b.ws.send(JSON.stringify({ command: 'release' }));
  await sleep(300);
  const d = await connect();
  await next(d.inbox, 'hello');
  const sAfterRel = await next(d.inbox, 'snapshot');
  ok('释放后 locked=false', sAfterRel.locked === false);
  d.ws.close();
  b.ws.close();

  // -----------------------------------------------------------------------
  // 议程偏差推演
  // -----------------------------------------------------------------------
  console.log('12) 议程：整体下发、非法议程被拒、设定当前环节');
  const e = await connect();
  await next(e.inbox, 'hello');
  await next(e.inbox, 'snapshot');
  e.ws.send(JSON.stringify({ command: 'acquire' }));
  await next(e.inbox, 'control');
  await drain(e.inbox, 300);
  e.ws.send(JSON.stringify({
    command: 'agenda_set',
    items: [{ id: 'i0', name: '坏数据', startMs: 25 * 3600_000, durationMs: 60000 }],
  }));
  const badAgenda = await next(e.inbox, 'error');
  ok('非法议程返回 BAD_AGENDA', badAgenda.code === 'BAD_AGENDA', badAgenda.code);

  // 合法议程：
  // i0 09:00 5min 普通（当前）
  // i1 09:05 5min 普通
  // i2 09:10 5min 固定
  // i3 09:15 5min 普通
  const H = (h, m = 0) => (h * 60 + m) * 60 * 1000;
  const agendaItems = [
    { id: 'i0', name: '环节A', startMs: H(9), durationMs: 5 * 60000, fixed: false },
    { id: 'i1', name: '环节B', startMs: H(9, 5), durationMs: 5 * 60000, fixed: false },
    { id: 'i2', name: '固定C', startMs: H(9, 10), durationMs: 5 * 60000, fixed: true },
    { id: 'i3', name: '环节D', startMs: H(9, 15), durationMs: 5 * 60000, fixed: false },
  ];
  e.ws.send(JSON.stringify({ command: 'agenda_set', items: agendaItems }));
  const sAg = await nextSnap(e.inbox, (m) =>
    m.agenda && m.agenda.items.length === 4 && m.agenda.items[0].name === '环节A');
  ok('议程整体下发成功', sAg.agenda.seq >= 1 && sAg.agenda.currentId === null);
  ok('未设当前时全部 planned', sAg.agenda.items.every((it) => it.status === 'planned'));

  // 不存在的 id 被拒
  e.ws.send(JSON.stringify({ command: 'agenda_current', id: 'nope' }));
  const noCur = await next(e.inbox, 'error');
  ok('设定不存在的当前环节返回 NOT_FOUND', noCur.code === 'NOT_FOUND');

  e.ws.send(JSON.stringify({ command: 'agenda_current', id: 'i0' }));
  const sCur = await nextSnap(e.inbox, (m) => m.agenda && m.agenda.currentId === 'i0');
  ok('设定当前环节 currentId=i0', !!sCur);
  const curRow0 = sCur.agenda.items.find((it) => it.id === 'i0');
  ok('当前环节状态=current 且载入时长 5min',
    curRow0.status === 'current' && sCur.durationMs === 300000);
  ok('设定当前后 phase=idle', sCur.phase === 'idle');

  console.log('13) 议程：提前结束，后续普通环节预计开始前移，固定环节不动');
  e.ws.send(JSON.stringify({ command: 'start' }));
  await nextSnap(e.inbox, (m) => m.phase === 'running');
  await sleep(2000); // A 已运行 2s（计划 5min）
  // 未超时时推演假设按时结束：B 预计开始仍为计划 09:05
  const sLive = (await drain(e.inbox, 300)).filter((m) => m.type === 'snapshot').pop();
  const liveB = sLive.agenda.items.find((it) => it.id === 'i1');
  ok('未超时运行中 B 预计开始保持计划 09:05',
    liveB.projStartMs === H(9, 5),
    `got ${new Date(liveB.projStartMs).toISOString()}`);

  e.ws.send(JSON.stringify({ command: 'advance' }));
  const sAdv = await nextSnap(e.inbox, (m) => m.agenda && m.agenda.currentId === 'i1' && m.phase === 'running');
  ok('advance 后自动进入 i1 且 running', !!sAdv);
  const b1 = sAdv.agenda.items.find((it) => it.id === 'i1');
  const c1 = sAdv.agenda.items.find((it) => it.id === 'i2');
  ok('B 预计开始 ≈ 09:00:02（提前约 3 分钟）',
    Math.abs(b1.projStartMs - (H(9) + 2000)) < 800, `got ${b1.projStartMs - H(9)}`);
  ok('固定环节 C 预计开始仍是 09:10', c1.projStartMs === H(9, 10));
  ok('B 在 09:10 之前结束，无时间不足', b1.insufficient === false);

  console.log('14) 议程：超时撞上固定环节，压缩其前最后一个普通环节并标时间不足');
  // 时间线（相对 10:00）：j0 普通 [0,3]；j1 普通 [3,8]；j2 固定开始于 8。
  // j0 超时到 ~4.8 才结束 → j1 预计 [4.8, 9.8] 与固定点 8 重叠 →
  // j1 被压缩为 [4.8, 8]（3.2s < 计划 5s），标记时间不足。
  const T0 = H(10);
  const shortAgenda = [
    { id: 'j0', name: '当前项', startMs: T0, durationMs: 3000, fixed: false },
    { id: 'j1', name: '普通项', startMs: T0 + 3000, durationMs: 5000, fixed: false },
    { id: 'j2', name: '固定项', startMs: T0 + 8000, durationMs: 5000, fixed: true },
  ];
  e.ws.send(JSON.stringify({ command: 'agenda_set', items: shortAgenda }));
  await nextSnap(e.inbox, (m) => m.agenda && m.agenda.items.length === 3);
  e.ws.send(JSON.stringify({ command: 'agenda_current', id: 'j0' }));
  await nextSnap(e.inbox, (m) => m.agenda && m.agenda.currentId === 'j0');
  e.ws.send(JSON.stringify({ command: 'start' }));
  await nextSnap(e.inbox, (m) => m.phase === 'running');
  // j0 归零后再多等约 1.8s（超时累积），然后结束本环节
  await sleep(4800);
  const sOver = (await drain(e.inbox, 300)).filter((m) => m.type === 'snapshot').pop();
  ok('归零后 phase=finished 且仍在广播超时偏差',
    sOver.phase === 'finished' && sOver.agenda.deviationMs > 1500,
    `dev=${sOver.agenda.deviationMs}`);

  e.ws.send(JSON.stringify({ command: 'advance' }));
  const sJ1 = await nextSnap(e.inbox, (m) => m.agenda && m.agenda.currentId === 'j1' && m.phase === 'running');
  const j1pre = sJ1.agenda.items.find((it) => it.id === 'j1');
  ok('j1 因前序超时延后开始（约 4.8s 处）',
    j1pre.projStartMs > T0 + 4500 && j1pre.projStartMs < T0 + 5300,
    `got ${j1pre.projStartMs - T0}`);
  // j1 [4.8, 9.8] 已越过固定点 8：进入瞬间即被压缩
  ok('j1 进入即撞上固定项：被压缩到固定点且标记时间不足',
    j1pre.insufficient === true
      && Math.abs(j1pre.projEndMs - (T0 + 8000)) < 50
      && j1pre.effDurationMs < 5000,
    JSON.stringify({ end: j1pre.projEndMs - T0, eff: j1pre.effDurationMs, ins: j1pre.insufficient }));
  const j2row = sJ1.agenda.items.find((it) => it.id === 'j2');
  ok('固定项预计开始时间不变', j2row.projStartMs === T0 + 8000);

  // 运行中该标记保持；随后暂停以验证冻结与重连一致
  e.ws.send(JSON.stringify({ command: 'pause' }));
  const sP = await nextSnap(e.inbox, (m) => m.phase === 'paused');
  const frozenDev = sP.agenda.deviationMs;
  const frozenNext = sP.agenda.items.find((it) => it.id === 'j2').projStartMs;
  await sleep(800);
  const sP2 = (await drain(e.inbox, 200)).filter((m) => m.type === 'snapshot').pop();
  ok('暂停期间偏差冻结',
    !sP2 || (sP2.agenda.deviationMs === frozenDev),
    `got ${sP2 && sP2.agenda.deviationMs} vs ${frozenDev}`);

  const f = await connect();
  await next(f.inbox, 'hello');
  const sReconn = await next(f.inbox, 'snapshot');
  ok('重连首包携带完整议程', Array.isArray(sReconn.agenda.items) && sReconn.agenda.items.length === 3);
  const rj1 = sReconn.agenda.items.find((it) => it.id === 'j1');
  const rj2 = sReconn.agenda.items.find((it) => it.id === 'j2');
  ok('重连后时间不足标记一致', rj1.insufficient === true);
  ok('重连后固定项预计开始一致', rj2.projStartMs === frozenNext);
  ok('重连后当前环节一致（j1/paused）',
    sReconn.agenda.currentId === 'j1' && sReconn.phase === 'paused');

  console.log('16) 议程：非持有者操作被拒');
  f.ws.send(JSON.stringify({ command: 'agenda_set', items: [] }));
  const notCtrl = await next(f.inbox, 'error');
  ok('非持有者 agenda_set 返回 NOT_CONTROLLER', notCtrl.code === 'NOT_CONTROLLER');
  f.ws.close();
  e.ws.close();

  console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
  if (failures.length) {
    console.log('失败项:', failures.join('; '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
