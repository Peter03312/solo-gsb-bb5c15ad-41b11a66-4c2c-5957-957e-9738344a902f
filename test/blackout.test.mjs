// 全场遮屏（blackout）端到端测试：启动独立服务实例（独立端口），验证：
//  1. 非持有者开关被拒；说明为空/超 30 字被拒（BAD_BLACKOUT），状态不变；
//  2. 持有者开启：blackout 广播到所有连接（含投屏），seq 单调；投屏只收遮屏不收 cue；
//  3. 遮屏期间计时/议程照常推进（start 生效、快照逐帧、snapshot.blackout 同步）；
//  4. 遮屏期间可切场景（scene_switch 照常、scene_displayed 确认生效）、可发提示：
//     投屏收不到 cue，cue_displayed/cue_ack 上报被忽略（状态停留 pending）；每屏只留最新；
//  5. 新连接/重连投屏先遵循遮屏状态，注册不补发提示；
//  6. 旧轮次迟到解除（round 不匹配/非法 round）被拒且不解除；on-on 产生新一轮；
//  7. 解除后广播 inactive 并补发“最新未确认”提示；已确认/被覆盖的旧提示不回放；
//  8. 未遮屏时解除幂等（无错误）；控制台重连首包即同步遮屏状态。
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = process.env.TEST_BLACKOUT_PORT || 3319;
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
async function next(inbox, type, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const i = inbox.findIndex((m) => m.type === type);
    if (i >= 0) return inbox.splice(i, 1)[0];
    if (Date.now() > deadline) throw new Error(`等待 ${type} 超时`);
    await sleep(20);
  }
}
async function drain(inbox, ms = 300) {
  await sleep(ms);
  return inbox.splice(0);
}
// 取满足谓词的最新一条 blackout
async function nextBlackout(inbox, pred, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (let i = inbox.length - 1; i >= 0; i--) {
      if (inbox[i].type === 'blackout' && (!pred || pred(inbox[i]))) {
        return inbox.splice(i, 1)[0];
      }
    }
    if (Date.now() > deadline) throw new Error('等待匹配 blackout 超时');
    await sleep(20);
  }
}

const child = spawn(process.execPath, ['server/src/index.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

async function registerDisplay(id, name) {
  const c = await connect();
  await next(c.inbox, 'hello');
  await next(c.inbox, 'snapshot');
  c.ws.send(JSON.stringify({ command: 'screen_register', screenId: id, name }));
  await next(c.inbox, 'screen_hello');
  return c;
}

try {
  for (let i = 0; i < 50; i++) {
    try { await connect().then((x) => x.ws.close()); break; } catch { await sleep(100); }
  }

  const ID1 = 's-aaaaaaaa-1111-4222-8333-ccccccccbb01';
  const ID2 = 's-bbbbbbbb-2222-4333-8444-ddddddddddbb02';

  console.log('1) 投屏注册并清空首包 blackout');
  const d1 = await registerDisplay(ID1, '主屏');
  const initBo1 = await next(d1.inbox, 'blackout');
  ok('投屏注册后收到当前遮屏状态（初始未遮屏 seq/round=0）',
    initBo1.active === false && initBo1.seq === 0 && initBo1.round === 0, JSON.stringify(initBo1));
  const d2 = await registerDisplay(ID2, '侧屏');
  await next(d2.inbox, 'blackout');

  const consoleConn = await connect();
  await next(consoleConn.inbox, 'hello');
  await next(consoleConn.inbox, 'snapshot');
  await next(consoleConn.inbox, 'screens');
  await next(consoleConn.inbox, 'blackout');

  console.log('2) 非持有者开启被拒（NOT_CONTROLLER）');
  const other = await connect();
  await next(other.inbox, 'hello');
  await next(other.inbox, 'snapshot');
  other.ws.send(JSON.stringify({ command: 'blackout_on', reason: '测试' }));
  const errOther = await next(other.inbox, 'error');
  ok('非持有者开启返回 NOT_CONTROLLER', errOther.code === 'NOT_CONTROLLER', errOther.code);
  other.ws.close();

  consoleConn.ws.send(JSON.stringify({ command: 'acquire' }));
  ok('持有者获得控制权', (await next(consoleConn.inbox, 'control')).granted === true);

  console.log('3) 说明非法被拒，状态不变');
  consoleConn.ws.send(JSON.stringify({ command: 'blackout_on', reason: '   ' }));
  const errEmpty = await next(consoleConn.inbox, 'error');
  ok('空白说明返回 BAD_BLACKOUT', errEmpty.code === 'BAD_BLACKOUT', errEmpty.code);
  consoleConn.ws.send(JSON.stringify({ command: 'blackout_on', reason: '字'.repeat(31) }));
  const errLong = await next(consoleConn.inbox, 'error');
  ok('31 字说明返回 BAD_BLACKOUT', errLong.code === 'BAD_BLACKOUT', errLong.code);
  await drain(consoleConn.inbox, 150);
  await drain(d1.inbox, 150);
  ok('非法开启未广播遮屏（投屏无 active 消息）',
    !d1.inbox.some((m) => m.type === 'blackout' && m.active));

  console.log('4) 合法开启：广播遮屏画面与说明，事件 seq=1、轮次 round=1');
  consoleConn.ws.send(JSON.stringify({ command: 'blackout_on', reason: '设备临时调试' }));
  const boOn1 = await nextBlackout(consoleConn.inbox, (m) => m.active === true);
  const boD1 = await nextBlackout(d1.inbox, (m) => m.active === true);
  const boD2 = await nextBlackout(d2.inbox, (m) => m.active === true);
  ok('控制台收到遮屏开启（seq=1 round=1、说明正确）',
    boOn1.seq === 1 && boOn1.round === 1 && boOn1.reason === '设备临时调试', JSON.stringify(boOn1));
  ok('两块投屏都收到遮屏开启且同 seq/说明',
    boD1.seq === 1 && boD1.round === 1 && boD1.reason === '设备临时调试'
    && boD2.seq === 1 && boD2.reason === '设备临时调试');

  console.log('5) 遮屏期间计时与议程照常推进');
  consoleConn.ws.send(JSON.stringify({ command: 'start' }));
  await sleep(300);
  const snaps = (await drain(consoleConn.inbox, 400)).filter((m) => m.type === 'snapshot');
  ok('遮屏期间 start 生效、周期快照继续广播', snaps.length >= 1 && snaps.some((m) => m.phase === 'running'));
  ok('周期快照内嵌遮屏状态（seq=1 active）',
    snaps.every((m) => m.blackout && m.blackout.active === true && m.blackout.seq === 1));

  console.log('6) 遮屏期间可切场景：投屏收 scene_switch 且确认生效');
  // 取默认首场景 id：另开一条控制台类连接读取首包场景库
  const probe = await connect();
  await next(probe.inbox, 'hello');
  await next(probe.inbox, 'snapshot');
  const scMsg = await next(probe.inbox, 'scenes');
  probe.ws.close();
  const firstSceneId = scMsg.scenes[0].id;
  consoleConn.ws.send(JSON.stringify({ command: 'scene_activate', id: firstSceneId }));
  const sw = await next(d1.inbox, 'scene_switch');
  ok('遮屏期间投屏仍收到场景切换快照', sw && sw.activeVersion >= 1, JSON.stringify(sw && sw.activeVersion));
  d1.ws.send(JSON.stringify({ command: 'scene_displayed', screenId: ID1, activeVersion: sw.activeVersion }));
  await sleep(200);
  await drain(consoleConn.inbox, 300);
  ok('遮屏期间场景确认仍被服务端接受（无错误回执）',
    !d1.inbox.some((m) => m.type === 'error'));

  console.log('7) 遮屏期间发送提示：投屏不收到、上报不推进、新提示覆盖旧提示');
  consoleConn.ws.send(JSON.stringify({ command: 'cue_send', targets: [ID1], cueType: 'stage' }));
  await sleep(150);
  ok('遮屏期间投屏收不到 cue', !d1.inbox.some((m) => m.type === 'cue'));
  // 服务端名单里该屏最新提示为 pending（未送达上屏）
  await drain(consoleConn.inbox, 200);

  // 投屏即使强行上报 displayed/ack，服务端也必须忽略
  d1.ws.send(JSON.stringify({ command: 'cue_displayed', screenId: ID1, cueSeq: 1 }));
  d1.ws.send(JSON.stringify({ command: 'cue_ack', screenId: ID1, cueSeq: 1 }));
  await sleep(200);
  // 控制台侧再发一条新提示覆盖
  consoleConn.ws.send(JSON.stringify({ command: 'cue_send', targets: [ID1], cueType: 'custom', text: '请准备' }));
  await sleep(200);
  const afterCue = (await drain(consoleConn.inbox, 300)).filter((m) => m.type === 'screens');
  const lastScreens = afterCue.length ? afterCue[afterCue.length - 1] : null;
  const rec1 = lastScreens && lastScreens.screens.find((s) => s.id === ID1);
  ok('遮屏期间提示状态停留未送达（displayed/ack 被忽略）',
    !!rec1 && rec1.cue && rec1.cue.status === 'pending', rec1 && rec1.cue && rec1.cue.status);
  ok('每屏只保留最新提示（被覆盖为自定义“请准备”，旧 stage 不回放）',
    rec1.cue.text === '请准备' && rec1.cue.seq === 2, JSON.stringify(rec1.cue));

  // ID2 也发一条，解除时应补发；先把它确认掉用于验证“已确认不回放”需要另一块，这里改为：
  consoleConn.ws.send(JSON.stringify({ command: 'cue_send', targets: [ID2], cueType: 'finish' }));
  await sleep(150);
  ok('遮屏期间侧屏同样收不到 cue', !d2.inbox.some((m) => m.type === 'cue'));

  console.log('8) 重连投屏先遵循遮屏状态，且不补发提示');
  d2.ws.close();
  await sleep(150);
  const d2b = await registerDisplay(ID2, '侧屏');
  const reBo = await nextBlackout(d2b.inbox, (m) => m.active === true);
  ok('重连投屏立即收到遮屏状态（轮次 1）', reBo.round === 1 && reBo.seq === 1 && reBo.reason === '设备临时调试', JSON.stringify(reBo));
  await sleep(150);
  ok('遮屏中重连不补发待显示提示', !d2b.inbox.some((m) => m.type === 'cue'));

  console.log('9) 新控制台连接首包即同步遮屏状态');
  const watcher = await connect();
  await next(watcher.inbox, 'hello');
  await next(watcher.inbox, 'snapshot');
  const wBo = await next(watcher.inbox, 'blackout');
  ok('旁观连接首包同步遮屏中（轮次 1）', wBo.active === true && wBo.round === 1, JSON.stringify(wBo));
  watcher.ws.close();

  console.log('10) 开启新一轮（on-on）：事件 seq=2、轮次 round=2、说明替换');
  await drain(consoleConn.inbox, 100);
  await drain(d1.inbox, 100);
  await drain(d2b.inbox, 100);
  consoleConn.ws.send(JSON.stringify({ command: 'blackout_on', reason: '嘉宾临时回避' }));
  const bo2 = await nextBlackout(consoleConn.inbox, (m) => m.active === true && m.seq === 2);
  await nextBlackout(d1.inbox, (m) => m.active === true && m.seq === 2);
  await nextBlackout(d2b.inbox, (m) => m.active === true && m.seq === 2);
  ok('新一轮遮屏 round=2 且说明更新', bo2.round === 2 && bo2.reason === '嘉宾临时回避', JSON.stringify(bo2));

  console.log('11) 旧轮次/非法 round 的解除被拒，不能关闭新一轮');
  consoleConn.ws.send(JSON.stringify({ command: 'blackout_off', round: 1 }));
  const errStale = await next(consoleConn.inbox, 'error');
  ok('旧轮次解除返回 BAD_BLACKOUT_SEQ', errStale.code === 'BAD_BLACKOUT_SEQ', errStale.code);
  consoleConn.ws.send(JSON.stringify({ command: 'blackout_off' }));
  const errNoSeq = await next(consoleConn.inbox, 'error');
  ok('缺少 round 返回 BAD_BLACKOUT', errNoSeq.code === 'BAD_BLACKOUT', errNoSeq.code);
  await sleep(150);
  ok('被拒解除未改变遮屏状态（投屏仍遮屏）',
    !d1.inbox.some((m) => m.type === 'blackout' && m.active === false));

  console.log('12) 非持有者解除被拒');
  const other2 = await connect();
  await next(other2.inbox, 'hello');
  await next(other2.inbox, 'snapshot');
  await next(other2.inbox, 'blackout');
  other2.ws.send(JSON.stringify({ command: 'blackout_off', round: 2 }));
  const errOffOther = await next(other2.inbox, 'error');
  ok('非持有者解除返回 NOT_CONTROLLER', errOffOther.code === 'NOT_CONTROLLER', errOffOther.code);
  other2.ws.close();

  console.log('13) 正确解除：广播 inactive，补发各屏最新未确认提示；已确认/覆盖的不回放');
  // 先让 ID2 的提示在解除后“已确认”场景不可得（遮屏中无法确认），因此这里额外验证：
  // ID1 最新是 seq2 自定义“请准备”（旧 stage seq1 已被覆盖，不得回放）；
  // ID2 最新是 finish。解除后两屏都应只收到各自最新一条。
  consoleConn.ws.send(JSON.stringify({ command: 'blackout_off', round: 2 }));
  const offBo = await nextBlackout(consoleConn.inbox, (m) => m.active === false && m.seq === 3);
  ok('控制台收到解除（事件 seq=3、轮次 2 inactive）', offBo.active === false && offBo.round === 2);
  await nextBlackout(d1.inbox, (m) => m.active === false && m.seq === 3);
  await nextBlackout(d2b.inbox, (m) => m.active === false && m.seq === 3);

  const cue1 = await next(d1.inbox, 'cue');
  ok('主屏解除后呈现待显示提示=最新一条“请准备”',
    cue1.text === '请准备' && cue1.cueSeq === 2, JSON.stringify(cue1));
  await sleep(100);
  const cue1Extra = d1.inbox.filter((m) => m.type === 'cue');
  ok('被覆盖的旧提示（stage seq1）不回放',
    cue1Extra.every((m) => m.cueSeq !== 1), JSON.stringify(cue1Extra.map((m) => m.cueSeq)));

  const cue2 = await next(d2b.inbox, 'cue');
  ok('侧屏解除后补发其最新提示“结束”', cue2.text === '结束', JSON.stringify(cue2));

  // 解除后上屏恢复上报，状态应可推进到 displayed
  d1.ws.send(JSON.stringify({ command: 'cue_displayed', screenId: ID1, cueSeq: cue1.cueSeq }));
  await sleep(200);
  const shown = (await drain(consoleConn.inbox, 300)).filter((m) => m.type === 'screens');
  const recShown = shown.length && shown[shown.length - 1].screens.find((s) => s.id === ID1);
  ok('解除后提示上屏上报恢复（状态=已显示）',
    recShown && recShown.cue.status === 'displayed', recShown && recShown.cue.status);

  console.log('14) 已确认提示在再次遮屏-解除后不回放');
  d1.ws.send(JSON.stringify({ command: 'cue_ack', screenId: ID1, cueSeq: cue1.cueSeq }));
  await sleep(200);
  consoleConn.ws.send(JSON.stringify({ command: 'blackout_on', reason: '第二轮遮屏' }));
  await nextBlackout(d1.inbox, (m) => m.active === true && m.seq === 4);
  await nextBlackout(d2b.inbox, (m) => m.active === true && m.seq === 4);
  const on3 = await nextBlackout(consoleConn.inbox, (m) => m.active === true && m.seq === 4);
  ok('第三轮遮屏 round=3', on3.round === 3, JSON.stringify(on3));
  consoleConn.ws.send(JSON.stringify({ command: 'blackout_off', round: on3.round }));
  await nextBlackout(d1.inbox, (m) => m.active === false && m.seq === 5);
  await nextBlackout(d2b.inbox, (m) => m.active === false && m.seq === 5);
  await sleep(200);
  ok('已确认提示解除后不回放（主屏无 cue）',
    !d1.inbox.some((m) => m.type === 'cue'));

  console.log('15) 未遮屏时再次解除幂等（无错误、无状态变化）');
  consoleConn.ws.send(JSON.stringify({ command: 'blackout_off', round: on3.round }));
  await sleep(200);
  ok('重复解除不返回错误', !consoleConn.inbox.some((m) => m.type === 'error'));

  console.log('16) 解除后投屏恢复显示场景内容（仍收到周期快照）');
  await sleep(300);
  const recvSnaps = (await drain(d1.inbox, 400)).filter((m) => m.type === 'snapshot').length;
  ok('解除后周期快照照常到达投屏', recvSnaps >= 1, `${recvSnaps}`);

  try { d1.ws.close(); } catch {}
  try { d2b.ws.close(); } catch {}
  try { consoleConn.ws.close(); } catch {}

  console.log(`\n全场遮屏测试：${passed} 通过，${failures.length} 失败`);
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
