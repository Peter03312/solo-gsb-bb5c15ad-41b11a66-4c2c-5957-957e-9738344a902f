// 设备巡检门禁集成测试：启动独立服务实例（独立端口），验证：
//  1. 非持有者不能维护清单/登记；清单校验（空名称、超过 30 项、故障必填备注、未知 id）；
//  2. 无必检项时门禁不拦截开始；设置必检项后未全部通过，start 返回 INSPECTION_GATE；
//  3. 逐项登记通过，全部必检通过后门禁放行，开始计时成功；
//  4. 运行中把必检项改回故障：门禁立即失效并广播 inspection_gate 原因；
//     重置后再次 start 被拦截，重新全部通过后放行；
//  5. 编辑清单（必检项增删改/改名/改区域）后版本递增、状态全部重置为待检、门禁失效广播原因；
//     内容无变化的保存为 no-op（不增版本、不动状态）；
//  6. 非必检项的故障/待检不拦截开始；暂停后的“继续”不受门禁限制；
//  7. 投屏（注册屏幕后）收不到任何 inspection / inspection_gate 消息；重连首包携带完整巡检状态。
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = process.env.TEST_INSPECTION_PORT || 3499;
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
async function drain(inbox, ms = 250) {
  await sleep(ms);
  return inbox.splice(0);
}

const child = spawn(process.execPath, ['server/src/index.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

try {
  for (let i = 0; i < 50; i++) {
    try { await connect().then((x) => x.ws.close()); break; } catch { await sleep(100); }
  }

  console.log('1) 初始首包：空清单，门禁未启用');
  const con = await connect();
  await next(con.inbox, 'hello');
  await next(con.inbox, 'snapshot');
  const init = await next(con.inbox, 'inspection');
  ok('初始清单为空、seq=1、门禁 enabled=false 且 armed=true',
    Array.isArray(init.items) && init.items.length === 0
      && init.seq === 1
      && init.gate.enabled === false
      && init.gate.armed === true,
    JSON.stringify(init.gate));

  con.ws.send(JSON.stringify({ command: 'acquire' }));
  await next(con.inbox, 'control');
  await drain(con.inbox, 100);

  console.log('2) 无必检项时 start 不被拦截');
  con.ws.send(JSON.stringify({ command: 'reset', durationMs: 30000 }));
  await next(con.inbox, 'snapshot');
  con.ws.send(JSON.stringify({ command: 'start' }));
  const sRun = await next(con.inbox, 'snapshot');
  ok('无必检项可直接开始', sRun.phase === 'running');
  con.ws.send(JSON.stringify({ command: 'reset', durationMs: 30000 }));
  await next(con.inbox, 'snapshot');

  console.log('3) 清单校验：空名称 / 超 30 项 / 非持有者');
  con.ws.send(JSON.stringify({ command: 'inspection_set', items: [{ name: '   ', area: '', required: true }] }));
  const badName = await next(con.inbox, 'error');
  ok('空名称返回 BAD_INSPECTION', badName.code === 'BAD_INSPECTION', badName.code);

  con.ws.send(JSON.stringify({
    command: 'inspection_set',
    items: Array.from({ length: 31 }, (_, i) => ({ id: `x${i}`, name: `项${i}`, area: '', required: false })),
  }));
  const tooMany = await next(con.inbox, 'error');
  ok('31 项返回 BAD_INSPECTION', tooMany.code === 'BAD_INSPECTION', tooMany.code);

  const other = await connect();
  await next(other.inbox, 'hello');
  await next(other.inbox, 'snapshot');
  await next(other.inbox, 'inspection');
  other.ws.send(JSON.stringify({ command: 'inspection_set', items: [] }));
  const notOwner = await next(other.inbox, 'error');
  ok('非持有者 inspection_set 返回 NOT_CONTROLLER', notOwner.code === 'NOT_CONTROLLER', notOwner.code);
  other.ws.send(JSON.stringify({ command: 'inspection_check', id: 'whatever', status: 'pass' }));
  const notOwner2 = await next(other.inbox, 'error');
  ok('非持有者 inspection_check 返回 NOT_CONTROLLER', notOwner2.code === 'NOT_CONTROLLER');
  other.ws.close();

  console.log('4) 设置 2 必检 + 1 非必检：门禁启用并立即拦截 start');
  con.ws.send(JSON.stringify({
    command: 'inspection_set',
    items: [
      { id: 'k1', name: '无线麦', area: '主席台', required: true },
      { id: 'k2', name: '应急照明', area: '通道', required: true },
      { id: 'k3', name: '绿植', area: '会场', required: false },
    ],
  }));
  const set1 = await next(con.inbox, 'inspection', (m) => m.items.length === 3);
  ok('清单 seq 递增为 2', set1.seq === 2, `seq=${set1.seq}`);
  ok('全部重置为待检', set1.items.every((it) => it.status === 'pending'));
  ok('门禁启用且未放行（pending）',
    set1.gate.enabled === true && set1.gate.armed === false && set1.gate.reason === 'pending',
    JSON.stringify(set1.gate));
  // 编辑后从“未启用(armed 语义 true)”到启用未放行，属于一次翻转广播
  const gatePending = await next(con.inbox, 'inspection_gate');
  ok('广播门禁翻转：未放行 reason=pending',
    gatePending.armed === false && gatePending.reason === 'pending',
    JSON.stringify(gatePending));

  con.ws.send(JSON.stringify({ command: 'start' }));
  const blocked = await next(con.inbox, 'error');
  ok('必检未完成时 start 返回 INSPECTION_GATE', blocked.code === 'INSPECTION_GATE', blocked.code);
  const sStillIdle = (await drain(con.inbox, 200)).filter((m) => m.type === 'snapshot').pop();
  ok('被拦截后计时仍为 idle', !sStillIdle || sStillIdle.phase === 'idle');

  console.log('5) 逐项登记：故障必填备注；非必检不参与门禁');
  con.ws.send(JSON.stringify({ command: 'inspection_check', id: 'k1', status: 'fault', note: '   ' }));
  const noNote = await next(con.inbox, 'error');
  ok('故障空备注返回 BAD_INSPECTION', noNote.code === 'BAD_INSPECTION');
  con.ws.send(JSON.stringify({ command: 'inspection_check', id: 'nope', status: 'pass' }));
  const notFound = await next(con.inbox, 'error');
  ok('未知巡检项返回 NOT_FOUND', notFound.code === 'NOT_FOUND');

  con.ws.send(JSON.stringify({ command: 'inspection_check', id: 'k3', status: 'fault', note: '一盆枯萎' }));
  const optFault = await next(con.inbox, 'inspection', (m) =>
    m.items.find((it) => it.id === 'k3')?.status === 'fault');
  ok('非必检故障后门禁仍因必检待检未放行（reason=pending，非 fault）',
    optFault.gate.armed === false && optFault.gate.reason === 'pending',
    JSON.stringify(optFault.gate));

  con.ws.send(JSON.stringify({ command: 'inspection_check', id: 'k1', status: 'pass' }));
  const onePass = await next(con.inbox, 'inspection', (m) =>
    m.items.find((it) => it.id === 'k1')?.status === 'pass');
  ok('首项必检通过后仍未放行', onePass.gate.armed === false && onePass.gate.reason === 'pending');

  con.ws.send(JSON.stringify({ command: 'inspection_check', id: 'k2', status: 'pass' }));
  const armedMsg = await next(con.inbox, 'inspection', (m) => m.gate.armed === true);
  ok('全部必检通过：门禁放行，armedSeq 锚定 seq',
    armedMsg.gate.armed === true && armedMsg.armedSeq === armedMsg.seq,
    JSON.stringify({ armedSeq: armedMsg.armedSeq, seq: armedMsg.seq }));
  const gateArmed = await next(con.inbox, 'inspection_gate');
  ok('广播门禁放行', gateArmed.armed === true && gateArmed.reason === null);
  // 非必检故障状态不影响放行
  ok('放行时非必检项仍为故障（不参与门禁）',
    armedMsg.items.find((it) => it.id === 'k3').status === 'fault');

  console.log('6) 放行后开始计时；必检项改回故障立即失效广播');
  con.ws.send(JSON.stringify({ command: 'start' }));
  const sRunning = await next(con.inbox, 'snapshot');
  ok('放行后开始成功 phase=running', sRunning.phase === 'running');

  con.ws.send(JSON.stringify({ command: 'inspection_check', id: 'k2', status: 'fault', note: '中途断电' }));
  const faultMsg = await next(con.inbox, 'inspection', (m) =>
    m.items.find((it) => it.id === 'k2')?.status === 'fault');
  ok('必检项改回故障：门禁立即失效，reason=fault 且携带故障项',
    faultMsg.gate.armed === false
      && faultMsg.gate.reason === 'fault'
      && faultMsg.gate.reasonItem?.id === 'k2'
      && faultMsg.gate.reasonItem.note === '中途断电',
    JSON.stringify(faultMsg.gate));
  const gateFault = await next(con.inbox, 'inspection_gate');
  ok('广播门禁失效原因 fault（含文案）',
    gateFault.armed === false && gateFault.reason === 'fault' && /故障/.test(gateFault.reasonText),
    JSON.stringify(gateFault));

  // 运行中的计时不被强制停止；但暂停后的继续不受门禁影响，重置后重新开始被拦截
  con.ws.send(JSON.stringify({ command: 'pause' }));
  await next(con.inbox, 'snapshot', (m) => m.phase === 'paused');
  con.ws.send(JSON.stringify({ command: 'resume' }));
  const sResume = await next(con.inbox, 'snapshot', (m) => m.phase === 'running');
  ok('暂停后的继续不受门禁限制', !!sResume);
  con.ws.send(JSON.stringify({ command: 'reset', durationMs: 30000 }));
  await next(con.inbox, 'snapshot');
  con.ws.send(JSON.stringify({ command: 'start' }));
  const blocked2 = await next(con.inbox, 'error');
  ok('门禁失效后重新开始被拦截', blocked2.code === 'INSPECTION_GATE');

  console.log('7) 复检全部通过后重新放行（放行版本=当前 seq）');
  con.ws.send(JSON.stringify({ command: 'inspection_check', id: 'k2', status: 'pass' }));
  const rearmed = await next(con.inbox, 'inspection', (m) => m.gate.armed === true);
  ok('复检通过再次放行', rearmed.gate.armed === true && rearmed.armedSeq === rearmed.seq);
  await next(con.inbox, 'inspection_gate', (m) => m.armed === true);

  console.log('8) 编辑清单：状态重置、版本递增、门禁失效并广播；同内容保存为 no-op');
  // 先把非必检项恢复，制造“已放行 + 有通过状态”的起点
  con.ws.send(JSON.stringify({ command: 'inspection_check', id: 'k3', status: 'pass' }));
  await next(con.inbox, 'inspection', (m) => m.items.every((it) => it.status === 'pass'));

  // 同内容保存：no-op（不发 inspection、不增 seq）
  con.ws.send(JSON.stringify({
    command: 'inspection_set',
    items: [
      { id: 'k1', name: '无线麦', area: '主席台', required: true },
      { id: 'k2', name: '应急照明', area: '通道', required: true },
      { id: 'k3', name: '绿植', area: '会场', required: false },
    ],
  }));
  const noise = await drain(con.inbox, 300);
  ok('内容无变化的保存为 no-op（无 inspection 广播、无 gate 翻转）',
    !noise.some((m) => m.type === 'inspection' || m.type === 'inspection_gate'),
    JSON.stringify(noise.map((m) => m.type)));

  // 实际编辑：k1 改名 + k3 改为必检 + 新增一项
  con.ws.send(JSON.stringify({
    command: 'inspection_set',
    items: [
      { id: 'k1', name: '无线麦-更换电池', area: '主席台', required: true },
      { id: 'k2', name: '应急照明', area: '通道', required: true },
      { id: 'k3', name: '绿植', area: '会场', required: true },
      { id: 'k4', name: '消防通道', area: '出口', required: false },
    ],
  }));
  const edited = await next(con.inbox, 'inspection', (m) => m.seq === 3);
  ok('编辑后 seq=3 且全部状态重置为待检',
    edited.seq === 3 && edited.items.every((it) => it.status === 'pending'),
    `seq=${edited.seq}`);
  ok('编辑后门禁失效 armedSeq=null（pending）',
    edited.gate.armed === false && edited.armedSeq === null && edited.gate.reason === 'pending');
  const gateEdit = await next(con.inbox, 'inspection_gate');
  ok('编辑后广播门禁失效', gateEdit.armed === false, JSON.stringify(gateEdit));

  console.log('9) 投屏不接收巡检消息；新连接首包携带完整巡检状态');
  const screen = await connect();
  await next(screen.inbox, 'hello');
  await next(screen.inbox, 'snapshot');
  const screenInitialInsp = screen.inbox.find((m) => m.type === 'inspection');
  ok('注册前首包可收到 inspection（注册后不再收）', !!screenInitialInsp);
  screen.inbox.length = 0;
  screen.ws.send(JSON.stringify({
    command: 'screen_register',
    screenId: 's-testinspection01',
    name: '测试屏',
  }));
  await next(screen.inbox, 'screen_hello');
  await drain(screen.inbox, 200);

  // 持有者再登记一次，控制台收到而投屏收不到
  con.ws.send(JSON.stringify({ command: 'inspection_check', id: 'k1', status: 'pass' }));
  await next(con.inbox, 'inspection');
  const screenGot = await drain(screen.inbox, 300);
  ok('投屏注册后收不到 inspection / inspection_gate',
    !screenGot.some((m) => m.type === 'inspection' || m.type === 'inspection_gate'),
    JSON.stringify(screenGot.map((m) => m.type)));

  // 新控制台连接重连首包即拿到权威巡检状态（含刚登记的通过项）
  const recon = await connect();
  await next(recon.inbox, 'hello');
  await next(recon.inbox, 'snapshot');
  const reconInsp = await next(recon.inbox, 'inspection');
  ok('重连首包携带完整巡检状态（seq=3，k1 已通过）',
    reconInsp.seq === 3
      && reconInsp.items.length === 4
      && reconInsp.items.find((it) => it.id === 'k1').status === 'pass',
    JSON.stringify({ seq: reconInsp.seq, len: reconInsp.items.length }));
  screen.ws.close();
  recon.ws.close();
  con.ws.close();

  console.log(`\n巡检门禁测试：${passed} 通过，${failures.length} 失败`);
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
