// 控制台交接（handover）集成测试：启动独立服务实例（短交接码 TTL），验证：
//  1. 仅持有者可生成交接码；非持有者/投屏连接生成被拒绝；
//  2. 生成后持有者仍可操作（计时继续走），所有控制台连接实时看到 pending（非持有者无码）；
//  3. 接收方输入正确码后服务端原子转移控制权：旧持有者立即失去、接收方立即持有；
//  4. 交接期间投屏不中断（快照持续到达）；交接后计时/议程状态连续（剩余时间单调、环节不变）；
//  5. 交接码一次性：成功后重复提交返回 HANDOVER_NONE；错误码返回 HANDOVER_BAD_CODE 且码仍可用；
//  6. 持有者不能核销自己的码（HANDOVER_SELF）；
//  7. 超时后码立即失效（双方收到 expired），核销返回 HANDOVER_NONE；
//  8. 持有者断线使等待码立即取消（cancelled / disconnected）；
//  9. 旧持有者的迟到心跳/命令不能夺回控制权或改写状态；
// 10. 重新生成使旧码立即失效（旧码核销被拒）；持有者可主动取消。
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = process.env.TEST_HANDOVER_PORT || 3499;
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
    ws.on('open', () => resolve({ ws, inbox, id: null }));
    ws.on('error', reject);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      inbox.push(m);
    });
  });
}
async function bootstrap(c) {
  const hello = await next(c.inbox, 'hello');
  await next(c.inbox, 'snapshot');
  c.id = hello.clientId;
  return c;
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
async function waitHandover(inbox, state, timeout = 3000) {
  return next(inbox, 'handover', (m) => m.state === state, timeout);
}
async function drain(inbox, ms = 200) {
  await sleep(ms);
  return inbox.splice(0);
}
async function waitSnapshot(inbox, pred, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    await sleep(40);
    const snaps = inbox.filter((m) => m.type === 'snapshot');
    if (snaps.some(pred)) return snaps.filter(pred).pop();
    inbox.length = 0;
    if (Date.now() > deadline) return null;
  }
}

const child = spawn(process.execPath, ['server/src/index.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HANDOVER_TTL_MS: '1500',
    HANDOVER_REAPER_MS: '100',
  },
  stdio: 'ignore',
});

async function acquire(c) {
  c.ws.send(JSON.stringify({ command: 'acquire' }));
  return next(c.inbox, 'control', (m) => m.granted);
}

try {
  for (let i = 0; i < 50; i++) {
    try { await connect().then((x) => x.ws.close()); break; } catch { await sleep(100); }
  }

  // ---------------- 场景 A：成功交接 + 一次性 + 连续性 + 迟到命令 ----------------
  console.log('A) 正常交接流程');
  const a = await bootstrap(await connect());
  await acquire(a);

  const b = await bootstrap(await connect());

  const disp = await bootstrap(await connect());
  disp.ws.send(JSON.stringify({
    command: 'screen_register',
    screenId: 's-bbbbbbbb-2222-4333-9444-dddddddddd02',
    name: '交接测试屏',
  }));
  await next(disp.inbox, 'screen_hello');
  // 排干注册/启动计时前的初始 idle 快照，后续 drain 只应看到交接等待期间的 running 帧
  await drain(disp.inbox, 50);

  console.log('A1) 非持有者生成交接码被拒绝');
  b.ws.send(JSON.stringify({ command: 'handover_create' }));
  const errNotHolder = await next(b.inbox, 'error', (m) => m.code === 'NOT_CONTROLLER');
  ok('非持有者 handover_create 返回 NOT_CONTROLLER', !!errNotHolder);

  console.log('A2) 投屏连接不能生成交接，且不接收任何 handover 广播');
  disp.ws.send(JSON.stringify({ command: 'handover_create' }));
  const errScreen = await next(disp.inbox, 'error', (m) => m.code === 'NOT_CONTROLLER');
  ok('投屏连接 handover_create 返回 NOT_CONTROLLER', !!errScreen);

  console.log('A3) 交接前先把计时跑起来（议程/当前环节/开始），验证交接期间状态连续');
  const H = (h, m = 0) => (h * 60 + m) * 60 * 1000;
  a.ws.send(JSON.stringify({
    command: 'agenda_set',
    items: [
      { id: 'h0', name: '交接环节', startMs: H(9), durationMs: 60000, fixed: false },
      { id: 'h1', name: '下一环节', startMs: H(9, 1), durationMs: 60000, fixed: false },
    ],
  }));
  await waitSnapshot(a.inbox, (m) => m.agenda.items.length === 2);
  a.ws.send(JSON.stringify({ command: 'agenda_current', id: 'h0' }));
  await waitSnapshot(a.inbox, (m) => m.agenda.currentId === 'h0');
  a.ws.send(JSON.stringify({ command: 'start' }));
  await waitSnapshot(a.inbox, (m) => m.phase === 'running');

  console.log('A4) 持有者生成交接码：持有者单播带码，其他控制台 pending 无码');
  a.ws.send(JSON.stringify({ command: 'handover_create' }));
  const aPending = await waitHandover(a.inbox, 'pending');
  ok('持有者收到 pending 且为 6 位数字码',
    aPending.state === 'pending' && /^\d{6}$/.test(aPending.code), JSON.stringify(aPending));
  ok('pending 带 TTL（测试实例 1500ms）与到期时刻',
    aPending.ttlMs === 1500 && aPending.expiresAtMono > aPending.createdAtMono);
  const bPending = await waitHandover(b.inbox, 'pending');
  ok('接收方收到 pending 但不含交接码', bPending.state === 'pending' && bPending.code === undefined);
  const beforeMsgs = await drain(disp.inbox, 500);
  const displayHoEvents = beforeMsgs.filter((m) => m.type === 'handover' && m.seq > 0);
  const displaySnaps = beforeMsgs.filter((m) => m.type === 'snapshot');
  const runSnaps = displaySnaps.filter((m) => m.phase === 'running');
  ok('生成交接码期间投屏不接收 handover 事件，仅持续收 running 快照（不中断）',
    displayHoEvents.length === 0 && runSnaps.length >= 2,
    `ho=${displayHoEvents.length} totalSnaps=${displaySnaps.length} runSnaps=${runSnaps.length} phases=${[...new Set(displaySnaps.map((m) => m.phase))].join('/')}`);
  const beforeRem = beforeMsgs.filter((m) => m.type === 'snapshot').pop()?.remainingMs;
  ok('交接等待前已取得投屏剩余时间基线', typeof beforeRem === 'number', String(beforeRem));

  console.log('A5) 错误码被拒绝且等待码仍然有效');
  const wrong = aPending.code === '000000' ? '111111' : '000000';
  b.ws.send(JSON.stringify({ command: 'handover_redeem', code: wrong }));
  const errBad = await next(b.inbox, 'error', (m) => m.code === 'HANDOVER_BAD_CODE');
  ok('错误交接码返回 HANDOVER_BAD_CODE', !!errBad);
  await sleep(120);
  // 注意：b 首包自带 seq=0 的 idle；这里只看 seq>0 的事件，确认错误码没有引发任何终态
  const terminals = b.inbox.filter((m) => m.type === 'handover' && m.state !== 'pending' && m.seq > 0);
  ok('错误码尝试后无 handover 终态广播（码仍有效）', terminals.length === 0,
    terminals.map((m) => `${m.state}#${m.seq}`).join(','));

  console.log('A6) 持有者不能核销自己的码');
  a.ws.send(JSON.stringify({ command: 'handover_redeem', code: aPending.code }));
  const errSelf = await next(a.inbox, 'error', (m) => m.code === 'HANDOVER_SELF');
  ok('持有者自核销返回 HANDOVER_SELF', !!errSelf);

  console.log('A7) 输入正确码：原子转移，双方实时收到结果');
  const tTransfer = Date.now();
  b.ws.send(JSON.stringify({ command: 'handover_redeem', code: aPending.code }));
  const [bControl, aControl, bHo, aHo] = await Promise.all([
    next(b.inbox, 'control', (m) => m.granted === true),
    next(a.inbox, 'control', (m) => m.granted === false && m.reason === 'handover'),
    waitHandover(b.inbox, 'success'),
    waitHandover(a.inbox, 'success'),
  ]);
  ok('接收方立即获得控制权（targetId 为本连接）',
    !!bControl && bControl.targetId === b.id, `target=${bControl.targetId} self=${b.id}`);
  ok('旧持有者立即收到 reason=handover 的失去通知', !!aControl);
  ok('接收方 success 且 newHolderId=自己、holderId=旧持有者',
    bHo.state === 'success' && bHo.newHolderId === b.id && bHo.holderId === a.id,
    JSON.stringify({ n: bHo.newHolderId, h: bHo.holderId }));
  ok('旧持有者同样实时收到 success 终态', aHo.state === 'success');
  ok('交接在毫秒级完成（无锁空窗）', Date.now() - tTransfer < 1000, `${Date.now() - tTransfer}ms`);

  const snapB = await waitSnapshot(b.inbox, (m) => m.locked === true && m.phase === 'running');
  ok('交接后锁定仍为 true、计时保持 running（状态连续）',
    !!snapB && snapB.locked && snapB.phase === 'running');
  ok('交接后当前环节仍是 h0（议程连续）', snapB && snapB.agenda.currentId === 'h0');
  const afterMsgs = await drain(disp.inbox, 400);
  const afterSnap = afterMsgs.filter((m) => m.type === 'snapshot').pop();
  ok('投屏全程未中断且剩余时间单调连续（仅小幅流逝）',
    afterSnap.phase === 'running'
      && afterSnap.remainingMs < beforeRem
      && beforeRem - afterSnap.remainingMs < 3000,
    `before=${beforeRem} after=${afterSnap.remainingMs}`);
  ok('交接成功不向投屏推送任何 handover 消息',
    afterMsgs.filter((m) => m.type === 'handover').length === 0);

  console.log('A8) 交接码一次性：成功后重复提交被拒绝');
  b.ws.send(JSON.stringify({ command: 'handover_redeem', code: aPending.code }));
  const errReuse = await next(b.inbox, 'error', (m) => m.code === 'HANDOVER_NONE');
  ok('重复提交已用码返回 HANDOVER_NONE', !!errReuse);

  console.log('A9) 旧持有者迟到心跳/命令不能夺回控制权或改写状态');
  a.ws.send(JSON.stringify({ command: 'heartbeat' }));
  const errHb = await next(a.inbox, 'error', (m) => m.code === 'NOT_CONTROLLER');
  ok('旧持有者迟到心跳被拒绝（NOT_CONTROLLER）', !!errHb);
  a.ws.send(JSON.stringify({ command: 'pause' }));
  const errCmd = await next(a.inbox, 'error', (m) => m.code === 'NOT_CONTROLLER');
  ok('旧持有者迟到命令被拒绝（NOT_CONTROLLER）', !!errCmd);
  await drain(b.inbox, 300);
  const stillRun = b.inbox.filter((m) => m.type === 'snapshot').every((m) => m.phase === 'running');
  ok('旧持有者命令未改写状态（新持有者视角仍 running）', stillRun);

  console.log('A10) 新持有者可立即正常操作（暂停/继续被接受）');
  b.ws.send(JSON.stringify({ command: 'pause' }));
  const pausedSnap = await waitSnapshot(b.inbox, (m) => m.phase === 'paused');
  ok('新持有者暂停成功（租约命令通畅）', !!pausedSnap);
  b.ws.send(JSON.stringify({ command: 'resume' }));
  await waitSnapshot(b.inbox, (m) => m.phase === 'running');

  a.ws.close();
  disp.ws.close();

  // ---------------- 场景 B：重新生成使旧码失效 + 主动取消 ----------------
  console.log('B) 持有者重新生成：旧码立即作废；持有者可取消');
  const b2 = await bootstrap(await connect());
  b.ws.send(JSON.stringify({ command: 'handover_create' }));
  const code1 = await waitHandover(b.inbox, 'pending');
  await waitHandover(b2.inbox, 'pending');
  b.ws.send(JSON.stringify({ command: 'handover_create' }));
  const code2 = await next(b.inbox, 'handover',
    (m) => m.state === 'pending' && m.code && m.code !== code1.code);
  ok('第二次生成得到不同的新码且 seq 递增',
    /^\d{6}$/.test(code2.code) && code2.seq > code1.seq);
  await waitHandover(b2.inbox, 'pending'); // 新 seq 等待态广播
  b2.ws.send(JSON.stringify({ command: 'handover_redeem', code: code1.code }));
  const errOld = await next(b2.inbox, 'error', (m) => m.code === 'HANDOVER_BAD_CODE');
  ok('旧码核销被拒绝（HANDOVER_BAD_CODE，新码仍有效）', !!errOld);
  b2.ws.send(JSON.stringify({ command: 'handover_cancel' }));
  const errCancelNotHolder = await next(b2.inbox, 'error', (m) => m.code === 'NOT_CONTROLLER');
  ok('非持有者不能取消交接', !!errCancelNotHolder);
  b.ws.send(JSON.stringify({ command: 'handover_cancel' }));
  const cancelHoB = await waitHandover(b.inbox, 'cancelled');
  const cancelHoB2 = await waitHandover(b2.inbox, 'cancelled');
  ok('持有者取消：双方实时收到 cancelled',
    cancelHoB.state === 'cancelled' && cancelHoB2.state === 'cancelled');
  b2.ws.send(JSON.stringify({ command: 'handover_redeem', code: code2.code }));
  const errCanceled = await next(b2.inbox, 'error', (m) => m.code === 'HANDOVER_NONE');
  ok('取消后核销返回 HANDOVER_NONE', !!errCanceled);
  b2.ws.close();

  // ---------------- 场景 C：超时自动失效 ----------------
  console.log('C) 交接码在 TTL（测试实例 1.5 秒）后自动过期，双方实时收到 expired');
  const c = await bootstrap(await connect());
  b.ws.send(JSON.stringify({ command: 'handover_create' }));
  const cPending = await waitHandover(b.inbox, 'pending');
  await waitHandover(c.inbox, 'pending');
  const t0 = Date.now();
  const expiredB = await waitHandover(b.inbox, 'expired', 4000);
  const elapsed = Date.now() - t0;
  const expiredC = await waitHandover(c.inbox, 'expired', 1000);
  ok('持有者实时收到 expired，且约在 TTL 时刻（1.5s±1.1s）',
    expiredB.state === 'expired' && elapsed > 1300 && elapsed < 2600, `${elapsed}ms`);
  ok('接收方实时收到 expired', expiredC.state === 'expired');
  c.ws.send(JSON.stringify({ command: 'handover_redeem', code: cPending.code }));
  const errExp = await next(c.inbox, 'error', (m) => m.code === 'HANDOVER_NONE');
  ok('过期后核销返回 HANDOVER_NONE', !!errExp);
  b.ws.send(JSON.stringify({ command: 'pause' }));
  const stillHolder = await waitSnapshot(b.inbox, (m) => m.phase === 'paused').catch(() => null);
  ok('过期后原持有者未失去控制权（暂停仍被接受）', !!stillHolder);
  b.ws.send(JSON.stringify({ command: 'resume' }));
  await waitSnapshot(b.inbox, (m) => m.phase === 'running');
  b.ws.close(); // 释放租约供场景 D
  c.ws.close();

  // ---------------- 场景 D：持有者断线 → 等待码立即取消 ----------------
  console.log('D) 交接等待中持有者断线：码立即取消，之后其他控制台可正常接管');
  const d = await bootstrap(await connect());
  const e = await bootstrap(await connect());
  await acquire(d);
  d.ws.send(JSON.stringify({ command: 'handover_create' }));
  await waitHandover(d.inbox, 'pending');
  await waitHandover(e.inbox, 'pending');
  d.ws.close();
  const cancelledE = await waitHandover(e.inbox, 'cancelled', 3000);
  ok('持有者断线：接收方实时收到 cancelled（reason=disconnected）',
    cancelledE.state === 'cancelled' && cancelledE.reason === 'disconnected',
    JSON.stringify(cancelledE.reason));
  e.ws.send(JSON.stringify({ command: 'handover_redeem', code: '000000' }));
  const errGone = await next(e.inbox, 'error', (m) => m.code === 'HANDOVER_NONE');
  ok('断线后任何码核销均返回 HANDOVER_NONE', !!errGone);
  await acquire(e);
  ok('持有者断线释放后，其他控制台可正常 acquire 接管', true);
  e.ws.close();

  console.log(`\n控制台交接测试：${passed} 通过，${failures.length} 失败`);
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
