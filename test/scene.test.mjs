// 投屏场景编排端到端测试：启动独立服务实例（独立端口），验证：
//  1. 首包：控制台收 scenes 场景库；投屏注册时收 scene_switch 完整快照（含内嵌 snapshot + markers）；
//  2. 持有者保存场景库（最多 8 / 至少 1 / 至少一个模块），非持有者拒绝；
//  3. 持有者切换场景：activeVersion 单调递增、原子广播给所有投屏，投屏一次性替换并上报确认，
//     控制台按屏看到 未确认→已确认；
//  4. 断线重连恢复当前场景（replay），重新上报确认；
//  5. 切换期间未确认提示不丢失（切换同原子步骤补发 cue）；
//  6. 旧场景迟到消息不覆盖新场景（更旧 activeVersion 的 scene_switch / scene_markers 客户端可丢弃）；
//  7. 启用标记摘要模块后 mark_add 下发 scene_markers；未启用不下发；
//  8. 投屏连接不接收场景库 scenes；控制台不接收 scene_switch；
//  9. scene_displayed 鉴权：替别屏上报被拒、旧版本上报静默忽略不改确认状态。
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = process.env.TEST_SCENE_PORT || 3301;
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
    // 模拟真实投屏客户端：注册屏幕身份后，收到 scene_switch（activeVersion>0）即自动
    // 一次性替换并上报 scene_displayed；scene_markers 只更新画面无需上报。
    const state = { screens: null, latestSwitch: null, screenId: null };
    ws.on('open', () => resolve({ ws, inbox, state }));
    ws.on('error', reject);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      inbox.push(m);
      if (m.type === 'screens') state.screens = m;
      if (m.type === 'scene_switch') {
        state.latestSwitch = m;
        if (state.screenId && m.activeVersion > 0 && ws.readyState === 1) {
          ws.send(JSON.stringify({
            command: 'scene_displayed', screenId: state.screenId, activeVersion: m.activeVersion,
          }));
        }
      }
    });
  });
}
async function next(inbox, type, pred, timeout = 3000) {
  if (typeof pred === 'number') { timeout = pred; pred = null; }
  const deadline = Date.now() + timeout;
  for (;;) {
    const i = inbox.findIndex((m) => m.type === type && (!pred || pred(m)));
    if (i >= 0) return inbox.splice(i, 1)[0];
    if (Date.now() > deadline) throw new Error(`等待 ${type} 超时`);
    await sleep(20);
  }
}
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
  // 首包（注册为投屏身份之前）会收到 scenes/markers/inspection 等控制台域首包，
  // 与既有 markers/inspection 行为一致；注册后不再收到场景库更新。
  c.inbox.splice(0);
  c.state.screenId = id;
  c.ws.send(JSON.stringify({ command: 'screen_register', screenId: id, name }));
  await next(c.inbox, 'screen_hello');
  const sw = await next(c.inbox, 'scene_switch');
  await nextScreens(c.inbox, (m) => m.screens.some((s) => s.id === id));
  return { c, sw };
}

try {
  for (let i = 0; i < 50; i++) {
    try { await connect().then((x) => x.ws.close()); break; } catch { await sleep(100); }
  }

  console.log('1) 首包：控制台收场景库；投屏不接收场景库');
  const con = await connect();
  await next(con.inbox, 'hello');
  await next(con.inbox, 'snapshot');
  await next(con.inbox, 'screens');
  const lib0 = await next(con.inbox, 'scenes');
  ok('控制台首包 scenes：默认 1 场景', lib0.scenes.length === 1 && typeof lib0.activeId === 'string');
  ok('初始 activeVersion=0（尚未发生切换）', lib0.activeVersion === 0, String(lib0.activeVersion));
  con.ws.send(JSON.stringify({ command: 'acquire' }));
  await next(con.inbox, 'control');

  const ID1 = 's-aaaaaaaa-1111-4222-8333-cccccccccc01';
  const ID2 = 's-bbbbbbbb-2222-4333-9444-dddddddddd02';

  console.log('2) 投屏注册：收 scene_switch 完整快照，内嵌 snapshot + markers');
  const reg1 = await registerDisplay(ID1, '主屏');
  const d1 = reg1.c;
  ok('注册即收 scene_switch', !!reg1.sw && reg1.sw.type === 'scene_switch');
  ok('完整快照含场景编排（4 模块）',
    reg1.sw.scene && ['countdown', 'agenda', 'cue', 'markers'].every((k) => k in reg1.sw.scene.modules));
  ok('内嵌权威 snapshot（phase/agenda）',
    reg1.sw.snapshot && reg1.sw.snapshot.type === 'snapshot' && reg1.sw.snapshot.agenda);
  ok('内嵌 markers 数组（标记摘要完整快照）', Array.isArray(reg1.sw.markers));
  ok('replay=true（注册/重连补发）', reg1.sw.replayed === true);
  // 注册为投屏身份之后不再接收场景库更新（后续 scene_set 广播验证）
  // 注册后自动上报 scene_displayed；此时 activeVersion=0，旧版本不满足 >0，不上报——
  // 服务端初始未切换，控制台确认态：sceneVersion=null（首屏尚无激活版本可确认）
  await drain(con.inbox, 200);
  ok('初始（activeVersion=0）投屏未上报 sceneVersion',
    findScreen(con.state.screens, ID1)?.sceneVersion == null,
    String(findScreen(con.state.screens, ID1)?.sceneVersion));

  console.log('3) 保存场景库：校验 8 个上限 / 至少 1 个 / 至少启用一个模块');
  const sceneDef = (name, mods, layout = 'stack') => ({
    name, layout,
    modules: {
      countdown: { enabled: !!mods.countdown, size: mods.countdown || 'md' },
      agenda: { enabled: !!mods.agenda, size: mods.agenda || 'md' },
      cue: { enabled: !!mods.cue, size: mods.cue || 'md' },
      markers: { enabled: !!mods.markers, size: mods.markers || 'md' },
    },
  });

  con.ws.send(JSON.stringify({ command: 'scene_set', scenes: [] }));
  ok('空场景库被拒 BAD_SCENE', (await next(con.inbox, 'error')).code === 'BAD_SCENE');

  con.ws.send(JSON.stringify({
    command: 'scene_set',
    scenes: Array.from({ length: 9 }, (_, i) => sceneDef(`s${i}`, { countdown: 'lg' })),
  }));
  ok('超过 8 个被拒 BAD_SCENE', (await next(con.inbox, 'error')).code === 'BAD_SCENE');

  con.ws.send(JSON.stringify({
    command: 'scene_set',
    scenes: [sceneDef('全禁用', {})],
  }));
  ok('无启用模块被拒 BAD_SCENE', (await next(con.inbox, 'error')).code === 'BAD_SCENE');

  // 合法：3 个场景
  const defs = [
    { id: 'sc-a', ...sceneDef('标准', { countdown: 'lg', agenda: 'md' }) },
    { id: 'sc-b', ...sceneDef('提示', { countdown: 'md', cue: 'lg' }) },
    { id: 'sc-c', ...sceneDef('摘要', { agenda: 'md', cue: 'sm', markers: 'md' }, 'grid') },
  ];
  con.ws.send(JSON.stringify({ command: 'scene_set', scenes: defs }));
  const lib1 = await next(con.inbox, 'scenes');
  ok('保存成功：3 场景、库 seq 递增', lib1.scenes.length === 3 && lib1.seq > lib0.seq, `${lib1.scenes.length}`);
  await drain(d1.inbox, 150);
  ok('保存场景库不直接换投屏画面（投屏无 scene_switch）',
    d1.inbox.filter((m) => m.type === 'scene_switch').length === 0);
  ok('投屏注册身份后收不到场景库 scenes 更新',
    d1.inbox.filter((m) => m.type === 'scenes').length === 0);

  console.log('4) 非持有者保存/切换被拒');
  const other = await connect();
  await next(other.inbox, 'hello');
  await next(other.inbox, 'snapshot');
  await next(other.inbox, 'screens');
  await next(other.inbox, 'scenes');
  other.ws.send(JSON.stringify({ command: 'scene_set', scenes: defs }));
  ok('非持有者 scene_set 返回 NOT_CONTROLLER', (await next(other.inbox, 'error')).code === 'NOT_CONTROLLER');
  other.ws.send(JSON.stringify({ command: 'scene_activate', id: 'sc-b' }));
  ok('非持有者 scene_activate 返回 NOT_CONTROLLER', (await next(other.inbox, 'error')).code === 'NOT_CONTROLLER');

  console.log('5) 切换场景：原子广播、activeVersion 单调、投屏一次性替换');
  // 先注册第二块屏
  const reg2 = await registerDisplay(ID2, '侧屏');
  const d2 = reg2.c;
  await drain(con.inbox, 150);

  con.ws.send(JSON.stringify({ command: 'scene_activate', id: 'sc-b' }));
  const sw1_d1 = await next(d1.inbox, 'scene_switch', (m) => m.activeVersion === 1);
  const sw1_d2 = await next(d2.inbox, 'scene_switch', (m) => m.activeVersion === 1);
  ok('两块投屏都收到 v1 场景切换（同一次原子广播）',
    sw1_d1.activeVersion === 1 && sw1_d2.activeVersion === 1);
  ok('场景内容=提示（cue 模块启用、countdown 启用、markers 禁用）',
    sw1_d1.scene.modules.cue.enabled === true
      && sw1_d1.scene.modules.countdown.enabled === true
      && sw1_d1.scene.modules.markers.enabled === false);
  ok('两屏收到同一内嵌快照版本（原子一致）',
    sw1_d1.snapshot.version === sw1_d2.snapshot.version);
  const libAct1 = await next(con.inbox, 'scenes', (m) => m.activeVersion === 1);
  ok('控制台收到 activeId=sc-b、v1', libAct1.activeId === 'sc-b' && libAct1.activeSeq === lib1.seq);

  // 两屏自动上报确认（可能落在同一份名单广播，故等待同一份含两屏确认的名单）
  const ack1 = await nextScreens(con.inbox,
    (m) => findScreen(m, ID1)?.sceneVersion === 1 && findScreen(m, ID2)?.sceneVersion === 1);
  ok('主屏确认后名单 sceneVersion=1', findScreen(ack1, ID1).sceneVersion === 1);
  ok('侧屏确认后名单 sceneVersion=1', findScreen(ack1, ID2).sceneVersion === 1);
  ok('两屏在线且均确认当前版本',
    [ID1, ID2].every((id) => {
      const s = findScreen(ack1, id);
      return s.online && s.sceneVersion === 1;
    }));

  console.log('6) 再次切换（v2）：旧版本投屏变“未确认”，确认后恢复；版本严格递增');
  con.ws.send(JSON.stringify({ command: 'scene_activate', id: 'sc-c' }));
  const sw2 = await next(d1.inbox, 'scene_switch', (m) => m.activeVersion === 2);
  await next(d2.inbox, 'scene_switch', (m) => m.activeVersion === 2);
  ok('v2 严格递增且场景=摘要（grid 布局、markers 启用）',
    sw2.activeVersion === 2 && sw2.scene.layout === 'grid' && sw2.scene.modules.markers.enabled === true);
  // 广播瞬间两屏 sceneVersion 落后（名单在广播后的同一原子步骤发出）；不强制捕获该帧，
  // 只验证最终两屏都确认到 v2（迟到旧确认由后续步骤验证）
  await nextScreens(con.inbox,
    (m) => [ID1, ID2].every((id) => findScreen(m, id)?.sceneVersion === 2));
  ok('两屏确认 v2', [ID1, ID2].every((id) => findScreen(con.state.screens, id).sceneVersion === 2));

  console.log('7) 切换期间未确认提示不丢失：切换原子步骤内补发 cue');
  // 发一条提示给主屏并确认上屏（不人工 ack，保持未确认）
  con.ws.send(JSON.stringify({ command: 'cue_send', targets: [ID1], cueType: 'stage' }));
  const cueV = (await next(d1.inbox, 'cue')).cueSeq;
  d1.ws.send(JSON.stringify({ command: 'cue_displayed', screenId: ID1, cueSeq: cueV }));
  await nextScreens(con.inbox, (m) => findScreen(m, ID1)?.cue?.status === 'displayed');
  // 立即切换：主屏应几乎同时收到 scene_switch(v3) 与同一条 cue 补发
  con.ws.send(JSON.stringify({ command: 'scene_activate', id: 'sc-a' }));
  const sw3 = await next(d1.inbox, 'scene_switch', (m) => m.activeVersion === 3);
  ok('切换到 v3', sw3 && sw3.scene.id === 'sc-a');
  // 补发 cue 可能已在注册流程之外：在切换广播后送达
  let recued = null;
  for (let i = 0; i < 50; i++) {
    const found = d1.inbox.find((m) => m.type === 'cue' && m.cueSeq === cueV);
    if (found) { recued = d1.inbox.splice(d1.inbox.indexOf(found), 1)[0]; break; }
    await sleep(20);
  }
  ok('切换后未确认提示按同一 cueSeq 补发（未丢失）', !!recued, '未收到补发 cue');
  d1.ws.send(JSON.stringify({ command: 'scene_displayed', screenId: ID1, activeVersion: 3 }));
  d2.ws.send(JSON.stringify({ command: 'scene_displayed', screenId: ID2, activeVersion: 3 }));
  await nextScreens(con.inbox, (m) => [ID1, ID2].every((id) => findScreen(m, id)?.sceneVersion === 3));

  console.log('8) scene_displayed 鉴权与旧版本保护');
  // 替别屏确认
  d1.ws.send(JSON.stringify({ command: 'scene_displayed', screenId: ID2, activeVersion: 3 }));
  ok('替别屏上报场景被拒 NOT_YOUR_SCREEN', (await next(d1.inbox, 'error')).code === 'NOT_YOUR_SCREEN');
  // 旧版本上报：静默忽略，不改状态（仍停留在 v3）
  d1.ws.send(JSON.stringify({ command: 'scene_displayed', screenId: ID1, activeVersion: 1 }));
  await drain(con.inbox, 250);
  ok('旧版本上报被静默忽略（sceneVersion 仍为 3）',
    findScreen(con.state.screens, ID1).sceneVersion === 3,
    String(findScreen(con.state.screens, ID1).sceneVersion));

  console.log('9) 标记摘要：启用模块时 scene_markers 下发，禁用时不下发');
  // 当前 v3=sc-a（无 markers）。记录一条：主屏不应收到 scene_markers
  con.ws.send(JSON.stringify({ command: 'mark_add', name: '发言切换' }));
  await next(con.inbox, 'markers', (m) => m.markers.length === 1);
  await drain(d1.inbox, 250);
  ok('未启用标记摘要的场景：投屏收不到 scene_markers',
    d1.inbox.filter((m) => m.type === 'scene_markers').length === 0);
  // 切到 sc-c（markers 启用）：完整快照自带 markers
  con.ws.send(JSON.stringify({ command: 'scene_activate', id: 'sc-c' }));
  const sw4 = await next(d1.inbox, 'scene_switch', (m) => m.activeVersion === 4);
  ok('切到含标记摘要场景：完整快照内已含 1 条标记', sw4.markers.length === 1 && sw4.markers[0].name === '发言切换');
  d1.ws.send(JSON.stringify({ command: 'scene_displayed', screenId: ID1, activeVersion: 4 }));
  d2.ws.send(JSON.stringify({ command: 'scene_displayed', screenId: ID2, activeVersion: 4 }));
  // 再记录：scene_markers 整体替换下发
  con.ws.send(JSON.stringify({ command: 'mark_add', name: '设备故障' }));
  const sm = await next(d1.inbox, 'scene_markers', (m) => m.markers.length === 2);
  ok('启用标记摘要后增删标记下发 scene_markers（带 activeVersion=4）',
    sm.activeVersion === 4 && sm.markers[1].name === '设备故障');

  console.log('10) 断线重连恢复当前场景并重新确认');
  const beforeScene = d1.state.latestSwitch;
  d1.ws.close();
  await nextScreens(con.inbox, (m) => findScreen(m, ID1)?.online === false);
  const d1b = await connect();
  await next(d1b.inbox, 'hello');
  await next(d1b.inbox, 'snapshot');
  d1b.state.screenId = ID1;
  d1b.ws.send(JSON.stringify({ command: 'screen_register', screenId: ID1, name: '主屏' }));
  await next(d1b.inbox, 'screen_hello');
  const replay = await next(d1b.inbox, 'scene_switch');
  ok('重连后恢复当前场景（v4，replayed）',
    replay.activeVersion === 4 && replay.replayed === true && replay.scene.id === beforeScene.scene.id);
  ok('重连完整快照含最新标记（2 条）', replay.markers.length === 2);
  // 未确认提示仍补发
  const replayCue = await next(d1b.inbox, 'cue', (m) => m.cueSeq === cueV, 2000).catch(() => null);
  ok('重连后未确认提示同样补发', !!replayCue);
  await nextScreens(con.inbox, (m) => findScreen(m, ID1)?.online === true && findScreen(m, ID1)?.sceneVersion === 4);
  ok('重连确认后在线且 sceneVersion=4', true);

  console.log('11) 旧场景迟到 scene_switch 不覆盖新场景（服务端不发旧版本，用守卫口径校验顺序）');
  // 服务端只广播单调递增版本；验证新连接注册收到的 replay 始终是“当前激活版本”
  const lateWatcher = await connect();
  await next(lateWatcher.inbox, 'hello');
  await next(lateWatcher.inbox, 'snapshot');
  lateWatcher.inbox.splice(0);
  lateWatcher.state.screenId = 's-cccccccc-3333-4444-9555-eeeeeeeeee03';
  lateWatcher.ws.send(JSON.stringify({ command: 'screen_register', screenId: 's-cccccccc-3333-4444-9555-eeeeeeeeee03', name: '新屏' }));
  await next(lateWatcher.inbox, 'screen_hello');
  const swNew = await next(lateWatcher.inbox, 'scene_switch');
  ok('任意时刻新接入投屏拿到的就是当前激活版本 v4', swNew.activeVersion === 4, String(swNew.activeVersion));
  ok('注册后场景库不发给投屏连接', lateWatcher.inbox.filter((m) => m.type === 'scenes').length === 0);

  console.log('12) 控制台不接收 scene_switch / scene_markers（角色过滤）');
  ok('控制台全程无 scene_switch', con.inbox.filter((m) => m.type === 'scene_switch').length === 0);
  ok('控制台全程无 scene_markers', con.inbox.filter((m) => m.type === 'scene_markers').length === 0);

  console.log('13) 激活不存在场景返回 NOT_FOUND');
  con.ws.send(JSON.stringify({ command: 'scene_activate', id: 'sc-nope' }));
  ok('NOT_FOUND', (await next(con.inbox, 'error')).code === 'NOT_FOUND');

  console.log('14) 无变化保存不递增库版本（无 scenes 广播）');
  con.inbox.splice(0);
  con.ws.send(JSON.stringify({ command: 'scene_set', scenes: defs }));
  await drain(con.inbox, 250);
  ok('内容无变化：无 scenes 推送', con.inbox.filter((m) => m.type === 'scenes').length === 0);

  // 清理
  for (const c of [d1b, d2, con, other, lateWatcher]) { try { c.ws.close(); } catch {} }

  console.log(`\n投屏场景编排测试：${passed} 通过，${failures.length} 失败`);
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
