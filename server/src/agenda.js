// 议程偏差推演（纯函数模块，便于单测）
//
// 时间模型：
//  - 计划开始时间用“虚拟议程时钟”的毫秒数表示（0 = 当天 00:00，可正可负、可超过 24h，
//    渲染时再换算成 HH:MM / 次日）。它不依赖 Date/时区，容器与浏览器结果一致。
//  - 当前环节的实际推进用单调时钟度量（见 index.js 的 virtElapsedMs）：
//    运行中按已用时长增长，暂停时冻结，归零后继续计入超时。
//  - 偏差（deviation）= 当前环节预计结束点 - 计划结束点，单位毫秒。
//    提前结束为负、超时为正；普通环节按偏差整体顺延/提前，固定环节把偏差清零。
//
// 规则：
//  - 普通环节：预计开始 = 上一环节预计结束（背靠背），偏差一路传导；
//  - 固定环节：预计开始恒等于计划开始；若传导来的预计结束点与其重叠，
//    则压缩它前面最近的一个普通环节（可能就是当前环节），并标记“时间不足”。

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_AGENDA_ITEMS = 50;
export const MIN_ITEM_DURATION_MS = 1_000;
export const MAX_ITEM_DURATION_MS = 12 * 60 * 60 * 1000;
const MAX_NAME_LEN = 40;

export function genItemId() {
  return `a-${Math.random().toString(36).slice(2, 10)}`;
}

// 校验并规范化控制台下发的完整议程。返回 { items } 或 { error, message }。
export function normalizeItems(raw) {
  if (!Array.isArray(raw)) {
    return { error: 'BAD_AGENDA', message: '议程必须是数组' };
  }
  if (raw.length > MAX_AGENDA_ITEMS) {
    return { error: 'BAD_AGENDA', message: `议程最多 ${MAX_AGENDA_ITEMS} 项` };
  }

  try {
    const seenIds = new Set();
    const items = raw.map((r, i) => {
      const name = String(r?.name ?? '').trim().slice(0, MAX_NAME_LEN) || `环节 ${i + 1}`;

      const startMs = Number(r?.startMs);
      if (!Number.isInteger(startMs) || startMs < 0 || startMs >= DAY_MS) {
        throw normalizeError('BAD_AGENDA', `第 ${i + 1} 项计划开始时间非法（需为 0~24 小时内的毫秒数）`);
      }

      const durationMs = Number(r?.durationMs);
      if (!Number.isInteger(durationMs) || durationMs < MIN_ITEM_DURATION_MS || durationMs > MAX_ITEM_DURATION_MS) {
        throw normalizeError('BAD_AGENDA', `第 ${i + 1} 项时长需在 ${MIN_ITEM_DURATION_MS}~${MAX_ITEM_DURATION_MS}ms 之间`);
      }

      let id = typeof r?.id === 'string' && /^[\w.-]{1,64}$/.test(r.id) ? r.id : genItemId();
      if (seenIds.has(id)) id = genItemId();
      seenIds.add(id);

      return { id, name, startMs, durationMs, fixed: !!r?.fixed };
    });

    return { items };
  } catch (e) {
    if (e instanceof NormalizeError) return { error: e.code, message: e.message };
    throw e;
  }
}

class NormalizeError extends Error {}
function normalizeError(code, message) {
  return Object.assign(new NormalizeError(message), { code });
}
// 供 index.js 区分校验异常类型（instanceof 在模块边界未必可靠，附带 code）
normalizeItems.Error = NormalizeError;

// 议程推演。
// 输入：
//   items       规范化后的议程数组
//   currentId   当前环节 id（可为 null）
//   devInMs     进入当前环节时携带的偏差（上一个固定环节之后累积）
//   virtElapsedMs 当前环节在虚拟议程时钟下已经走过的毫秒数
//   liveDurationMs 当前倒计时实际采用的总时长（可能被“应用时长/重置”改动）
//   overdue     当前环节是否已超时（timer.phase === 'finished'）
// 提前结束（手动 advance）/ 超时发生后偏差才固化；未超时时推演假设“按设定时长准时结束”。
// 输出每项附带：
//   status: done（当前之前）| current | future | planned（未设当前）
//   projStartMs / projEndMs：预计开始/结束（虚拟议程时钟毫秒）
//   effDurationMs：推演后的有效时长（被压缩时小于计划时长）
//   insufficient：是否被压缩而“时间不足”
export function projectAgenda(items, {
  currentId = null,
  devInMs = 0,
  virtElapsedMs = 0,
  liveDurationMs = 0,
  overdue = false,
} = {}) {
  const rows = items.map((it) => ({
    ...it,
    status: 'planned',
    projStartMs: it.startMs,
    projEndMs: it.startMs + it.durationMs,
    effDurationMs: it.durationMs,
    insufficient: false,
  }));

  const c = rows.findIndex((r) => r.id === currentId);

  // 未设定当前环节：全部按计划展示，不做任何偏差推演
  if (c === -1) return rows;

  // 已过环节：按计划落位（实际完成时刻已在“进入下一环节”时固化进偏差）
  for (let i = 0; i < c; i++) {
    rows[i].status = 'done';
  }

  const cur = rows[c];
  cur.status = 'current';
  cur.effDurationMs = liveDurationMs || cur.durationMs;
  cur.projStartMs = cur.fixed ? cur.startMs : cur.startMs + devInMs;
  // 已超时：预计结束点随实际走时继续后移；未超时（含待开始/暂停/运行中）：
  // 假设按设定总时长准时结束，预计结束点 = 实际开始点 + 总时长。
  const curSpan = overdue ? virtElapsedMs : cur.effDurationMs;
  cur.projEndMs = cur.projStartMs + curSpan;

  let chainEnd = cur.projEndMs;       // 传导链上的预计结束点
  let lastNormal = cur.fixed ? null : cur; // 待压缩候选：链上最后一个普通环节

  for (let i = c + 1; i < rows.length; i++) {
    const it = rows[i];
    it.status = 'future';

    if (it.fixed) {
      it.projStartMs = it.startMs; // 固定环节始终保留计划开始时间
      if (chainEnd > it.startMs) {
        // 前序推演与固定环节重叠：压缩其前面最近的普通环节
        if (lastNormal) {
          const planned = lastNormal.status === 'current'
            ? (liveDurationMs || lastNormal.durationMs)
            : lastNormal.durationMs;
          const eff = Math.max(0, it.startMs - lastNormal.projStartMs);
          lastNormal.projEndMs = it.startMs;
          lastNormal.effDurationMs = eff;
          lastNormal.insufficient = eff < planned;
        }
        // 没有可压缩的普通环节时，溢出部分被固定环节吸收（固定点不可移动）
      }
      it.projEndMs = it.startMs + it.durationMs;
      chainEnd = it.projEndMs;
      lastNormal = null; // 固定环节之后开始一条新的传导链
    } else {
      it.projStartMs = chainEnd; // 普通环节背靠背顺延
      it.projEndMs = chainEnd + it.durationMs;
      chainEnd = it.projEndMs;
      lastNormal = it;
    }
  }

  return rows;
}
