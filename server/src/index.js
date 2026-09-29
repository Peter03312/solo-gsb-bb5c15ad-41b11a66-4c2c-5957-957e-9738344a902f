// 会场发言计时服务端
// 职责：
//  1. 以单调时钟（process.hrtime）维护全服务唯一的计时状态；
//  2. 每次状态变更/心跳 tick 生成单调递增版本快照并广播；
//  3. 控制台控制权为唯一租约，靠心跳续租，失联自动释放；
//  4. 提供静态文件服务（生产模式直接托管客户端构建产物）。

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { normalizeItems, projectAgenda, genItemId } from './agenda.js';
import {
  defaultInspection,
  setChecklist,
  registerResult,
  evaluateGate,
} from './inspection.js';
import {
  MODULE_KEYS,
  defaultScenes,
  normalizeSceneLibrary,
  sceneLibrarySignature,
  findScene,
} from './scenes.js';
import {
  defaultDevices,
  normalizeDevices,
  devicesSignature,
  pruneMissingItems,
  buildOccupancy,
} from './devices.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../../client/dist');

const PORT = Number(process.env.PORT || 3000);

const TICK_MS = Number(process.env.TICK_MS || 200);            // 运行中的快照广播周期
const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS || 15_000); // 控制台心跳超时时间
const HEARTBEAT_REAPER_MS = Number(process.env.HEARTBEAT_REAPER_MS || 1_000);   // 失联检查周期
const LOCK_RETRY_COOLDOWN_MS = 3_000; // 控制权被占用后再次申请的最小间隔
const HANDOVER_TTL_MS = Number(process.env.HANDOVER_TTL_MS || 60_000); // 一次性交接码有效期（60 秒）
const HANDOVER_REAPER_MS = Number(process.env.HANDOVER_REAPER_MS || 250); // 交接码到期检查周期
const WARNING_MS = 60_000;     // 进入 60 秒醒目状态的阈值
const MIN_DURATION_MS = 1_000;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

// 单调时钟：不受系统时钟回拨影响
const nowMono = () => Number(process.hrtime.bigint() / 1_000_000n);
const epochId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------------------
// 计时状态机
// phase: idle（未开始/重置后） | running | paused | finished
// 运行期间不存储“剩余时间”，而存储目标截止点（deadlineMono），
// 剩余时间始终由单调时钟现算，暂停则冻结。
// ---------------------------------------------------------------------------
const timer = {
  phase: 'idle',
  durationMs: 5 * 60_000,
  remainingMs: 5 * 60_000, // idle/paused/finished 下有效
  deadlineMono: null,      // running 下有效
};

// ---------------------------------------------------------------------------
// 议程偏差推演
// items：有序环节 { id, name, startMs（虚拟议程时钟，ms-of-day）, durationMs, fixed }
// currentId：当前环节；devInMs：进入当前环节时携带的偏差（上一固定环节后累积）
// startedMono：当前环节“开始/继续”的单调时刻；runMs：当前环节运行累计（暂停冻结）
// ---------------------------------------------------------------------------
const agenda = {
  items: defaultAgenda(),
  seq: 1,          // 议程内容版本：控制台据此判断自己的编辑是否已被权威快照接纳
  currentId: null,
  devInMs: 0,
  startedMono: null,
  runMs: 0,
};

function defaultAgenda() {
  const h = (hours, minutes = 0) => ((hours * 60 + minutes) * 60) * 1000;
  return [
    { id: genItemId(), name: '签到入场', startMs: h(9), durationMs: 15 * 60_000, fixed: true },
    { id: genItemId(), name: '开场致辞', startMs: h(9, 15), durationMs: 10 * 60_000, fixed: false },
    { id: genItemId(), name: '主题演讲', startMs: h(9, 25), durationMs: 30 * 60_000, fixed: false },
    { id: genItemId(), name: '茶歇', startMs: h(10), durationMs: 15 * 60_000, fixed: true },
    { id: genItemId(), name: '圆桌讨论', startMs: h(10, 15), durationMs: 40 * 60_000, fixed: false },
    { id: genItemId(), name: '总结闭幕', startMs: h(10, 55), durationMs: 5 * 60_000, fixed: false },
  ];
}

function currentItem() {
  return agenda.items.find((it) => it.id === agenda.currentId) ?? null;
}

// 当前环节在“虚拟议程时钟”下已经走过的毫秒数：
// 运行中随时钟增长，暂停冻结；归零后进入 finished 仍继续走时（超时计入偏差）。
function virtElapsedMs() {
  if (!agenda.currentId) return 0;
  if (timer.phase === 'running' || timer.phase === 'finished') {
    return agenda.runMs + Math.max(0, nowMono() - agenda.startedMono);
  }
  return agenda.runMs; // idle / paused：冻结
}

let version = 0;        // 单调递增版本号，永不在运行期内归零
const epoch = epochId(); // 服务进程纪元：客户端用它识别“服务端已重启”

// ---------------------------------------------------------------------------
// 现场标记（marker）
// 持有者可在当前环节记录带名称的现场事件（发言切换、设备故障……）。
// 每条标记在产生瞬间固化：单调时钟发生时刻、归属环节（id/名称/序号快照）、
// 本环节已用时长与相对计划偏差；暂停 / 重连 / 进入下一环节 / 改写议程都不改变
// 历史标记的顺序与归属。列表仅存服务端内存（与后台提示同级），随服务进程开始
// 形成“本场会话”，进程重启即清空并换新 session id。
// 标记消息只推送给控制台类连接（未注册为投屏的连接），投屏永远不显示标记。
// ---------------------------------------------------------------------------
const MAX_MARK_NAME_LEN = 30;
const MAX_MARKS = 1000;

let markerSeq = 0; // 本场会话内严格递增，只增不归零
const session = {
  id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  startedMono: nowMono(), // 会话起点的单调时刻：会话内相对时间同样不受挂钟调整影响
};
const markers = [];

// ---------------------------------------------------------------------------
// 后台提示（cue）
// 每块投屏首次打开自行生成持久屏幕 ID（localStorage），每次连接用它注册。
// 服务端内存保存每屏最新一条提示与状态，不引入任何第三方服务/持久化：
//   pending（未送达/未上屏）→ displayed（已显示）→ acknowledged（已确认）
// cueSeq 全服务单调递增：新提示覆盖旧提示；迟到的旧确认/旧提示一律按 seq 丢弃。
// 提示只对目标屏单播，非目标屏既收不到也不能代为确认。
// ---------------------------------------------------------------------------
const CUE_PRESETS = { stage: '请上场', hurry: '加快', finish: '结束' };
const MAX_CUSTOM_CUE_LEN = 30;
const MAX_SCREEN_NAME_LEN = 20;
const SCREEN_ID_RE = /^s-[0-9a-zA-Z-]{8,64}$/;

let cueSeq = 0;
const screens = new Map(); // screenId -> { id, name, online, ws, client, cue }

const defaultScreenName = (id) => `投屏 ${String(id).slice(2, 8).toUpperCase()}`;

function cleanScreenName(raw, fallback) {
  const name = String(raw ?? '').trim().slice(0, MAX_SCREEN_NAME_LEN);
  return name || fallback;
}

function publicScreen(rec) {
  return {
    id: rec.id,
    name: rec.name,
    online: rec.online,
    cue: rec.cue,
    // 该屏已确认（已替换上屏）的场景激活版本；控制台据此显示各屏切换确认状态。
    // null = 尚未确认任何场景（未连接 / 未上报）；小于当前 activeVersion 即“切换中”。
    sceneVersion: rec.sceneVersion ?? null,
  };
}

function broadcastScreens() {
  const msg = { type: 'screens', epoch, screens: [...screens.values()].map(publicScreen) };
  for (const c of clients) send(c.ws, msg);
}

// 在线立即单播；离线（ws 缺失）保持 pending，待其重连注册时补发
function deliverCue(rec) {
  if (rec.cue && rec.online && rec.ws && rec.ws.readyState === 1) {
    send(rec.ws, {
      type: 'cue',
      epoch,
      cueSeq: rec.cue.seq,
      cueType: rec.cue.type,
      text: rec.cue.text,
    });
  }
}

// 投屏注册/重连：同一屏幕 ID 以最新连接为准（旧连接收到冲突通知并不再代表该屏）
function registerScreen(client, rawId, rawName) {
  const id = String(rawId ?? '');
  if (!SCREEN_ID_RE.test(id)) {
    fail(client, 'BAD_SCREEN', '屏幕 ID 非法');
    return;
  }
  const old = screens.get(id);
  if (old && old.client && old.client !== client && old.ws && old.ws.readyState === 1) {
    old.client.screenId = null;
    send(old.ws, { type: 'screen_conflict', reason: 'replaced', screenId: id });
  }
  const fallback = defaultScreenName(id);
  const rec = old ?? {
    id, name: fallback, online: false, ws: null, client: null, cue: null, sceneVersion: null,
  };
  // 注册携带显示名（投屏本地持久化）；缺省时沿用服务端已有名称
  if (String(rawName ?? '').trim()) rec.name = cleanScreenName(rawName, fallback);
  else if (!old) rec.name = fallback;
  rec.online = true;
  rec.ws = client.ws;
  rec.client = client;
  // 新连接重新确认当前场景：旧连接上的 sceneVersion 不可代表本连接（可能已断线错过切换）。
  // 场景完整快照随注册流程单播，投屏替换并上报后，控制台确认状态恢复。
  rec.sceneVersion = null;
  client.screenId = id;
  client.devicesPending = false; // 投屏连接永不接收设备占用数据
  screens.set(id, rec);

  send(client.ws, { type: 'screen_hello', screen: publicScreen(rec) });
  // 断线重连恢复“当前场景”：立即下发当前激活场景的完整快照（投屏一次性替换）
  sendSceneSwitch(client.ws, { replayed: true });
  // 断线重连：补发该屏“未确认”的最新提示（已确认的不再出现）
  if (rec.cue && rec.cue.status !== 'acknowledged') deliverCue(rec);
  broadcastScreens();
}

function renameScreen(client, msg) {
  if (!client.screenId || client.screenId !== String(msg.screenId ?? '')) {
    fail(client, 'NOT_YOUR_SCREEN', '该连接未注册为此屏幕，不能改名');
    return;
  }
  const rec = screens.get(client.screenId);
  if (!rec) {
    fail(client, 'NOT_SCREEN', '屏幕尚未注册');
    return;
  }
  rec.name = cleanScreenName(msg.name, defaultScreenName(rec.id));
  send(client.ws, { type: 'screen_hello', screen: publicScreen(rec) });
  broadcastScreens();
}

// 投屏上报“已显示/已确认”。只接受本连接所注册屏幕、且 seq 等于其最新提示的上报；
// 迟到的旧 seq、未知屏幕、替别人上报一律忽略/拒绝，绝不改动新提示状态。
function reportCue(client, msg, nextStatus) {
  const seq = Number(msg.cueSeq);
  if (!client.screenId || client.screenId !== String(msg.screenId ?? '')) {
    fail(client, 'NOT_YOUR_SCREEN', '不能替其他屏幕上报提示状态');
    return;
  }
  const rec = screens.get(client.screenId);
  if (!rec || !rec.cue || !Number.isInteger(seq) || rec.cue.seq !== seq) return; // 迟到/未知：静默丢弃
  if (nextStatus === 'displayed' && rec.cue.status === 'pending') {
    rec.cue.status = 'displayed';
    broadcastScreens();
  } else if (nextStatus === 'acknowledged' && rec.cue.status !== 'acknowledged') {
    rec.cue.status = 'acknowledged';
    broadcastScreens();
  }
}

// 控制台发送提示：目标为屏幕 ID 数组（一块/多块，可含离线屏排队补发）或 '*'（全部在线屏）
function sendCueCommand(client, msg) {
  let ids;
  if (msg.targets === '*' || msg.targets === 'all') {
    ids = [...screens.values()].filter((r) => r.online).map((r) => r.id);
    if (ids.length === 0) {
      fail(client, 'NO_SCREEN', '当前没有在线投屏');
      return;
    }
  } else if (Array.isArray(msg.targets)) {
    if (msg.targets.length === 0) {
      fail(client, 'BAD_CUE', '未选择目标投屏');
      return;
    }
    ids = [];
    for (const t of new Set(msg.targets)) {
      const id = String(t ?? '');
      if (!screens.has(id)) {
        fail(client, 'BAD_TARGET', `目标投屏不存在：${id}`);
        return;
      }
      ids.push(id);
    }
  } else {
    fail(client, 'BAD_CUE', 'targets 必须为屏幕 ID 数组或 "*"');
    return;
  }

  const type = String(msg.cueType ?? '');
  let text;
  if (type === 'custom') {
    // 先按原始长度校验（超长直接拒绝，不静默截断），通过后再兜底截断
    const rawText = String(msg.text ?? '').trim();
    if (rawText.length === 0 || rawText.length > MAX_CUSTOM_CUE_LEN) {
      fail(client, 'BAD_CUE', `自定义提示需为 1~${MAX_CUSTOM_CUE_LEN} 字`);
      return;
    }
    text = rawText.slice(0, MAX_CUSTOM_CUE_LEN);
  } else if (CUE_PRESETS[type]) {
    text = CUE_PRESETS[type]; // 预设文案以服务端为准
  } else {
    fail(client, 'BAD_CUE', '提示类型非法');
    return;
  }

  // 同一次发送（可含多目标）共用一个严格递增的 cueSeq
  const seq = ++cueSeq;
  for (const id of ids) {
    const rec = screens.get(id);
    rec.cue = { seq, type, text, status: 'pending' }; // 新提示直接覆盖旧提示
    deliverCue(rec);
  }
  broadcastScreens();
}

// ---------------------------------------------------------------------------
// 投屏场景编排（scene）
// 持有者保存最多 8 个场景，每场景选择倒计时/议程/提示/标记摘要模块及布局参数。
// 场景库（scenes 数组 + 库版本 sceneSeq）只下发给控制台类连接用于编辑；
// 投屏只接收“当前激活场景”的完整快照（scene_switch），不感知整个场景库。
// 每次切换 activeVersion 单调递增：服务端按场景版本生成完整快照并在同一原子步骤内
// 广播给所有投屏（内嵌权威计时/议程快照 + 标记摘要），投屏收到后一次性替换并回传确认；
// 旧场景（更旧 activeVersion）的迟到消息由客户端按 epoch + 版本守卫丢弃，绝不覆盖新场景。
// 切换期间未确认提示不丢失：广播场景后在同一原子步骤内为每屏补发其未确认最新提示。
// 数据仅存服务端内存（与议程/标记/提示同级），服务进程重启即回到默认场景。
// ---------------------------------------------------------------------------
const sceneLibrary = {
  scenes: defaultScenes(),
  seq: 1,                  // 场景库内容版本：编辑保存且内容确实变化时递增
  activeId: null,          // 当前激活场景 id（启动后初始化为默认首场景）
  activeSeq: 0,            // 激活时该场景在库中的内容版本：用于提示“已激活场景有未发布修改”
};
  sceneLibrary.activeId = sceneLibrary.scenes[0].id;

let activeVersion = 0;     // 切换激活版本：每次 scene_activate 严格递增，投屏据此确认与防回滚

function activeScene() {
  return findScene(sceneLibrary.scenes, sceneLibrary.activeId) ?? sceneLibrary.scenes[0] ?? null;
}

function scenesLibraryPayload() {
  return {
    type: 'scenes',
    epoch,
    seq: sceneLibrary.seq,
    activeId: sceneLibrary.activeId,
    activeVersion,
    activeSeq: sceneLibrary.activeSeq,
    scenes: sceneLibrary.scenes,
  };
}

// 场景库只下发给控制台类连接（未注册为投屏）：投屏不感知完整场景库
function broadcastSceneLibrary() {
  const msg = scenesLibraryPayload();
  for (const c of clients) {
    if (!c.screenId) send(c.ws, msg);
  }
}

function markerSummaryForScene() {
  // 标记摘要模块只展示最近若干条（倒序/条数在客户端处理）；
  // 服务端一次性给全量普通数据快照（与 markers 消息同口径），投屏仅在本场景启用该模块时渲染。
  return markers.map(publicMarker);
}

// 构造当前激活场景的“完整快照”：场景编排 + 内嵌权威计时/议程快照 + 标记摘要。
// 投屏据此一次性替换整个画面；内嵌 snapshot 复用同一版本号，切换与计时状态严格一致。
function buildSceneSwitchPayload({ replayed = false } = {}) {
  const scene = activeScene();
  const snapshot = buildSnapshot();
  return {
    type: 'scene_switch',
    epoch,
    activeVersion,
    sceneSeq: sceneLibrary.seq,
    replayed,
    scene: scene ? {
      id: scene.id,
      name: scene.name,
      layout: scene.layout,
      modules: scene.modules,
    } : null,
    snapshot,
    markers: markerSummaryForScene(scene),
    serverTimeMono: nowMono(),
  };
}

// 单播给指定连接（投屏）；用于切换广播与断线重连补发
function sendSceneSwitch(ws, opts) {
  send(ws, buildSceneSwitchPayload(opts));
}

// 原子广播切换：JS 单线程同一消息处理内无 await，以下步骤不可被其他消息插入：
//   1) activeVersion 递增；2) 向全部在线投屏广播完整快照（同一 snapshot.version）；
//   3) 为每屏补发未确认最新提示（切换期间提示不丢失）；
//   4) 广播屏幕名单（各屏 sceneVersion 已因新激活版本整体落后，控制台显示“切换中”）；
//   5) 向控制台类连接广播场景库（新 activeVersion 供对账）。
function broadcastSceneSwitch() {
  const payload = buildSceneSwitchPayload();
  for (const c of clients) {
    if (c.screenId) send(c.ws, payload);
  }
  // 同一原子步骤内补发未确认提示：场景切换不清空任何提示状态
  for (const rec of screens.values()) {
    if (rec.online && rec.cue && rec.cue.status !== 'acknowledged') deliverCue(rec);
  }
  broadcastScreens();
  // 控制台需要 activeVersion/activeSeq 对账（不含投屏专用负载）
  for (const c of clients) {
    if (!c.screenId) send(c.ws, scenesLibraryPayload());
  }
}

// 投屏上报“已按场景版本完成一次性替换”。仅接受当前连接所注册屏幕、
// 且版本等于当前激活版本的上报；更旧版本（旧场景迟到）静默丢弃，不改确认状态。
function reportSceneDisplayed(client, msg) {
  if (!client.screenId || client.screenId !== String(msg.screenId ?? '')) {
    fail(client, 'NOT_YOUR_SCREEN', '不能替其他屏幕上报场景状态');
    return;
  }
  const rec = screens.get(client.screenId);
  if (!rec) {
    fail(client, 'NOT_SCREEN', '屏幕尚未注册');
    return;
  }
  const v = Number(msg.activeVersion);
  if (!Number.isInteger(v) || v <= 0) return;
  // 迟到的旧场景确认（切换已继续向前）：忽略，控制台只看当前激活版本的确认进度
  if (v !== activeVersion) return;
  if (rec.sceneVersion !== v) {
    rec.sceneVersion = v;
    broadcastScreens();
  }
}

// 持有者整体替换场景库：最多 8 个，至少 1 个；校验失败返回 BAD_SCENE，服务端状态不变。
// 内容无变化的保存不递增库版本；若当前激活场景被删除，自动落到首个场景，
// 但不主动切换投屏（仍需 scene_activate 才换画面）——activeId 指向新场景，
// 下次激活或重连时生效。
function saveSceneLibrary(rawScenes) {
  const result = normalizeSceneLibrary(rawScenes);
  if (result.error) return result;

  const signature = sceneLibrarySignature(result.scenes);
  const current = sceneLibrarySignature(sceneLibrary.scenes);
  if (signature === current) {
    return { ok: true, changed: false, seq: sceneLibrary.seq };
  }

  sceneLibrary.scenes = result.scenes;
  sceneLibrary.seq += 1;
  if (!findScene(result.scenes, sceneLibrary.activeId)) {
    sceneLibrary.activeId = result.scenes[0].id;
    sceneLibrary.activeSeq = 0; // 激活场景已更换内容，等待重新激活
  }
  return { ok: true, changed: true, seq: sceneLibrary.seq };
}

// 持有者切换激活场景：产生新的激活版本，服务端据此生成完整快照并原子广播。
// 重复激活同一场景也产生新版本（用于把库内最新修改重新发布到投屏）。
function activateScene(rawId) {
  const id = String(rawId ?? '');
  const scene = findScene(sceneLibrary.scenes, id);
  if (!scene) return { error: 'NOT_FOUND', message: '场景不存在（可能已被删除）' };
  sceneLibrary.activeId = scene.id;
  sceneLibrary.activeSeq = sceneLibrary.seq;
  activeVersion += 1;
  return { ok: true, activeVersion, scene };
}

// 投屏在启用“标记摘要”模块时需要随标记增删实时收到更新：
// scene_markers 携带当前激活版本，投屏仅在同 epoch、同版本且模块启用时接受，
// 旧场景/旧纪元的迟到更新一律丢弃（新场景可能已不含标记摘要模块）。
function broadcastSceneMarkers() {
  const scene = activeScene();
  if (!scene || !scene.modules.markers.enabled) return;
  const msg = {
    type: 'scene_markers',
    epoch,
    activeVersion,
    markerSeq,
    sessionId: session.id,
    markers: markers.map(publicMarker),
  };
  for (const c of clients) {
    if (c.screenId) send(c.ws, msg);
  }
}

function remainingNow() {
  if (timer.phase === 'running') {
    return Math.max(0, timer.deadlineMono - nowMono());
  }
  return timer.remainingMs;
}

// ---------------------------------------------------------------------------
// 设备巡检门禁（inspection）
// 持有者可维护最多 30 项巡检项（名称/区域/必检标记），并逐项登记“通过/故障备注”。
// 服务端仅在所有必检项均为通过、且放行所依据的清单版本未变化时允许“开始当前计时”。
// 任一必检项被改回故障、或清单被编辑保存（全部状态重置为待检）后，门禁立即失效，
// 并向所有控制台类连接广播失效原因；重新逐项巡检全部通过后才再次放行。
// 数据仅存服务端内存（与议程/标记同级），服务进程重启即回到初始空清单。
// 巡检消息与现场标记一样按角色过滤：已注册为投屏的连接不接收巡检更新。
// ---------------------------------------------------------------------------
const inspection = defaultInspection();

// ---------------------------------------------------------------------------
// 设备占用（devices）
// 持有者可维护最多 20 项共享设备（名称 / 周转缓冲分钟），并把设备绑定到若干议程环节。
// 每次议程、当前环节或计时状态变化后，复用同一帧权威 projectAgenda 推演结果计算
// 各环节的预计起止区间；同一设备上按议程顺序相邻的两次占用空当不足周转缓冲时
// 实时标出冲突双方与缺口分钟数，冲突按“最早发生”排序。固定开始环节与跨午夜
// 时间由推演结果与线性时间轴展开保证正确比较。议程整体替换/环节删除时，绑定到
// 已删除环节的记录自动清理。数据仅存服务端内存，进程重启即清空。
// 设备消息按连接角色过滤：已注册为投屏的连接（首包之后）不再接收任何设备数据。
// ---------------------------------------------------------------------------
const deviceStore = defaultDevices(); // { seq, devices: [{ id, name, turnaroundMs, itemIds }] }
// 最近一帧设备负载签名：占用区间/冲突随计时逐帧变化，仅在内容确实变化时下发，
// 避免 200ms 周期快照把无变化的设备数据反复推给控制台。
let lastDevicePayloadSignature = '';

// 门禁失效原因的人读文案（同时下发 code，客户端可自行措辞）
const GATE_REASON_TEXT = {
  fault: '存在必检项故障',
  pending: '仍有必检项待检',
  recheck: '清单变更后需重新完成全部必检',
  version_changed: '巡检版本已变化，请重新完成必检',
};

function publicInspectionItem(it) {
  return { id: it.id, name: it.name, area: it.area, required: it.required, status: it.status, note: it.note };
}

function inspectionPayload() {
  const gate = evaluateGate(inspection);
  return {
    type: 'inspection',
    epoch,
    seq: inspection.seq,
    armedSeq: inspection.armedSeq,
    gate,
    items: inspection.items.map(publicInspectionItem),
  };
}

// 已注册为投屏的连接不接收任何巡检消息，确保巡检信息只出现在控制台
function broadcastInspection() {
  const msg = inspectionPayload();
  for (const c of clients) {
    if (!c.screenId) send(c.ws, msg);
  }
}

// 门禁放行状态翻转（放行→失效 / 失效→放行）时广播原因；同态登记不打扰。
function broadcastGateChange(prev, next) {
  if (prev.armed === next.armed) return;
  const msg = {
    type: 'inspection_gate',
    epoch,
    seq: inspection.seq,
    armed: next.armed,
    gate: next,
    reason: next.armed ? null : next.reason,
    reasonText: next.armed ? null : (GATE_REASON_TEXT[next.reason] ?? '巡检门禁未放行'),
  };
  for (const c of clients) {
    if (!c.screenId) send(c.ws, msg);
  }
}

// 当前议程推演视图：projectAgenda 结果 + 当前环节实时偏差。
// 快照与现场标记在产生瞬间共用同一份权威计算，保证两边偏差口径一致。
function agendaView() {
  const cur = currentItem();
  const elapsedMs = virtElapsedMs();
  const projected = projectAgenda(agenda.items, {
    currentId: agenda.currentId,
    devInMs: agenda.devInMs,
    virtElapsedMs: elapsedMs,
    liveDurationMs: cur ? timer.durationMs : 0,
    overdue: timer.phase === 'finished',
  });
  // 当前环节实时偏差 = 预计结束点 - (实际开始点 + 当前采用的总时长)，提前为负、超时为正
  const curRow = projected.find((r) => r.id === agenda.currentId) ?? null;
  const deviationMs = curRow ? curRow.projEndMs - (curRow.projStartMs + curRow.effDurationMs) : 0;
  return { cur: curRow, elapsedMs, projected, deviationMs };
}

// 设备占用负载：设备库 + 以同一帧权威推演结果计算的占用区间/冲突。
// projectedRows 缺省时现场重算（首包/编辑设备等非计时路径），计时广播路径复用
// 快照同一帧的 projectAgenda 结果，保证“冲突所用区间”与快照上的预计起止严格一致。
function devicesPayload(projectedRows = null) {
  const rows = projectedRows ?? agendaView().projected;
  const occ = buildOccupancy(deviceStore.devices, rows);
  return {
    type: 'devices',
    epoch,
    seq: deviceStore.seq,
    devices: occ.devices,
    conflicts: occ.conflicts,
    serverTimeMono: nowMono(),
  };
}

// 已注册为投屏的连接不接收设备数据（与标记/巡检/场景库同级角色过滤）
function sendDevicesIfChanged(force = false, projectedRows = null) {
  const payload = devicesPayload(projectedRows);
  // 签名剔除服务端时刻：占用区间/冲突/库内容变化才下发，逐帧 tick 无变化时不打扰
  const sig = JSON.stringify({
    seq: payload.seq,
    devices: payload.devices,
    conflicts: payload.conflicts,
  });
  if (!force && sig === lastDevicePayloadSignature) return;
  lastDevicePayloadSignature = sig;
  for (const c of clients) {
    if (!c.screenId) send(c.ws, payload);
  }
}

// 新控制台连接（或断线重连）首次以非投屏身份说话时，单播完整设备配置与冲突结果。
// 投屏连接首条消息必为 screen_register，其待发标记在此被丢弃——投屏永不接收设备数据。
function flushPendingDevices(client) {
  if (!client.devicesPending) return;
  client.devicesPending = false;
  if (!client.screenId) send(client.ws, devicesPayload());
}

// 设备库编辑入口（仅持有者，由指令处理调用）：校验 + 自动清理已删除环节绑定。
// 返回 { ok } 或 { error, message }。
function saveDevices(rawItems) {
  const result = normalizeDevices(rawItems);
  if (result.error) return result;

  // 议程整体替换/环节删除后，绑定到不存在环节的记录自动清理（客户端亦可重发裁剪后的清单）
  const pruned = pruneMissingItems(result.devices, agenda.items);

  const incomingSig = devicesSignature(pruned.devices);
  const currentSig = devicesSignature(deviceStore.devices);
  if (incomingSig === currentSig) {
    return { ok: true, changed: false, seq: deviceStore.seq };
  }

  deviceStore.devices = pruned.devices;
  deviceStore.seq += 1;
  return { ok: true, changed: true, prunedCount: pruned.removed, seq: deviceStore.seq };
}

// warning（60 秒内）与 finished 是快照派生状态，进入临界值由 tick 驱动发播
function buildSnapshot() {
  const remainingMs = remainingNow();
  const view = agendaView();

  return {
    type: 'snapshot',
    version: ++version, // 严格递增；过期（低版本/旧纪元）消息不得回滚画面
    epoch,
    serverTimeMono: nowMono(),
    phase: timer.phase,
    durationMs: timer.durationMs,
    remainingMs,
    warning: timer.phase !== 'idle' && remainingMs <= WARNING_MS,
    finished: timer.phase === 'finished',
    locked: !!holder,
    holderId: holder ? holder.id : null,
    scene: { activeVersion }, // 当前场景激活版本：投屏随周期快照对账，重连/切换后与 scene_switch 一致
    agenda: {
      seq: agenda.seq,
      currentId: agenda.currentId,
      elapsedMs: view.elapsedMs,
      deviationMs: view.deviationMs,
      items: view.projected,
    },
  };
}

// ---------------------------------------------------------------------------
// 控制台租约：全服务同一时刻最多一个持有者
// ---------------------------------------------------------------------------
let holder = null;          // { id, ws, lastHeartbeatMono }

function broadcastSnapshot() {
  const snap = buildSnapshot();
  for (const client of clients) {
    send(client.ws, snap);
  }
  // 占用区间/冲突随议程、当前环节、计时状态逐帧推演；设备负载只下发给控制台类连接，
  // 且内容无变化（如待开始 idle 期的 tick）时不重复推送。
  sendDevicesIfChanged(false, snap.agenda.items);
}

// ---------------------------------------------------------------------------
// 控制台交接（handover）
// 持有者可生成一枚 60 秒有效的 6 位一次性交接码；生成期间持有者照常操作，
// 接收方在任一控制台连接上输入正确码后，服务端在同一原子步骤内完成：
//   旧持有者置为非持有 → 新持有者建立租约（含全新心跳计时）→ 交接码立即作废。
// 计时锚点（deadlineMono/冻结剩余）、议程、巡检、标记、提示状态均不在交接中触碰，
// 周期快照继续广播，投屏画面零中断。交接成功 / 超时 / 取消 / 持有者失联都会令码立即失效，
// 重复提交、错误码、非持有者生成、持有者自己核销均被拒绝；旧持有者的迟到心跳与命令
// 只走既有的 holder.id 校验，既不能夺回控制权也不能改写任何状态。
// 交接消息与标记/巡检同级按角色过滤：已注册为投屏的连接永不接收。
// ---------------------------------------------------------------------------
let handover = null;
// { seq, code, holderId, createdAtMono, expiresAtMono }
let handoverSeq = 0; // 交接事件全服务单调递增（含成功/过期/取消/顶替），与 epoch 共同防回滚

function handoverPayload() {
  if (!handover) {
    return { type: 'handover', epoch, seq: handoverSeq, state: 'idle' };
  }
  return {
    type: 'handover',
    epoch,
    seq: handover.seq,
    state: 'pending',
    code: handover.code,           // 仅下发给生成者单播；广播版本剔除
    holderId: handover.holderId,
    createdAtMono: handover.createdAtMono,
    expiresAtMono: handover.expiresAtMono,
    ttlMs: HANDOVER_TTL_MS,
    serverTimeMono: nowMono(),
  };
}

// 终态（success / expired / cancelled）整体替换式广播给所有控制台类连接；
// 投屏连接不收。success 时 newHolderId 供各方对账，receiverId 即新持有者。
function broadcastHandoverTerminal(state, { reason = null, holderId = null, newHolderId = null } = {}) {
  const msg = {
    type: 'handover',
    epoch,
    seq: handoverSeq,
    state,
    reason,
    holderId,
    newHolderId,
    serverTimeMono: nowMono(),
  };
  for (const c of clients) {
    if (!c.screenId) send(c.ws, msg);
  }
}

function genHandoverCode() {
  // 6 位数字码，前导零保留；极低概率撞码时重抽（同时只存在一枚有效码）
  for (;;) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    if (!handover || handover.code !== code) return code;
  }
}

// 持有者生成交接码：已有等待码则旧码立即作废旧 pending（seq 递增，客户端按新码对账）
function createHandover(client) {
  if (!holder || holder.id !== client.id) {
    fail(client, 'NOT_CONTROLLER', '仅控制权持有者可生成交接码');
    return;
  }
  handoverSeq += 1;
  const at = nowMono();
  handover = {
    seq: handoverSeq,
    code: genHandoverCode(),
    holderId: holder.id,
    createdAtMono: at,
    expiresAtMono: at + HANDOVER_TTL_MS,
  };
  // 先把带交接码的完整事件仅单播给生成者（必须在广播之前，避免其先收到无码版本）…
  send(client.ws, handoverPayload());
  // …再把无码等待态广播给所有控制台类连接（生成者收到同 seq 的无码副本，客户端幂等忽略）
  const pub = handoverPayload();
  delete pub.code;
  for (const c of clients) {
    if (!c.screenId && c !== client) send(c.ws, pub);
  }
}

// 持有者主动作废尚未核销的交接码
function cancelHandover(client) {
  if (!holder || holder.id !== client.id) {
    fail(client, 'NOT_CONTROLLER', '仅控制权持有者可取消交接');
    return;
  }
  if (!handover) return; // 无等待码：幂等静默
  handoverSeq += 1;
  const from = handover;
  handover = null;
  broadcastHandoverTerminal('cancelled', { reason: 'cancelled', holderId: from.holderId });
}

// 租约以任何方式结束（主动释放/断线/心跳超时）：等待中的交接码随之立即失效
function invalidateHandoverOnRelease(reason) {
  if (!handover) return;
  handoverSeq += 1;
  const from = handover;
  handover = null;
  broadcastHandoverTerminal('cancelled', { reason, holderId: from.holderId });
}

// 接收方核销：校验通过后原子转移唯一控制权。任何分支都不改变计时/议程/巡检/提示状态。
function redeemHandover(client, rawCode) {
  if (!handover) {
    fail(client, 'HANDOVER_NONE', '当前没有等待中的交接码');
    return;
  }
  if (client.screenId) {
    fail(client, 'NOT_CONTROLLER', '投屏连接不能接收控制台交接');
    return;
  }
  if (holder && holder.id === client.id) {
    fail(client, 'HANDOVER_SELF', '持有者不能向自己交接');
    return;
  }
  if (nowMono() >= handover.expiresAtMono) {
    // 正常由到期 reaper 广播；核销撞到期点时按错误码拒绝，终态以 reaper 广播为准
    fail(client, 'HANDOVER_EXPIRED', '交接码已过期，请让持有者重新生成');
    return;
  }
  const given = String(rawCode ?? '');
  if (!/^\d{6}$/.test(given)) {
    fail(client, 'HANDOVER_BAD_CODE', '交接码为 6 位数字');
    return;
  }
  const expectedBuf = Buffer.from(handover.code);
  const givenBuf = Buffer.from(given);
  if (givenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(givenBuf, expectedBuf)) {
    fail(client, 'HANDOVER_BAD_CODE', '交接码错误，等待中的交接码仍然有效');
    return;
  }

  // —— 以下为原子转移：JS 单线程内无 await/让出，整段不可被其他消息插入 ——
  const oldHolder = holder;
  const from = handover;
  handover = null;             // 一次性：核销瞬间码立即失效，重复提交必然落到 HANDOVER_NONE
  holder = {
    id: client.id,
    ws: client.ws,
    lastHeartbeatMono: nowMono(), // 新租约、新的心跳计时
  };

  handoverSeq += 1;
  // 旧持有者：明确失去控制权（其迟到心跳/命令此后一律按非持有者拒绝）
  if (oldHolder && oldHolder.ws && oldHolder.ws.readyState === 1) {
    send(oldHolder.ws, { type: 'control', granted: false, reason: 'handover', targetId: oldHolder.id });
  }
  // 新持有者：建立租约
  send(client.ws, { type: 'control', granted: true, clientId: client.id, targetId: client.id });
  // 双方及所有控制台连接：交接成功终态（实时显示结果）
  broadcastHandoverTerminal('success', { holderId: from.holderId, newHolderId: client.id });
  // locked 仍为 true、holderId 变化：快照立即对齐；计时等状态原样连续，投屏不中断
  broadcastSnapshot();
}

function releaseHolder(reason) {
  if (!holder) return;
  const h = holder;
  holder = null;
  invalidateHandoverOnRelease(reason);
  send(h.ws, { type: 'control', granted: false, reason, targetId: h.id });
  broadcastSnapshot(); // locked 状态变化需要立刻通知所有投屏
}

// ---------------------------------------------------------------------------
// 现场标记指令
// ---------------------------------------------------------------------------
function publicMarker(m) {
  return {
    seq: m.seq,
    name: m.name,
    wallTime: m.wallTime,           // ISO8601 挂钟时间（仅供人读/导出）
    sessionElapsedMs: m.sessionElapsedMs, // 相对本场会话起点（单调时钟）
    phase: m.phase,
    itemId: m.itemId,               // 归属环节快照：即便之后议程被改写也保持不变
    itemName: m.itemName,
    itemIndex: m.itemIndex,
    itemElapsedMs: m.itemElapsedMs, // 记录瞬间当前环节已用时长（单调时钟度量，暂停冻结）
    deviationMs: m.deviationMs,     // 记录瞬间相对计划偏差：进环节顺延量 + 本环节超时量
  };
}

function markersPayload() {
  return { type: 'markers', epoch, sessionId: session.id, markers: markers.map(publicMarker) };
}

// 投屏连接（已注册屏幕身份）不接收任何标记消息，确保投屏永不显示标记
function broadcastMarkers() {
  const msg = markersPayload();
  for (const c of clients) {
    if (!c.screenId) send(c.ws, msg);
  }
}

// 新增一条现场标记：归属与偏差在产生瞬间固化，之后不再随计时/议程变化
function addMarker(rawName) {
  const name = String(rawName ?? '').trim();
  if (!name || name.length > MAX_MARK_NAME_LEN) {
    return { error: 'BAD_MARK', message: `标记名称需为 1~${MAX_MARK_NAME_LEN} 字` };
  }
  if (markers.length >= MAX_MARKS) {
    return { error: 'MARK_LIMIT', message: `本场会话最多记录 ${MAX_MARKS} 条标记` };
  }

  const view = agendaView();
  const cur = view.cur;
  const idx = cur ? agenda.items.findIndex((x) => x.id === cur.id) : -1;
  const atMono = nowMono();
  // 相对计划偏差 = 当前环节实际开始点相对计划开始点的顺延量（固定环节恒为 0）
  //   + 本环节已经超出预计总时长的超时量（归零后继续累积，暂停冻结）。
  // 与控制台顶部展示的偏差口径一致：提前结束尚未发生时顺延为 0，运行中显示“准时”。
  const startOffset = cur ? (cur.fixed ? 0 : agenda.devInMs) : 0;
  const overdue = cur ? Math.max(0, view.elapsedMs - timer.durationMs) : 0;

  const m = {
    seq: ++markerSeq,
    name: name.slice(0, MAX_MARK_NAME_LEN),
    wallTime: new Date().toISOString(),
    sessionElapsedMs: Math.max(0, atMono - session.startedMono), // 单调时钟：不受挂钟回拨影响
    phase: timer.phase,
    itemId: cur ? cur.id : null,
    itemName: cur ? cur.name : null,
    itemIndex: idx >= 0 ? idx : null,
    itemElapsedMs: cur ? view.elapsedMs : null,
    deviationMs: startOffset + overdue,
  };
  markers.push(m);
  return { ok: true, marker: publicMarker(m) };
}

// 删除最近一条（seq 最大）；仅持有者可调用，空列表返回 NO_MARK
function deleteLatestMarker() {
  const m = markers.pop();
  if (!m) return { error: 'NO_MARK', message: '暂无现场标记可删除' };
  return { ok: true, seq: m.seq };
}

// ---------------------------------------------------------------------------
// 状态转换（全部由单调时钟定锚）
// ---------------------------------------------------------------------------
function resetTimer(durationMs = timer.durationMs) {
  timer.phase = 'idle';
  timer.durationMs = durationMs;
  timer.remainingMs = durationMs;
  timer.deadlineMono = null;
  // 议程推进一并回到“当前环节尚未开始”
  agenda.startedMono = null;
  agenda.runMs = 0;
}

function reset(durationMs = timer.durationMs) {
  resetTimer(durationMs);
  broadcastSnapshot();
}

// 开始计时（可选指定时长）：同时启动当前环节的虚拟议程时钟
function startTimer(durationMs = timer.durationMs) {
  timer.durationMs = durationMs;
  timer.remainingMs = durationMs;
  timer.deadlineMono = nowMono() + durationMs;
  timer.phase = 'running';
  agenda.startedMono = nowMono();
}

function pauseTimer() {
  const frozen = remainingNow();
  agenda.runMs += Math.max(0, nowMono() - agenda.startedMono);
  agenda.startedMono = null;
  timer.remainingMs = frozen;
  timer.deadlineMono = null;
  timer.phase = 'paused';
}

function resumeTimer() {
  timer.deadlineMono = nowMono() + timer.remainingMs;
  timer.phase = 'running';
  agenda.startedMono = nowMono();
}

function tick() {
  // 运行中：驱动剩余时间走时与归零检测
  if (timer.phase === 'running') {
    if (timer.deadlineMono - nowMono() <= 0) {
      // 归零：自动切换 finished 醒目状态；议程不前进，超时部分继续计入偏差，
      // 由控制台“结束本环节/进入下一环节”（advance）决定如何顺延。
      agenda.runMs += Math.max(0, nowMono() - agenda.startedMono);
      agenda.startedMono = nowMono();
      timer.phase = 'finished';
      timer.remainingMs = 0;
      timer.deadlineMono = null;
      broadcastSnapshot();
      return;
    }
    // warning 跨越 60 秒边界会自然在某个 tick 中体现；
    // 议程预计开始时间随之实时外推（投屏的“下一环节预计开始”平滑走时）。
    broadcastSnapshot();
    return;
  }

  // 归零后若仍有当前环节，继续周期广播：超时量逐秒累积，
  // 下一环节预计开始时间持续后移，直到控制台结束本环节。
  if (timer.phase === 'finished' && agenda.currentId) {
    broadcastSnapshot();
  }
}

// ---------------------------------------------------------------------------
// 议程指令
// ---------------------------------------------------------------------------
function setAgenda(rawItems) {
  const result = normalizeItems(rawItems);
  if (result.error) return result;
  agenda.items = result.items;
  agenda.seq += 1;
  // 整体替换议程：当前环节选择作废，计时与偏差回到未开始
  agenda.currentId = null;
  agenda.devInMs = 0;
  resetTimer(timer.durationMs);
  // 绑定到被删除环节的设备记录自动清理（保留设备本身与其余绑定）；
  // 确有清理时设备库版本递增，控制台据此对账。
  const pruned = pruneMissingItems(deviceStore.devices, agenda.items);
  if (pruned.removed > 0) {
    deviceStore.devices = pruned.devices;
    deviceStore.seq += 1;
  }
  return { ok: true, seq: agenda.seq, devicePruned: pruned.removed };
}

function setCurrent(id) {
  const it = agenda.items.find((x) => x.id === id);
  if (!it) return { error: 'NOT_FOUND', message: '议程中不存在该环节' };
  agenda.currentId = it.id;
  agenda.devInMs = 0;
  // 载入该环节时长并回到待开始，等待控制台“开始”
  resetTimer(it.durationMs);
  return { ok: true };
}

// 提前结束 / 超时结束当前环节并进入下一环节：
// 固化实际结束点带来的偏差，自动开始下一环节（固定环节同样立即开始，
// 但其预计开始时间在推演中仍锚定计划点，不随偏差移动）。
function advance() {
  if (!agenda.currentId) return { error: 'NO_CURRENT', message: '尚未设定当前环节' };
  if (timer.phase === 'idle') return { error: 'INVALID_PHASE', message: '当前环节尚未开始' };

  const idx = agenda.items.findIndex((x) => x.id === agenda.currentId);
  const cur = agenda.items[idx];
  const elapsed = virtElapsedMs();
  const projEnd = cur.fixed ? cur.startMs + elapsed : cur.startMs + agenda.devInMs + elapsed;

  if (timer.phase === 'running') pauseTimer(); // 冻结运行累计（随后立即随下一环节重新起算）
  timer.phase = 'idle';

  const next = agenda.items[idx + 1];
  if (!next) {
    // 已是最后一项：议程走到终点，保留结束时刻供快照展示
    agenda.devInMs = cur.fixed ? 0 : projEnd - (cur.startMs + cur.durationMs);
    agenda.currentId = null;
    agenda.runMs = 0;
    agenda.startedMono = null;
    return { ok: true, reachedEnd: true };
  }

  // 下一环节若为固定环节：偏差清零，其计划开始点不动；
  // 普通环节：偏差 = 本环节预计结束点 - 下一环节计划开始点（提前为负、超时为正）。
  agenda.devInMs = next.fixed ? 0 : projEnd - next.startMs;
  agenda.currentId = next.id;
  agenda.runMs = 0;
  agenda.startedMono = null;
  startTimer(next.durationMs);
  return { ok: true, currentId: next.id };
}

// ---------------------------------------------------------------------------
// 指令处理（仅持有者可执行计时指令）
// ---------------------------------------------------------------------------
function fail(client, code, message) {
  send(client.ws, { type: 'error', code, message });
}

function handleCommand(client, msg) {
  const cmd = msg.command;

  // 控制台类连接首条指令到达时，补发改占用完整配置与冲突结果（断线重连恢复）。
  // 投屏连接的首条指令必为 screen_register——不触发补发，并在注册时清掉待发标记。
  if (cmd !== 'screen_register') flushPendingDevices(client);

  const PUBLIC_COMMANDS = new Set([
    'acquire', 'heartbeat', 'release',
    'screen_register', 'screen_rename', 'cue_displayed', 'cue_ack',
    'scene_displayed',
    'handover_redeem',
  ]);
  if (!PUBLIC_COMMANDS.has(cmd)) {
    if (!holder || holder.id !== client.id) {
      fail(client, 'NOT_CONTROLLER', '当前控制台未持有控制权');
      return;
    }
  }

  switch (cmd) {
    case 'acquire': {
      if (holder && holder.id !== client.id) {
        // 唯一持有者：拒绝第二个控制台（targetId 标明单播对象，便于客户端对账）
        const lastDeny = client.lastDenyAtMono ?? 0;
        const denied = {
          type: 'control',
          granted: false,
          reason: 'locked',
          targetId: client.id,
          holderId: holder.id,
        };
        if (nowMono() - lastDeny < LOCK_RETRY_COOLDOWN_MS) {
          denied.retryAfterMs = LOCK_RETRY_COOLDOWN_MS;
        } else {
          client.lastDenyAtMono = nowMono();
        }
        send(client.ws, denied);
        return;
      }
      holder = {
        id: client.id,
        ws: client.ws,
        lastHeartbeatMono: nowMono(),
      };
      send(client.ws, { type: 'control', granted: true, clientId: client.id, targetId: client.id });
      broadcastSnapshot();
      return;
    }

    case 'heartbeat': {
      if (holder && holder.id === client.id) {
        holder.lastHeartbeatMono = nowMono();
        // 心跳回包带权威快照，便于控制台续租后立即对齐
        send(client.ws, { type: 'heartbeat_ack' });
      } else {
        fail(client, 'NOT_CONTROLLER', '心跳来自非持有控制台');
      }
      return;
    }

    case 'release': {
      if (holder && holder.id === client.id) {
        releaseHolder('released');
      }
      return;
    }

    case 'handover_create': {
      // 持有者生成 60 秒一次性交接码（生成期间仍可照常操作）
      createHandover(client);
      return;
    }

    case 'handover_cancel': {
      // 持有者主动作废旧交接码
      cancelHandover(client);
      return;
    }

    case 'handover_redeem': {
      // 接收方输入正确码：服务端原子转移控制权（公开指令，内部自行鉴权）
      redeemHandover(client, msg.code);
      return;
    }

    case 'set_duration': {
      const d = Number(msg.durationMs);
      if (!Number.isFinite(d) || d < MIN_DURATION_MS || d > MAX_DURATION_MS) {
        fail(client, 'INVALID_DURATION', `时长需在 ${MIN_DURATION_MS}~${MAX_DURATION_MS}ms 之间`);
        return;
      }
      if (timer.phase === 'running') {
        fail(client, 'INVALID_PHASE', '运行中不可修改时长，请先暂停或重置');
        return;
      }
      // idle / paused / finished 下设定新时长：画面回到待开始的完整时长；
      // 当前环节的议程虚拟时钟同样归零（尚未开始）
      timer.durationMs = d;
      timer.remainingMs = d;
      timer.phase = 'idle';
      agenda.startedMono = null;
      agenda.runMs = 0;
      broadcastSnapshot();
      return;
    }

    case 'start': {
      if (timer.phase === 'running') {
        fail(client, 'INVALID_PHASE', '计时已在运行中');
        return;
      }
      if (timer.phase === 'paused') {
        // 暂停后“继续”是同一次计时的延续，不经巡检门禁（门禁只拦截从零开始）
        resumeTimer();
      } else {
        // 待开始/已超时后重新开始：必须通过设备巡检门禁
        const gate = evaluateGate(inspection);
        if (gate.enabled && !gate.armed) {
          fail(client, 'INSPECTION_GATE', `巡检门禁未放行：${GATE_REASON_TEXT[gate.reason] ?? '必检项未全部通过'}`);
          return;
        }
        startTimer(timer.durationMs);
      }
      broadcastSnapshot();
      return;
    }

    case 'pause': {
      if (timer.phase !== 'running') {
        fail(client, 'INVALID_PHASE', '仅运行中可暂停');
        return;
      }
      pauseTimer();
      broadcastSnapshot();
      return;
    }

    case 'resume': {
      if (timer.phase !== 'paused') {
        fail(client, 'INVALID_PHASE', '仅暂停后可继续');
        return;
      }
      resumeTimer();
      broadcastSnapshot();
      return;
    }

    case 'reset': {
      const d = Number(msg.durationMs);
      // 显式给出的时长必须合法；缺省则沿用当前时长
      if (msg.durationMs !== undefined) {
        if (!Number.isFinite(d) || d < MIN_DURATION_MS || d > MAX_DURATION_MS) {
          fail(client, 'INVALID_DURATION', `时长需在 ${MIN_DURATION_MS}~${MAX_DURATION_MS}ms 之间`);
          return;
        }
        reset(d);
      } else {
        reset();
      }
      return;
    }

    case 'agenda_set': {
      // 整体替换有序议程；校验失败返回 BAD_AGENDA，服务端状态不变
      const r = setAgenda(msg.items);
      if (r.error) {
        fail(client, r.error, r.message);
        return;
      }
      broadcastSnapshot();
      return;
    }

    case 'agenda_current': {
      // 设定当前环节：载入其时长并回到待开始
      const r = setCurrent(String(msg.id ?? ''));
      if (r.error) {
        fail(client, r.error, r.message);
        return;
      }
      broadcastSnapshot();
      return;
    }

    case 'advance': {
      // 当前环节提前结束/超时结束：固化偏差并进入下一环节
      const r = advance();
      if (r.error) {
        fail(client, r.error, r.message);
        return;
      }
      broadcastSnapshot();
      return;
    }

    case 'devices_set': {
      // 整体替换共享设备库（最多 20 项：名称 / 周转缓冲分钟 / 环节绑定）；
      // 校验失败返回 BAD_DEVICES，服务端状态不变。绑定到已删除环节由服务端自动裁剪。
      const r = saveDevices(msg.devices);
      if (r.error) {
        fail(client, r.error, r.message);
        return;
      }
      if (r.changed) sendDevicesIfChanged(true);
      return;
    }

    case 'mark_add': {
      // 现场标记：记录瞬间固化归属环节与偏差（运行/暂停/超时/待开始均可记录）
      const r = addMarker(msg.name);
      if (r.error) {
        fail(client, r.error, r.message);
        return;
      }
      broadcastMarkers();
      // 当前激活场景启用“标记摘要”模块时，投屏随标记增删实时收到整体替换更新
      broadcastSceneMarkers();
      return;
    }

    case 'mark_delete_latest': {
      // 删除本场会话最近一条标记
      const r = deleteLatestMarker();
      if (r.error) {
        fail(client, r.error, r.message);
        return;
      }
      broadcastMarkers();
      broadcastSceneMarkers();
      return;
    }

    case 'inspection_set': {
      // 整体替换巡检清单：最多 30 项（名称/区域/必检）；校验失败状态不变。
      // 任何实际编辑都把全部登记重置为待检并使门禁立即失效（版本递增）。
      const prev = evaluateGate(inspection);
      const r = setChecklist(inspection, msg.items);
      if (r.error) {
        fail(client, r.error, r.message);
        return;
      }
      if (r.changed) {
        Object.assign(inspection, r.state);
        broadcastInspection();
        broadcastGateChange(prev, evaluateGate(inspection));
      }
      return;
    }

    case 'inspection_check': {
      // 逐项登记通过/故障（故障必填备注）；任一必检项改回故障立即使门禁失效并广播原因
      const prev = evaluateGate(inspection);
      const r = registerResult(inspection, msg.id, msg.status, msg.note);
      if (r.error) {
        fail(client, r.error, r.message);
        return;
      }
      Object.assign(inspection, r.state);
      broadcastInspection();
      broadcastGateChange(prev, r.gate);
      return;
    }

    case 'screen_register': {
      // 投屏注册（每次连接/重连均调用）：携带持久屏幕 ID 与显示名
      registerScreen(client, msg.screenId, msg.name);
      return;
    }

    case 'screen_rename': {
      // 投屏修改自己的显示名
      renameScreen(client, msg);
      return;
    }

    case 'cue_displayed': {
      // 目标投屏确认已上屏
      reportCue(client, msg, 'displayed');
      return;
    }

    case 'cue_ack': {
      // 目标投屏人工确认
      reportCue(client, msg, 'acknowledged');
      return;
    }

    case 'cue_send': {
      // 控制台向一块/多块/全部在线投屏发送提示（仅持有者）
      sendCueCommand(client, msg);
      return;
    }

    case 'scene_set': {
      // 整体替换场景库（最多 8 个）：仅持有者；校验失败状态不变。
      // 只更新编排内容与库版本，不直接换画面——需再 scene_activate 才重新发布。
      const r = saveSceneLibrary(msg.scenes);
      if (r.error) {
        fail(client, r.error, r.message);
        return;
      }
      if (r.changed) broadcastSceneLibrary();
      return;
    }

    case 'scene_activate': {
      // 持有者切换场景：按新场景版本生成完整快照并原子广播给所有投屏
      const r = activateScene(msg.id);
      if (r.error) {
        fail(client, r.error, r.message);
        return;
      }
      broadcastSceneSwitch();
      return;
    }

    case 'scene_displayed': {
      // 投屏完成一次性场景替换后上报确认（公开指令，内部校验屏幕身份与版本）
      reportSceneDisplayed(client, msg);
      return;
    }

    default:
      fail(client, 'UNKNOWN_COMMAND', `未知指令: ${cmd}`);
  }
}

// ---------------------------------------------------------------------------
// WebSocket 连接管理
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function makeClient(ws) {
  const client = {
    id: `c-${Math.random().toString(36).slice(2, 10)}`,
    ws,
    joinedMono: nowMono(),
    lastDenyAtMono: 0,
    screenId: null, // 若本连接注册为投屏，记录其屏幕 ID（每连接最多一块屏）
    // 设备占用数据只发给控制台类连接：首条非投屏指令到达时补发完整负载；
    // 若首条是 screen_register（投屏连接），该待发标记被丢弃，投屏永不接收设备数据。
    devicesPending: true,
  };
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      fail(client, 'BAD_MESSAGE', '消息不是合法 JSON');
      return;
    }
    try {
      handleCommand(client, msg);
    } catch (err) {
      console.error('[command]', err);
      fail(client, 'INTERNAL', '服务端处理异常');
    }
  });
  ws.on('close', () => {
    clients.delete(client);
    if (holder && holder.id === client.id) {
      releaseHolder('disconnected'); // 断线即释放唯一控制权
    }
    // 投屏断线：在线状态置否（最新提示状态保留，未确认提示待重连补发）
    if (client.screenId) {
      const rec = screens.get(client.screenId);
      if (rec && rec.client === client) {
        rec.online = false;
        rec.ws = null;
        rec.client = null;
        broadcastScreens();
      }
    }
  });
  ws.on('error', (err) => console.error('[ws error]', err.message));
  return client;
}

wss.on('connection', (ws) => {
  const client = makeClient(ws);
  clients.add(client);
  // 连接/重连首包：自报身份 + 权威快照（恢复同一剩余时间）+ 当前屏幕名单
  send(ws, { type: 'hello', clientId: client.id, epoch });
  send(ws, buildSnapshot());
  send(ws, { type: 'screens', epoch, screens: [...screens.values()].map(publicScreen) });
  // 现场标记随首包一并下发（此刻尚未注册为投屏）；投屏注册后不再收到标记更新
  send(ws, markersPayload());
  // 设备巡检门禁状态同样随首包下发（此刻尚未注册为投屏）
  send(ws, inspectionPayload());
  // 控制台交接状态：持有者重连可继续等待；接收方新打开页面也能立即看到“等待输入”。
  // 交接码只下发给当前持有者（生成者），其他连接首包同样不带码。
  const handoverHello = handoverPayload();
  if (handover && handover.holderId !== client.id) delete handoverHello.code;
  send(ws, handoverHello);
  // 投屏场景库（编排内容 + 当前激活版本）随首包下发；投屏注册后不再收到场景库更新，
  // 当前激活场景的完整快照在 screen_register 时单独单播（scene_switch）。
  send(ws, scenesLibraryPayload());
});

setInterval(tick, TICK_MS).unref();

// 失联自动释放：租约心跳超时
setInterval(() => {
  if (!holder) return;
  if (nowMono() - holder.lastHeartbeatMono > HEARTBEAT_TIMEOUT_MS) {
    console.log('[holder] 控制台心跳失联，释放控制权:', holder.id);
    releaseHolder('timeout');
  }
}, HEARTBEAT_REAPER_MS).unref();

// 交接码到期即失效：广播 expired 终态；控制权与计时状态不变，持有者可重新生成
setInterval(() => {
  if (!handover) return;
  if (nowMono() >= handover.expiresAtMono) {
    handoverSeq += 1;
    const from = handover;
    handover = null;
    broadcastHandoverTerminal('expired', { holderId: from.holderId });
  }
}, HANDOVER_REAPER_MS).unref();

// ---------------------------------------------------------------------------
// HTTP：WebSocket 升级 + 静态文件（客户端构建产物）
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA 回退
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('客户端尚未构建，请先执行 npm run build（或使用 docker compose up）。');
          return;
        }
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

server.listen(PORT, () => {
  console.log(`[venue-countdown] http://0.0.0.0:${PORT}`);
  console.log(`  控制台: http://localhost:${PORT}/console`);
  console.log(`  投  屏: http://localhost:${PORT}/display`);
});
