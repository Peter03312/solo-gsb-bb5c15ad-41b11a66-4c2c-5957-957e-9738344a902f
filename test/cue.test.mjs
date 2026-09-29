// 后台提示（cue）集成测试：启动独立服务实例（独立端口），验证：
//  1. 投屏首次连接注册即获得持久屏幕身份与名单广播；
//  2. 控制台向单屏发送提示：单播 cue、目标屏上报 displayed/ack、名单三态流转；
//  3. 非目标屏收不到 cue、不能替别人确认；
//  4. 新提示 cueSeq 单调递增并覆盖旧提示，迟到的旧确认不改新状态；
//  5. 离线屏排队未确认提示，重连同 ID 后补发；
//  6. targets="*" 只发在线屏；自定义提示 30 字限制；非法目标/非持有者被拒；
//  7. 改名广播；同 ID 重复注册顶替旧连接。
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = process.env.TEST_CUE_PORT || 3299;
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
    const state = { screens: null }; // 持续维护最新名单，避免消息抽走后误读旧广播
    ws.on('open', () => resolve({ ws, inbox, state }));
    ws.on('error', reject);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      inbox.push(m);
      if (m.type === 'screens') state.screens = m;
    });
  });
}
async function next(inbox, type, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const i = inbox.findIndex((m) => m.type === type);
    if (i >= 0) return inbox.splice(i, 1)[0];
    if (Date.now() > deadline) throw new Error(`等待 ${type} 超时`);
    await sleep(20);
  }
}
// 取满足谓词的最新一条 screens（名单整体替换，只关心最新状态）
async function nextScreens(inbox, pred, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (let i = inbox.length - 1; i >= 0; i--) {
      if (inbox[i].type === 'screens' && (!pred || pred(inbox[i]))) {
        return inbox.splice(i, 1)[0];
      }
    }
    if (Date.now() > deadline) throw new Error('等待匹配 screens 超时');
    await sleep(20);
  }
}
async function drain(inbox, ms = 300) {
  await sleep(ms);
  return inbox.splice(0);
}
const findScreen = (msg, id) => msg.screens.find((s) => s.id === id);

const child = spawn(process.execPath, ['server/src/index.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

async function registerDisplay(id, name) {
  const c = await connect();
  await next(c.inbox, 'hello');
  await next(c.inbox, 'snapshot');
  c.ws.send(JSON.stringify({ command: 'screen_register', screenId: id, name }));
  const hello = await next(c.inbox, 'screen_hello');
  await nextScreens(c.inbox, (m) => m.screens.some((s) => s.id === id));
  return { c, hello };
}

try {
  for (let i = 0; i < 50; i++) {
    try { await connect().then((x) => x.ws.close()); break; } catch { await sleep(100); }
  }

  console.log('1) 投屏注册：首包身份、默认/自定义显示名、名单广播');
  const watcher = await connect();
  await next(watcher.inbox, 'hello');
  await next(watcher.inbox, 'snapshot');
  await next(watcher.inbox, 'screens'); // 初始空名单

  const ID1 = 's-aaaaaaaa-1111-4222-8333-cccccccccc01';
  const ID2 = 's-bbbbbbbb-2222-4333-9444-dddddddddd02';
  const reg1 = await registerDisplay(ID1, '主会场大屏');
  const d1 = reg1.c;
  ok('screen_hello 回传身份与显示名',
    reg1.hello.screen.id === ID1 && reg1.hello.screen.name === '主会场大屏' && reg1.hello.screen.online === true);

  const reg2 = await registerDisplay(ID2, '分会场大屏');
  const d2 = reg2.c;
  const wList = await nextScreens(watcher.inbox, (m) => m.screens.length === 2);
  ok('名单广播给所有连接且两块屏在线', wList.screens.every((s) => s.online) && wList.screens.length === 2);
  ok('新注册屏幕尚无提示', findScreen(wList, ID1).cue === null);

  console.log('2) 控制台获取唯一控制权');
  const consoleConn = await connect();
  await next(consoleConn.inbox, 'hello');
  await next(consoleConn.inbox, 'snapshot');
  await next(consoleConn.inbox, 'screens');
  consoleConn.ws.send(JSON.stringify({ command: 'acquire' }));
  const g = await next(consoleConn.inbox, 'control');
  ok('控制台获得控制权', g.granted === true);

  console.log('3) 发送单屏提示：目标收到、非目标收不到；未送达→已显示→已确认');
  consoleConn.ws.send(JSON.stringify({ command: 'cue_send', targets: [ID1], cueType: 'stage' }));
  const cueMsg = await next(d1.inbox, 'cue');
  ok('目标屏收到 cue 且文案=请上场、seq 为正整数',
    cueMsg.cueType === 'stage' && cueMsg.text === '请上场' && cueMsg.cueSeq >= 1,
    JSON.stringify(cueMsg));
  const cueSeq1 = cueMsg.cueSeq;
  await sleep(150);
  const leaked = d2.inbox.filter((m) => m.type === 'cue');
  ok('非目标屏收不到 cue', leaked.length === 0, `${leaked.length} 条`);

  // 模拟投屏上屏后自动上报 cue_displayed
  d1.ws.send(JSON.stringify({ command: 'cue_displayed', screenId: ID1, cueSeq: cueSeq1 }));
  const shownList = await nextScreens(consoleConn.inbox,
    (m) => findScreen(m, ID1)?.cue?.status === 'displayed');
  ok('名单显示该屏“已显示”且带 seq/文案',
    findScreen(shownList, ID1).cue.seq === cueSeq1 && findScreen(shownList, ID1).cue.text === '请上场');
  ok('非目标屏仍无 cue', findScreen(shownList, ID2).cue === null);

  d1.ws.send(JSON.stringify({ command: 'cue_ack', screenId: ID1, cueSeq: cueSeq1 }));
  const ackList = await nextScreens(consoleConn.inbox,
    (m) => findScreen(m, ID1)?.cue?.status === 'acknowledged');
  ok('确认后名单显示“已确认”', findScreen(ackList, ID1).cue.status === 'acknowledged');

  console.log('4) 非目标屏不能替别人确认（NOT_YOUR_SCREEN）');
  d2.ws.send(JSON.stringify({ command: 'cue_ack', screenId: ID1, cueSeq: cueSeq1 }));
  const errProxy = await next(d2.inbox, 'error');
  ok('替他人确认被拒', errProxy.code === 'NOT_YOUR_SCREEN', errProxy.code);
  await drain(consoleConn.inbox, 200);
  ok('被拒确认未改变状态',
    findScreen(consoleConn.state.screens, ID1).cue.status === 'acknowledged',
    findScreen(consoleConn.state.screens, ID1).cue.status);

  console.log('5) 新提示覆盖旧提示；迟到的旧确认不改变新提示状态；cueSeq 单调');
  consoleConn.ws.send(JSON.stringify({ command: 'cue_send', targets: [ID1], cueType: 'hurry' }));
  const cue2 = await next(d1.inbox, 'cue');
  ok('新提示 seq 严格递增、文案=加快',
    cue2.cueSeq > cueSeq1 && cue2.text === '加快', `${cue2.cueSeq} > ${cueSeq1}`);
  d1.ws.send(JSON.stringify({ command: 'cue_displayed', screenId: ID1, cueSeq: cue2.cueSeq }));
  await nextScreens(consoleConn.inbox, (m) => findScreen(m, ID1)?.cue?.status === 'displayed'
    && findScreen(m, ID1).cue.seq === cue2.cueSeq);

  // 迟到的旧确认（旧 cueSeq）：必须被静默丢弃，新提示保持“已显示”
  d1.ws.send(JSON.stringify({ command: 'cue_ack', screenId: ID1, cueSeq: cueSeq1 }));
  await drain(consoleConn.inbox, 250);
  ok('迟到的旧确认不改变新提示状态（仍 displayed）',
    findScreen(consoleConn.state.screens, ID1).cue.status === 'displayed',
    findScreen(consoleConn.state.screens, ID1).cue.status);

  console.log('6) 离线屏：发送时排队为未送达，同 ID 重连后补发未确认最新提示');
  // 先确认 cue2，避免补发干扰断言
  d1.ws.send(JSON.stringify({ command: 'cue_ack', screenId: ID1, cueSeq: cue2.cueSeq }));
  await nextScreens(consoleConn.inbox, (m) => findScreen(m, ID1)?.cue?.status === 'acknowledged');

  d2.ws.close();
  await nextScreens(consoleConn.inbox, (m) => findScreen(m, ID2)?.online === false);
  ok('投屏断线后标记离线', true);

  consoleConn.ws.send(JSON.stringify({ command: 'cue_send', targets: [ID2], cueType: 'finish' }));
  const offlineList = await nextScreens(consoleConn.inbox,
    (m) => findScreen(m, ID2)?.cue?.status === 'pending');
  ok('离线屏提示排队且状态=未送达',
    findScreen(offlineList, ID2).cue.status === 'pending' && findScreen(offlineList, ID2).cue.text === '结束');

  // 同 ID 重连（页面刷新/网络恢复）：注册后立即补发
  const d2b = await connect();
  await next(d2b.inbox, 'hello');
  await next(d2b.inbox, 'snapshot');
  d2b.ws.send(JSON.stringify({ command: 'screen_register', screenId: ID2, name: '分会场大屏' }));
  await next(d2b.inbox, 'screen_hello');
  const reCue = await next(d2b.inbox, 'cue');
  ok('重连后补发未确认最新提示', reCue.text === '结束', JSON.stringify(reCue));
  d2b.ws.send(JSON.stringify({ command: 'cue_displayed', screenId: ID2, cueSeq: reCue.cueSeq }));
  await nextScreens(consoleConn.inbox, (m) => findScreen(m, ID2)?.cue?.status === 'displayed');
  ok('补发提示上屏后状态回到“已显示”', true);

  console.log('7) targets="*" 只发给全部在线屏，共用同一 cueSeq');
  consoleConn.ws.send(JSON.stringify({ command: 'cue_send', targets: '*', cueType: 'custom', text: '中场休息 10 分钟' }));
  const c1 = await next(d1.inbox, 'cue');
  const c2 = await next(d2b.inbox, 'cue');
  ok('两块在线屏都收到群发提示', c1.text === '中场休息 10 分钟' && c2.text === c1.text);
  ok('同一次群发共用同一 cueSeq（严格递增）',
    c1.cueSeq === c2.cueSeq && c1.cueSeq > cue2.cueSeq, `${c1.cueSeq} vs ${c2.cueSeq}`);

  console.log('8) 自定义提示长度与非法目标/类型校验');
  const longText = '字'.repeat(31);
  consoleConn.ws.send(JSON.stringify({ command: 'cue_send', targets: [ID1], cueType: 'custom', text: longText }));
  // 31 字直接被拒（空错误先取）
  const errLong = await next(consoleConn.inbox, 'error');
  ok('超过 30 字自定义提示被拒', errLong.code === 'BAD_CUE', errLong.code);
  // 服务端不截断发送：目标屏不应收到
  await sleep(100);
  ok('被拒提示未送达', d1.inbox.filter((m) => m.type === 'cue' && m.text === longText).length === 0);

  consoleConn.ws.send(JSON.stringify({ command: 'cue_send', targets: ['s-nonexistent'], cueType: 'stage' }));
  const errTarget = await next(consoleConn.inbox, 'error');
  ok('不存在的目标屏返回 BAD_TARGET', errTarget.code === 'BAD_TARGET', errTarget.code);

  consoleConn.ws.send(JSON.stringify({ command: 'cue_send', targets: [ID1], cueType: 'bogus' }));
  const errType = await next(consoleConn.inbox, 'error');
  ok('非法提示类型被拒', errType.code === 'BAD_CUE', errType.code);

  consoleConn.ws.send(JSON.stringify({ command: 'cue_send', targets: [], cueType: 'stage' }));
  const errEmpty = await next(consoleConn.inbox, 'error');
  ok('空目标被拒', errEmpty.code === 'BAD_CUE', errEmpty.code);

  console.log('9) 非持有者不能发送提示');
  const other = await connect();
  await next(other.inbox, 'hello');
  await next(other.inbox, 'snapshot');
  await next(other.inbox, 'screens');
  other.ws.send(JSON.stringify({ command: 'cue_send', targets: '*', cueType: 'stage' }));
  const errNotCtrl = await next(other.inbox, 'error');
  ok('非持有者 cue_send 返回 NOT_CONTROLLER', errNotCtrl.code === 'NOT_CONTROLLER', errNotCtrl.code);
  other.ws.close();

  console.log('10) 修改显示名广播');
  d1.ws.send(JSON.stringify({ command: 'screen_rename', screenId: ID1, name: '主会场-主屏' }));
  const renameList = await nextScreens(consoleConn.inbox,
    (m) => findScreen(m, ID1)?.name === '主会场-主屏');
  ok('改名后名单更新', !!renameList);
  const renameHello = await next(d1.inbox, 'screen_hello');
  ok('改名回执带新名称', renameHello.screen.name === '主会场-主屏');

  console.log('11) 同一屏幕 ID 重复注册：新连接顶替旧连接（旧连接收到冲突通知）');
  const d1dup = await connect();
  await next(d1dup.inbox, 'hello');
  await next(d1dup.inbox, 'snapshot');
  d1dup.ws.send(JSON.stringify({ command: 'screen_register', screenId: ID1, name: '主会场-主屏' }));
  await next(d1dup.inbox, 'screen_hello');
  const conflict = await next(d1.inbox, 'screen_conflict', 3000);
  ok('旧连接收到 screen_conflict', conflict && conflict.screenId === ID1, JSON.stringify(conflict));
  // 旧连接再确认应被拒绝（已不代表该屏），且不改变状态
  const seqAny = c1.cueSeq;
  d1.ws.send(JSON.stringify({ command: 'cue_ack', screenId: ID1, cueSeq: seqAny }));
  const errOld = await next(d1.inbox, 'error');
  ok('被顶替的旧连接确认被拒', errOld.code === 'NOT_YOUR_SCREEN', errOld.code);
  d1dup.ws.close();

  console.log('12) 非法屏幕 ID 注册被拒');
  const bad = await connect();
  await next(bad.inbox, 'hello');
  await next(bad.inbox, 'snapshot');
  bad.ws.send(JSON.stringify({ command: 'screen_register', screenId: 'hacked-id' }));
  const errBadId = await next(bad.inbox, 'error');
  ok('非法 screenId 返回 BAD_SCREEN', errBadId.code === 'BAD_SCREEN', errBadId.code);
  bad.ws.close();

  // 清理
  try { d1.ws.close(); } catch {}
  try { d2b.ws.close(); } catch {}
  try { consoleConn.ws.close(); } catch {}
  try { watcher.ws.close(); } catch {}

  console.log(`\n后台提示测试：${passed} 通过，${failures.length} 失败`);
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
