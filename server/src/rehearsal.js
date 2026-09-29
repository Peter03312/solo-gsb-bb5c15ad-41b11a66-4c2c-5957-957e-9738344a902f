// 结束时间预演（纯函数模块，便于单测）
//
// 预演完全在浏览器本地进行：控制台在“当前环节运行/暂停”时输入“预计再持续 N 分钟”，
// 本模块依据最新一帧权威快照重建 projectAgenda 入参，把当前环节的已用时长加上 N 分钟
// 后按“已超时（结束点随实际走时）”重新推演——因此预演与现场严格复用同一条
// projectAgenda 规则（普通环节背靠背顺延 / 📌 固定环节锚定计划点 / 固定点前最后一个
// 普通环节压缩 / 跨午夜线性值），设备周转则复用同一个 buildOccupancy。
//
// 本模块不引入任何服务端状态、不发送任何消息：服务端计时、议程与投屏均不受预演影响。

import { projectAgenda, DAY_MS } from './agenda.js';
import { buildOccupancy, linearizeRows } from './devices.js';

const EPS_MS = 0.5; // 缺口差异半毫秒容差：分钟级编辑下避免浮点噪声把“不变”误判为变化

// 单点“最近一天”线性化：给定参考点与 ms-of-day（或线性值），选整数天偏移使其最接近参考点
function nearestDay(valueMs, referenceMs) {
  if (referenceMs == null) return valueMs;
  return valueMs + Math.round((referenceMs - valueMs) / DAY_MS) * DAY_MS;
}

// 由权威快照反推 projectAgenda 所需的当前环节视图参数（不依赖单调时钟）。
// 快照中的 agenda.items 即该帧 projectAgenda 输出行：
//  - 当前普通环节 projStart = start + devIn，可直接反推进环节偏差；固定环节恒为 0；
//  - 未超时（idle/running/paused）时当前行 projEnd = projStart + 采用总时长，
//    已用时长以快照 elapsedMs 为准（运行中由调用方在两份快照之间本地插值）。
export function snapshotAgendaParams(snap) {
  const ag = snap?.agenda;
  const items = Array.isArray(ag?.items) ? ag.items : [];
  const currentId = ag?.currentId ?? null;
  const curRow = currentId ? items.find((it) => it.id === currentId) ?? null : null;
  const liveDurationMs = Number(snap?.durationMs) || curRow?.durationMs || 0;

  let devInMs = 0;
  if (curRow && !curRow.fixed) devInMs = curRow.projStartMs - curRow.startMs;

  let elapsedMs = Math.max(0, Number(ag?.elapsedMs) || 0);
  if (curRow && snap?.phase === 'finished') {
    // finished 下结束点随实际走时（projStart + elapsed），可由行精确反推
    elapsedMs = Math.max(0, curRow.projEndMs - curRow.projStartMs);
  } else {
    elapsedMs = Math.min(liveDurationMs, elapsedMs);
  }

  return {
    items,
    currentId,
    devInMs,
    elapsedMs,
    liveDurationMs,
    overdue: snap?.phase === 'finished',
    curRow,
  };
}

// 按给定的当前环节“已用毫秒”重跑权威推演。返回 projectAgenda 行（与快照同构）。
export function projectFromSnapshot(snap, elapsedMs) {
  const p = snapshotAgendaParams(snap);
  if (!p.currentId) return null;
  return projectAgenda(p.items, {
    currentId: p.currentId,
    devInMs: p.devInMs,
    virtElapsedMs: Math.max(0, elapsedMs),
    liveDurationMs: p.liveDurationMs,
    overdue: snap.phase === 'finished' || elapsedMs > p.liveDurationMs + EPS_MS,
  });
}

// 结束时间预演主入口。
// 入参：
//   snap       最新权威快照（运行中调用方按本地插值显式传 elapsedMs，保证纯函数可测）
//   extraMs    预计再持续的毫秒数（>=0）
//   elapsedMs  当前环节此刻已用毫秒；缺省取快照 elapsedMs
// 返回：
//   rows          模拟后的议程推演行（projectAgenda 输出）
//   currentId
//   curEndMs      模拟后当前环节最终结束点（线性时间轴；可能被后续固定环节截断）
//   naturalEndMs  未被固定点截断的自然结束点（projStart + 已用 + 再持续）
//   clamped       结束点是否撞上下一个固定环节而被压缩
//   absorbedMs    被固定点吸收的溢出毫秒（naturalEnd - 截断后结束点）
//   extraMs       实际采用的再持续毫秒
export function rehearseAgenda(snap, { extraMs = 0, elapsedMs = null } = {}) {
  const p = snapshotAgendaParams(snap);
  if (!p.currentId) return null;

  const baseElapsed = elapsedMs == null ? p.elapsedMs : Math.max(0, elapsedMs);
  const addMs = Math.max(0, Number(extraMs) || 0);
  const simElapsed = baseElapsed + addMs;

  // 预演语义 = 当前环节在“再持续 N 分钟后才结束”：此刻结束点晚于按设定时长的准时
  // 结束点，与归零后继续走时同一形态（overdue=true），后续顺延/压缩全部走权威规则。
  const rows = projectAgenda(p.items, {
    currentId: p.currentId,
    devInMs: p.devInMs,
    virtElapsedMs: simElapsed,
    liveDurationMs: p.liveDurationMs,
    overdue: true,
  });

  const cur = rows.find((r) => r.id === p.currentId);
  const naturalEndMs = cur.projStartMs + simElapsed;
  // cur.projEndMs 在被后续跨午夜固定环节截断时是 ms-of-day（如 00:05）。
  // 以“当前环节线性起点 + 设定总时长”（本应结束的位置）为参考点展开到最近一天，
  // 与 buildOccupancy.linearizeRows 的跨日锚定同口径；同日截断（projEnd<projStart
  // 但都在当天）时 nearestDay 为恒等，结果不变。
  const plannedEndRef = cur.projStartMs + p.liveDurationMs;
  const curEndMs = nearestDay(cur.projEndMs, plannedEndRef);
  return {
    rows,
    currentId: p.currentId,
    curEndMs,
    naturalEndMs,
    clamped: curEndMs + EPS_MS < naturalEndMs,
    absorbedMs: Math.max(0, naturalEndMs - curEndMs),
    extraMs: addMs,
  };
}

// 把预演/现场议程行（当前 + 后续）展开到线性时间轴，供面板直接显示“次日 HH:MM”。
// 规则与 buildOccupancy 内部完全一致（linearizeRows：固定点按前一落点最近一天决定
// 跨日、跨午夜被压缩行夹到不早于起点）。返回 Map(itemId -> { index, startMs, endMs })。
export function linearSchedule(rows, currentId) {
  const c = rows.findIndex((r) => r.id === currentId);
  if (c === -1) return new Map();
  return linearizeRows(rows.slice(c));
}

const conflictKey = (c) => `${c.deviceId}|${c.a.itemId}|${c.b.itemId}`;

// 规范化设备库副本：只取库字段并复制 itemIds。buildOccupancy 输出设备会复用传入的
// itemIds 数组引用，两次调用（现场/模拟）必须各持独立副本，避免结果互相污染。
function normalizeDeviceList(devices) {
  return (Array.isArray(devices) ? devices : []).map((d) => ({
    id: d.id,
    name: d.name,
    turnaroundMs: d.turnaroundMs,
    itemIds: (Array.isArray(d.itemIds) ? d.itemIds : []).slice(),
  }));
}

// 模拟后的设备周转占用，并与“现场”同一帧的占用结果逐项对账。
// 入参 devices 为设备库（服务端 devices 负载中的设备亦可，派生字段会被忽略），
// liveRows / simRows 分别为现场与模拟的 projectAgenda 行。
// 出参：
//   live/sim：buildOccupancy 结果（设备占用区间 + 冲突，冲突按最早发生排序）
//   conflicts：模拟冲突逐条标注相对现场的变化——
//       new    现场无此冲突（新增）
//       worse  现场已冲突且缺口增大（shortfall 增加）
//       better 缺口减小但仍冲突
//       same   缺口不变
//   resolved：现场冲突在模拟后消失（gap 已达到周转缓冲）
//   counts：{ live, sim, added, worse, better, same, resolved }
export function diffOccupancy(devices, liveRows, simRows) {
  const live = buildOccupancy(normalizeDeviceList(devices), liveRows);
  const sim = buildOccupancy(normalizeDeviceList(devices), simRows);

  // 每个设备的占用区间按 itemId 配对（同一设备的议程绑定顺序在两帧之间不变）
  const liveOccMap = new Map();
  for (const d of live.devices) {
    for (const o of d.occupations) liveOccMap.set(`${d.id}|${o.itemId}`, o);
  }

  for (const d of sim.devices) {
    d.occupations = d.occupations.map((o) => {
      const lo = liveOccMap.get(`${d.id}|${o.itemId}`);
      return {
        ...o,
        liveStartMs: lo ? lo.startMs : null,
        liveEndMs: lo ? lo.endMs : null,
        startDeltaMs: lo ? o.startMs - lo.startMs : null,
        endDeltaMs: lo ? o.endMs - lo.endMs : null,
      };
    });
  }

  const liveMap = new Map(live.conflicts.map((c) => [conflictKey(c), c]));
  const conflicts = sim.conflicts.map((c) => {
    const before = liveMap.get(conflictKey(c));
    let kind = 'new';
    let deltaMs = c.shortfallMs;
    if (before) {
      deltaMs = c.shortfallMs - before.shortfallMs;
      if (deltaMs > EPS_MS) kind = 'worse';
      else if (deltaMs < -EPS_MS) kind = 'better';
      else kind = 'same';
    }
    return { ...c, kind, deltaMs, liveShortfallMs: before ? before.shortfallMs : null };
  });

  const simKeys = new Set(sim.conflicts.map(conflictKey));
  const resolved = live.conflicts
    .filter((c) => !simKeys.has(conflictKey(c)))
    .map((c) => ({ ...c, kind: 'resolved' }));

  const counts = {
    live: live.conflicts.length,
    sim: sim.conflicts.length,
    added: conflicts.filter((c) => c.kind === 'new').length,
    worse: conflicts.filter((c) => c.kind === 'worse').length,
    better: conflicts.filter((c) => c.kind === 'better').length,
    same: conflicts.filter((c) => c.kind === 'same').length,
    resolved: resolved.length,
  };

  return { live, sim, conflicts, resolved, counts };
}
