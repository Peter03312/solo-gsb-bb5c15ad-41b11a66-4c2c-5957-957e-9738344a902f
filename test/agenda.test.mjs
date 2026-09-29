// 议程偏差推演纯函数单测：node test/agenda.test.mjs
import assert from 'node:assert/strict';
import {
  projectAgenda,
  normalizeItems,
  DAY_MS,
  MIN_ITEM_DURATION_MS,
  MAX_ITEM_DURATION_MS,
} from '../server/src/agenda.js';

let n = 0;
const check = (name, fn) => { fn(); n += 1; console.log(`  ✓ ${name}`); };

const H = (h, m = 0) => (h * 60 + m) * 60 * 1000;
const MIN = 60_000;

const mk = (i, name, h, m, durMin, fixed = false) => ({
  id: `x${i}`,
  name,
  startMs: H(h, m),
  durationMs: durMin * MIN,
  fixed,
});

// 议程：
// x0 09:00 10min 普通（当前）
// x1 09:10 10min 普通
// x2 09:30 10min 固定
// x3 09:40 10min 普通
const items = [
  mk(0, 'A', 9, 0, 10),
  mk(1, 'B', 0, 0, 0),
  mk(2, 'C', 0, 0, 0),
  mk(3, 'D', 0, 0, 0),
];
items[1] = mk(1, 'B', 9, 10, 10);
items[2] = mk(2, 'C', 9, 30, 10, true);
items[3] = mk(3, 'D', 9, 40, 10);

check('未设当前环节：全部 planned，按计划开始/结束', () => {
  const rows = projectAgenda(items, {});
  assert.deepEqual(rows.map((r) => r.status), ['planned', 'planned', 'planned', 'planned']);
  assert.equal(rows[0].projStartMs, H(9));
  assert.equal(rows[0].projEndMs, H(9, 10));
  assert.equal(rows[2].projStartMs, H(9, 30));
});

check('未超时时推演假设当前环节按设定时长准时结束（偏差暂不扩大）', () => {
  // 当前 x0 运行中，已运行 8 分钟（设定 10 分钟）：结束点仍按 09:10 计
  const rows = projectAgenda(items, { currentId: 'x0', virtElapsedMs: 8 * MIN, liveDurationMs: 10 * MIN });
  assert.equal(rows[0].projStartMs, H(9));
  assert.equal(rows[0].projEndMs, H(9, 10));
  assert.equal(rows[1].projStartMs, H(9, 10));
  assert.equal(rows[1].projEndMs, H(9, 20));
  assert.equal(rows[2].projStartMs, H(9, 30)); // 固定环节锚定
});

check('提前结束：经 advance 固化为下一环节的负偏差，普通环节前移、固定环节不动', () => {
  // x0 在运行 8 分钟时被手动结束：x1 的 devIn = 09:08 - 09:10 = -2 分钟
  const rows = projectAgenda(items, { currentId: 'x1', devInMs: -2 * MIN, virtElapsedMs: 0, liveDurationMs: 10 * MIN });
  assert.equal(rows[0].status, 'done');
  assert.equal(rows[1].projStartMs, H(9, 8));  // B 提前到 09:08
  assert.equal(rows[1].projEndMs, H(9, 18));
  assert.equal(rows[2].projStartMs, H(9, 30)); // C 固定在 09:30
  assert.equal(rows[1].insufficient, false);
  assert.equal(rows[3].projStartMs, H(9, 40)); // 固定之后重新对齐计划
});

check('超时顺延：普通环节后移；撞上固定环节时压缩其前最后一个普通环节并标“时间不足”', () => {
  // x0 运行 25 分钟（超时 15 分钟）：x0 预计 09:25 结束 → B 09:25~09:35 与 C(09:30) 重叠
  // 压缩 B 到 09:25~09:30（仅 5 分钟 < 计划 10 分钟）
  const rows = projectAgenda(items, {
    currentId: 'x0', virtElapsedMs: 25 * MIN, liveDurationMs: 10 * MIN, overdue: true,
  });
  assert.equal(rows[0].projEndMs, H(9, 25));
  assert.equal(rows[1].projStartMs, H(9, 25));
  assert.equal(rows[1].projEndMs, H(9, 30));
  assert.equal(rows[1].effDurationMs, 5 * MIN);
  assert.equal(rows[1].insufficient, true);
  assert.equal(rows[2].projStartMs, H(9, 30)); // 固定环节开始时间不变
  assert.equal(rows[3].projStartMs, H(9, 40)); // 固定环节后重新对齐
});

check('严重超时：压缩到 0 仍重叠，溢出由固定环节吸收，不足标记保留', () => {
  // x0 运行 50 分钟：B 预计 09:50 才开始，C 固定 09:30 已过
  const rows = projectAgenda(items, {
    currentId: 'x0', virtElapsedMs: 50 * MIN, liveDurationMs: 10 * MIN, overdue: true,
  });
  assert.equal(rows[1].projStartMs, H(9, 50));
  assert.equal(rows[1].projEndMs, H(9, 30)); // 被夹到固定点（结束早于开始）
  assert.equal(rows[1].effDurationMs, 0);
  assert.equal(rows[1].insufficient, true);
  assert.equal(rows[2].projStartMs, H(9, 30));
  // 固定环节之后重新按计划传导
  assert.equal(rows[3].projStartMs, H(9, 40));
});

check('被压缩的可以是当前普通环节本身', () => {
  // 议程：当前 x0 09:00（普通），x1 09:05 固定；x0 超时运行到 09:08
  const it2 = [mk(0, 'A', 9, 0, 10), mk(1, 'C', 9, 5, 10, true)];
  const rows = projectAgenda(it2, {
    currentId: 'x0', virtElapsedMs: 8 * MIN, liveDurationMs: 10 * MIN, overdue: true,
  });
  assert.equal(rows[0].projStartMs, H(9));
  assert.equal(rows[0].projEndMs, H(9, 5));  // 夹到固定点
  assert.equal(rows[0].effDurationMs, 5 * MIN);
  assert.equal(rows[0].insufficient, true);
  assert.equal(rows[1].projStartMs, H(9, 5));
});

check('固定当前环节：预计开始不动，超时不移动后续固定环节', () => {
  // x2（固定 C）为当前，超时运行 15 分钟
  const rows = projectAgenda(items, {
    currentId: 'x2', virtElapsedMs: 15 * MIN, liveDurationMs: 10 * MIN, overdue: true,
  });
  assert.equal(rows[0].status, 'done');
  assert.equal(rows[1].status, 'done');
  assert.equal(rows[2].status, 'current');
  assert.equal(rows[2].projStartMs, H(9, 30));
  assert.equal(rows[2].projEndMs, H(9, 45));
  assert.equal(rows[3].projStartMs, H(9, 45)); // 后续普通环节顺延
  assert.equal(rows[3].projEndMs, H(9, 55));
});

check('两个固定环节相邻：无普通环节可压缩时不报错，溢出被固定点吸收', () => {
  const it3 = [mk(0, 'A', 9, 0, 10, true), mk(1, 'B', 9, 5, 10, true)];
  const rows = projectAgenda(it3, {
    currentId: 'x0', virtElapsedMs: 20 * MIN, liveDurationMs: 10 * MIN, overdue: true,
  });
  assert.equal(rows[0].projEndMs, H(9, 20));
  assert.equal(rows[1].projStartMs, H(9, 5));
  assert.equal(rows[1].insufficient, false);
});

check('normalizeItems 校验非法时间/时长与重复 id', () => {
  const bad1 = normalizeItems([{ name: 'a', startMs: DAY_MS, durationMs: MIN }]);
  assert.equal(bad1.error, 'BAD_AGENDA');
  const bad2 = normalizeItems([{ name: 'a', startMs: 0, durationMs: MIN_ITEM_DURATION_MS - 1 }]);
  assert.equal(bad2.error, 'BAD_AGENDA');
  const bad3 = normalizeItems([{ name: 'a', startMs: 0, durationMs: MAX_ITEM_DURATION_MS + 1 }]);
  assert.equal(bad3.error, 'BAD_AGENDA');
  assert.equal(normalizeItems('nope').error, 'BAD_AGENDA');

  const ok = normalizeItems([
    { id: 'dup', name: 'a', startMs: 0, durationMs: MIN },
    { id: 'dup', name: 'b', startMs: MIN, durationMs: MIN },
  ]);
  assert.ok(ok.items);
  assert.notEqual(ok.items[0].id, ok.items[1].id);
  // 缺省名称/字段容错
  const filled = normalizeItems([{ startMs: H(9), durationMs: 5 * MIN }]);
  assert.equal(filled.items[0].name, '环节 1');
  assert.equal(filled.items[0].fixed, false);
  assert.ok(/^[\w.-]+$/.test(filled.items[0].id));
  assert.equal(MIN_ITEM_DURATION_MS, 1000);
});

console.log(`\n议程推演单测：${n} 通过，0 失败`);
