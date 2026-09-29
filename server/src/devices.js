// 设备占用与周转冲突推演（纯函数模块，便于单测）
//
// 模型：
//  - 控制台可维护最多 MAX_DEVICES（20）项共享设备（如“无线麦”“同传箱”），
//    每项含名称与“周转缓冲”turnaroundMs（相邻两场占用之间至少留出的交接分钟数）；
//  - 每个设备绑定若干议程环节 id；环节的预计起止区间完全沿用服务端权威
//    projectAgenda 推演结果（顺延 / 固定点压缩 / 超时外推），本模块不再猜测时间；
//  - 同一设备上，按议程顺序相邻的两次占用之间的空当（gap）不足周转缓冲时即冲突，
//    缺口 shortfall = turnaround - gap（重叠时 gap 为负，shortfall 更大）；
//  - 冲突按“最早发生”（后一占用的预计开始时刻升序）排序，设备顺序次之。
//
// 跨午夜：
//  projectAgenda 的预计时刻是“虚拟议程时钟”毫秒（0 = 当天 00:00，普通环节顺延
//  可能线性越过 24:00 或落到 00:00 前；固定环节始终重置回 [0, DAY)）。本模块按
//  议程顺序把各行展开到同一条线性时间轴（在固定点按“最近一天”决定跨日），
//  于是 23:55 的占用与次日 00:05 的占用直接做毫秒减法即可正确比较。
//  约定：按议程顺序相邻的两环节在线性时间轴上相距不超过 12 小时（单项时长上限
//  12 小时，典型议程同日相邻不会有 12h 以上空档），跨午夜的负向跳变据此识别。

import { DAY_MS } from './agenda.js';

export const MAX_DEVICES = 20;
export const MAX_DEVICE_NAME_LEN = 30;
export const MAX_DEVICE_BINDINGS = 50; // 与议程最多环节数一致
export const MAX_TURNAROUND_MIN = 24 * 60;
const DEVICE_ID_RE = /^[\w.-]{1,64}$/;
const ITEM_ID_RE = /^[\w.-]{1,64}$/;

export function genDeviceId() {
  return `d-${Math.random().toString(36).slice(2, 10)}`;
}

export function defaultDevices() {
  return { seq: 1, devices: [] };
}

// 校验并规范化控制台下发的完整设备清单。返回 { devices } 或 { error, message }。
// 绑定的环节 id 只做形状校验/去重；不存在于当前议程的 id 由调用方另行裁剪
// （议程被整体替换时已删除环节的绑定自动清理）。
export function normalizeDevices(raw) {
  if (!Array.isArray(raw)) {
    return { error: 'BAD_DEVICES', message: '设备清单必须是数组' };
  }
  if (raw.length > MAX_DEVICES) {
    return { error: 'BAD_DEVICES', message: `共享设备最多 ${MAX_DEVICES} 项` };
  }

  const seenIds = new Set();
  const devices = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const name = String(r?.name ?? '').trim().slice(0, MAX_DEVICE_NAME_LEN);
    if (!name) {
      return { error: 'BAD_DEVICES', message: `第 ${i + 1} 项设备名称需为 1~${MAX_DEVICE_NAME_LEN} 字` };
    }

    // 周转缓冲以分钟编辑（允许 0.1 分钟粒度，与议程时长一致），服务端固化为整数毫秒
    const turnMin = Number(r?.turnaroundMin);
    if (!Number.isFinite(turnMin) || turnMin < 0 || turnMin > MAX_TURNAROUND_MIN) {
      return {
        error: 'BAD_DEVICES',
        message: `第 ${i + 1} 项周转缓冲需为 0~${MAX_TURNAROUND_MIN} 分钟`,
      };
    }
    const turnaroundMs = Math.max(0, Math.min(DAY_MS, Math.round(turnMin * 60_000)));

    let id = typeof r?.id === 'string' && DEVICE_ID_RE.test(r.id) ? r.id : genDeviceId();
    if (seenIds.has(id)) id = genDeviceId();
    seenIds.add(id);

    const rawBindings = Array.isArray(r?.itemIds) ? r.itemIds : [];
    const itemIds = [];
    const bound = new Set();
    for (const b of rawBindings) {
      const bid = String(b ?? '');
      if (!ITEM_ID_RE.test(bid) || bound.has(bid)) continue;
      if (itemIds.length >= MAX_DEVICE_BINDINGS) break;
      bound.add(bid);
      itemIds.push(bid);
    }

    devices.push({ id, name, turnaroundMs, itemIds });
  }
  return { devices };
}

// 设备库内容签名（id/名称/缓冲/绑定，忽略推演派生数据）：内容无变化的保存不递增 seq。
export function devicesSignature(devices) {
  return JSON.stringify(devices.map((d) => [d.id, d.name, d.turnaroundMs, d.itemIds]));
}

// 裁剪掉议程中已不存在的环节绑定（议程整体替换/删除环节后自动清理）。
// 返回 { devices, removed }；removed>0 表示有绑定被清理（调用方据此递增 seq）。
export function pruneMissingItems(devices, validItems) {
  const valid = new Set((validItems ?? []).map((it) => it.id));
  let removed = 0;
  const next = devices.map((d) => {
    const kept = d.itemIds.filter((id) => valid.has(id));
    removed += d.itemIds.length - kept.length;
    return kept.length === d.itemIds.length ? d : { ...d, itemIds: kept };
  });
  return { devices: next, removed };
}

// 按给定的议程行顺序把各行展开到线性时间轴。
// 普通环节的 projStart/projEnd 本身就是链式线性值（顺延可越过 24:00）；
// 固定环节会把时刻重置回 ms-of-day，按“最近一天”决定它相对上一行的跨日偏移。
// 注意：调用方必须只传入“需要相互比较”的相邻占用行（同一设备上真正相邻的两次
// 绑定占用）。中间隔着未绑定环节时，两场占用可能相距超过半天，若把未绑定行也纳入
// 全局展开，跨午夜归属会被中间行带偏。输出 Map: itemId -> { index, startMs, endMs }。
export function linearizeRows(rows) {
  // 第一遍：逐行求线性起点（固定点按前一行线性终点的“最近一天”决定跨日）。
  // 前一行若也是被跨午夜压缩的负跨度行，其递推锚点退化为“起点 + 计划时长”
  // （自然结束位置），对固定点的最近一天判定已足够（相邻环节相距不超过 12 小时）。
  const starts = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (i === 0) {
      starts.push(rows[i].projStartMs);
      continue;
    }
    const prev = rows[i - 1];
    const prevStart = starts[i - 1];
    const rawPrevEnd = prevStart + (prev.projEndMs - prev.projStartMs);
    const anchor = rawPrevEnd >= prevStart ? rawPrevEnd : prevStart + prev.durationMs;
    const offsetDays = Math.round((anchor - rows[i].projStartMs) / DAY_MS);
    starts.push(rows[i].projStartMs + offsetDays * DAY_MS);
  }

  // 第二遍：线性终点。固定点压缩到跨午夜时原始跨度为负（projEnd 是下一天的
  // ms-of-day，落在本行起点之前）：该行真实终点即截断它的下一个固定环节起点，
  // 对相邻占用而言它就等于下一行的线性起点（两者同一固定点），直接采用使 gap=0。
  const map = new Map();
  rows.forEach((r, index) => {
    const startMs = starts[index];
    let endMs = startMs + (r.projEndMs - r.projStartMs);
    if (endMs < startMs) {
      endMs = index + 1 < rows.length ? starts[index + 1] : startMs;
    }
    map.set(r.id, { index, startMs, endMs });
  });
  return map;
}

function occupationOf(row, linear) {
  return {
    itemId: row.id,
    itemName: row.name,
    itemIndex: linear.index,
    status: row.status,
    fixed: !!row.fixed,
    insufficient: !!row.insufficient,
    startMs: linear.startMs, // 线性时间轴毫秒（formatClock 可显示“次日”）
    endMs: linear.endMs,
  };
}

// 依据权威推演结果计算各设备占用区间与周转冲突（纯函数）。
// 入参 devices：规范化后的设备库；rows：projectAgenda 输出行（议程顺序）。
// 出参：
//   devices[]：每项附 occupations（仅保留当前议程中存在的绑定，按议程序）
//              与 conflictCount；每个 occupation 携带与上一占用的 gapMs /
//              shortfallMs / conflict（首个占用为 null/false）；
//   conflicts[]：{ deviceId, deviceName, turnaroundMs, a, b, gapMs, shortfallMs }
//              按 b.startMs 升序（最早冲突优先）、设备顺序次之。
export function buildOccupancy(devices, rows) {
  const rowById = new Map((rows ?? []).map((r) => [r.id, r]));

  const outDevices = [];
  const conflicts = [];

  devices.forEach((d, deviceIndex) => {
    // 只取当前议程中仍存在的绑定行，按议程顺序排列；跨日展开仅在“真正相邻的两次
    // 占用”之间进行，不被中间未绑定环节（可能相隔大半天）带偏。
    const boundRows = d.itemIds
      .map((id) => rowById.get(id))
      .filter(Boolean);
    const linear = linearizeRows(boundRows);

    const occupations = [];
    let prev = null;
    for (const row of boundRows) {
      const lin = linear.get(row.id);

      let gapMs = null;
      let shortfallMs = null;
      let conflict = false;
      if (prev) {
        gapMs = lin.startMs - prev.endMs;
        shortfallMs = d.turnaroundMs - gapMs;
        conflict = shortfallMs > 0;
        if (conflict) {
          prev.conflict = true; // 相邻双方都标红
          conflicts.push({
            deviceId: d.id,
            deviceName: d.name,
            turnaroundMs: d.turnaroundMs,
            a: { itemId: prev.itemId, itemName: prev.itemName, itemIndex: prev.itemIndex, endMs: prev.endMs },
            b: { itemId: row.id, itemName: row.name, itemIndex: lin.index, startMs: lin.startMs },
            gapMs,
            shortfallMs,
            deviceIndex,
          });
        }
      }

      const occ = {
        ...occupationOf(row, lin),
        gapMs,
        shortfallMs,
        conflict,
      };
      occupations.push(occ);
      prev = occ;
    }

    // 回填每个设备的冲突数（相邻双方都计入）
    const conflictCount = occupations.reduce((n, o) => n + (o.conflict ? 1 : 0), 0);
    outDevices.push({
      id: d.id,
      name: d.name,
      turnaroundMs: d.turnaroundMs,
      // 重新生成绑定 id 数组，绝不复用入参 d.itemIds 引用（保持纯函数：同一设备库
      // 被连续多次推演调用时，输出之间不得通过共享数组互相影响）
      itemIds: occupations.map((o) => o.itemId),
      occupations,
      conflictCount,
    });
  });

  // 最早冲突排序：以后一占用预计开始时刻升序；同时刻保持设备顺序稳定
  conflicts.sort((x, y) => (x.b.startMs - y.b.startMs) || (x.deviceIndex - y.deviceIndex));
  for (const c of conflicts) delete c.deviceIndex;
  return { devices: outDevices, conflicts };
}
