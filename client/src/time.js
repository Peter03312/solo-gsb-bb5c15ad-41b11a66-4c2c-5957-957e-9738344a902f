// 时间工具：客户端在两份服务端快照之间用本地单调时钟插值，
// 渲染平滑（100ms 重绘），权威时间始终以服务端快照为准。

export function monoNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

const DAY_MS = 24 * 60 * 60 * 1000;

// 快照剩余时间（ms）。running 时按快照内的服务端单调时钟外推，
// 并夹取到 [0, durationMs]，避免越界。
export function liveRemaining(snap) {
  if (!snap) return 0;
  if (snap.phase !== 'running') return snap.remainingMs;
  const elapsed = monoNow() - snap.receivedAtMono;
  return Math.max(0, Math.min(snap.durationMs, snap.remainingMs - elapsed));
}

function pad2(n) {
  return String(Math.floor(n)).padStart(2, '0');
}

// MM:SS；60 秒内运行时附带一位十分之一秒，增强紧迫感
export function formatTime(ms, { tenths = false } = {}) {
  const clamped = Math.max(0, ms);
  const totalSeconds = Math.floor(clamped / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const base = `${pad2(minutes)}:${pad2(seconds)}`;
  if (tenths) {
    const t = Math.floor((clamped % 1000) / 100);
    return `${base}.${t}`;
  }
  return base;
}

// ---------------- 虚拟议程时钟（与 Date/时区无关的 ms-of-day） ----------------
// 推演结果可能因顺延越过 24:00 或因提前而落到 00:00 之前，用“次日/前日”标注。
export function formatClock(ms) {
  if (ms == null || !Number.isFinite(ms)) return '--:--';
  const day = Math.floor(ms / DAY_MS);
  const tod = ((ms % DAY_MS) + DAY_MS) % DAY_MS;
  const totalMin = Math.floor(tod / 60000);
  const text = `${pad2(Math.floor(totalMin / 60))}:${pad2(totalMin % 60)}`;
  if (day >= 1) return `次日 ${text}`;
  if (day <= -1) return `前日 ${text}`;
  return text;
}

// HH:MM 输入框（或毫秒数）转 ms-of-day；非法返回 null
export function parseClock(str) {
  if (typeof str === 'number') return Number.isFinite(str) ? str : null;
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(str ?? ''));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return (h * 60 + min) * 60_000;
}

// 偏差（毫秒）格式化为“+2分 / -30秒 / 准时”
export function formatDeviation(ms) {
  const abs = Math.abs(ms);
  const sign = ms < 0 ? '-' : '+';
  if (abs < 1000) return '准时';
  const totalSec = Math.round(abs / 1000);
  if (totalSec < 60) return `${sign}${totalSec}秒`;
  const min = Math.round(totalSec / 60);
  return `${sign}${min}分`;
}

// 偏差（毫秒）格式化为带符号的秒数（用于 CSV 导出，机器可读）
export function formatDeviationSeconds(ms) {
  if (Math.abs(ms) < 500) return '0';
  return String(Math.round(ms / 1000));
}

// 会话内相对时间（毫秒）格式化为 H:MM:SS
export function formatSessionClock(ms) {
  if (ms == null || !Number.isFinite(ms)) return '--:--:--';
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${pad2(m)}:${pad2(s)}`;
}

// ISO8601 挂钟时间格式化为本地 HH:MM:SS（标记时间线展示）
export function formatWallTime(iso) {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// ISO8601 挂钟时间格式化为本地 YYYY-MM-DD HH:MM:SS（CSV 导出）
export function formatWallDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// 已用时长（毫秒）格式化为 M:SS
export function formatElapsed(ms) {
  if (ms == null || !Number.isFinite(ms)) return '--:--';
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(totalSec / 60)}:${pad2(totalSec % 60)}`;
}

// CSV 字段转义：含逗号、引号或换行时用双引号包裹并把内部引号翻倍
export function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// 在两份服务端快照之间对议程预计结束点做本地外推（和 liveRemaining 同理）：
// 仅“已超时（finished）”后预计结束点随实际走时持续后移；运行中假设按时结束，
// 预计结束点不变（偏差在手动结束/归零的那一刻固化）。权威结果永远以服务端快照为准。
export function liveAgenda(snap) {
  const ag = snap?.agenda;
  if (!ag) return null;
  const items = ag.items;
  const live = snap.phase === 'finished'
    ? Math.max(0, monoNow() - snap.receivedAtMono)
    : 0;
  if (live === 0 || !ag.currentId) return { ...ag, items };

  const cur = items.find((it) => it.id === ag.currentId);
  if (!cur) return { ...ag, items };

  // 当前环节预计结束点后移 live；后续普通环节背靠背顺延，
  // 固定环节不动（重叠压缩的“时间不足”判定由下一份权威快照刷新）。
  const next = items.map((it) => ({ ...it }));
  const startIdx = next.findIndex((it) => it.id === ag.currentId);
  next[startIdx].projEndMs += live;

  for (let i = startIdx + 1; i < next.length; i++) {
    const it = next[i];
    if (it.fixed) break; // 固定环节锚定计划点，传导链到此为止
    it.projStartMs += live;
    it.projEndMs += live;
  }
  return { ...ag, deviationMs: ag.deviationMs + live, items: next };
}
