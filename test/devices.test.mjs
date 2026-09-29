// 设备占用纯函数单测：node test/devices.test.mjs
// 覆盖：清单校验/规范化、已删除环节绑定裁剪、跨午夜线性展开、
//       周转冲突计算（缺口/重叠）、最早冲突排序、固定开始环节、时间不足。
import assert from 'node:assert/strict';
import {
  normalizeDevices,
  pruneMissingItems,
  linearizeRows,
  buildOccupancy,
  devicesSignature,
  MAX_DEVICES,
} from '../server/src/devices.js';

let n = 0;
const check = (name, fn) => { fn(); n += 1; console.log(`  ✓ ${name}`); };

const DAY = 24 * 60 * 60 * 1000;
const H = (h, m = 0) => (h * 60 + m) * 60 * 1000;
const MIN = 60_000;

// projectAgenda 风格的行：{ id, name, fixed, insufficient, projStartMs, projEndMs }
const row = (id, name, sH, sM, eH, eM, extra = {}) => ({
  id, name, status: 'future', fixed: false, insufficient: false,
  startMs: H(sH, sM),
  projStartMs: H(sH, sM),
  projEndMs: H(eH, eM),
  durationMs: H(eH, eM) - H(sH, sM),
  ...extra,
});

check('normalizeDevices：非数组/超 20 项/空名称/非法缓冲均拒绝', () => {
  assert.equal(normalizeDevices(null).error, 'BAD_DEVICES');
  assert.equal(normalizeDevices({}).error, 'BAD_DEVICES');
  assert.equal(
    normalizeDevices(Array.from({ length: MAX_DEVICES + 1 }, (_, i) => ({ name: `d${i}`, turnaroundMin: 1 }))).error,
    'BAD_DEVICES',
  );
  assert.equal(normalizeDevices([{ name: '  ', turnaroundMin: 1 }]).error, 'BAD_DEVICES');
  assert.equal(normalizeDevices([{ name: '麦', turnaroundMin: -1 }]).error, 'BAD_DEVICES');
  assert.equal(normalizeDevices([{ name: '麦', turnaroundMin: 24 * 60 + 1 }]).error, 'BAD_DEVICES');
  assert.equal(normalizeDevices([{ name: '麦', turnaroundMin: 'x' }]).error, 'BAD_DEVICES');
});

check('normalizeDevices：名称截断、缓冲分钟转毫秒、id 去重、绑定去重保序', () => {
  const r = normalizeDevices([
    { name: '无线麦  ', turnaroundMin: 5, id: 'd1', itemIds: ['a', 'b', 'a', '', 'bad id'] },
    { name: 'x'.repeat(80), turnaroundMin: 0 },
  ]);
  assert.ok(!r.error, JSON.stringify(r));
  assert.equal(r.devices.length, 2);
  assert.equal(r.devices[0].name, '无线麦');
  assert.equal(r.devices[0].turnaroundMs, 5 * MIN);
  assert.equal(r.devices[0].id, 'd1');
  assert.deepEqual(r.devices[0].itemIds, ['a', 'b']);
  assert.equal(r.devices[1].name.length, 30);
  assert.equal(r.devices[1].turnaroundMs, 0);
  // 重复 id 自动重新生成
  const dup = normalizeDevices([{ id: 'z', name: 'a', turnaroundMin: 1 }, { id: 'z', name: 'b', turnaroundMin: 1 }]);
  assert.notEqual(dup.devices[0].id, dup.devices[1].id);
});

check('pruneMissingItems：议程中不存在的绑定自动裁剪并计数', () => {
  const devices = [
    { id: 'd1', name: '麦', turnaroundMs: 0, itemIds: ['a', 'gone', 'b'] },
    { id: 'd2', name: '箱', turnaroundMs: 0, itemIds: ['gone2'] },
    { id: 'd3', name: '台', turnaroundMs: 0, itemIds: ['a'] },
  ];
  const r = pruneMissingItems(devices, [{ id: 'a' }, { id: 'b' }]);
  assert.equal(r.removed, 2);
  assert.deepEqual(r.devices[0].itemIds, ['a', 'b']);
  assert.deepEqual(r.devices[1].itemIds, []);
  // 无裁剪时返回原对象
  assert.equal(pruneMissingItems([devices[2]], [{ id: 'a' }]).removed, 0);
});

check('linearizeRows：跨午夜的固定环节展开到次日（23:50→00:05）', () => {
  const rows = [
    row('a', 'A', 23, 50, 24, 0),
    row('b', 'B', 0, 5, 0, 15, { fixed: true, startMs: H(0, 5) }),
  ];
  const map = linearizeRows(rows);
  assert.equal(map.get('a').startMs, H(23, 50));
  assert.equal(map.get('a').endMs, DAY);
  assert.equal(map.get('b').startMs, DAY + H(0, 5));
  assert.equal(map.get('b').endMs, DAY + H(0, 15));
});

check('linearizeRows：同日固定点压缩（09:00→09:30 固定）不跨日', () => {
  const rows = [
    { id: 'a', name: 'A', projStartMs: H(9), projEndMs: H(9, 40) }, // 顺延溢出到 09:40
    { id: 'b', name: 'B', projStartMs: H(9, 30), projEndMs: H(10), fixed: true },
  ];
  const map = linearizeRows(rows);
  assert.equal(map.get('b').startMs, H(9, 30)); // 仍为同日，不被推到次日
});

check('buildOccupancy：相邻空当不足缓冲 → 冲突（缺口=缓冲-空当）', () => {
  const rows = [
    row('a', 'A', 9, 0, 9, 10),
    row('b', 'B', 9, 12, 9, 20), // 间隔 2 分钟
  ];
  const r = buildOccupancy(
    [{ id: 'd1', name: '麦', turnaroundMs: 5 * MIN, itemIds: ['a', 'b'] }],
    rows,
  );
  assert.equal(r.conflicts.length, 1);
  const c = r.conflicts[0];
  assert.equal(c.gapMs, 2 * MIN);
  assert.equal(c.shortfallMs, 3 * MIN);
  assert.equal(c.a.itemId, 'a');
  assert.equal(c.b.itemId, 'b');
  // 相邻双方都标红
  const occ = r.devices[0].occupations;
  assert.equal(occ[0].conflict, true);
  assert.equal(occ[1].conflict, true);
  assert.equal(r.devices[0].conflictCount, 2);
  // 后一占用携带 gap/shortfall
  assert.equal(occ[1].gapMs, 2 * MIN);
  assert.equal(occ[1].shortfallMs, 3 * MIN);
});

check('buildOccupancy：重叠（负空当）即使缓冲为 0 也冲突；恰好达到缓冲不冲突', () => {
  // 缓冲 0 但两场占用物理重叠：shortfall = 0 - (-2) = 2 > 0，仍是冲突（设备无法同时被占用）
  const overlap = buildOccupancy(
    [{ id: 'd1', name: '麦', turnaroundMs: 0, itemIds: ['a', 'b'] }],
    [row('a', 'A', 9, 0, 9, 10), row('b', 'B', 9, 8, 9, 20)],
  );
  assert.equal(overlap.conflicts.length, 1);
  assert.equal(overlap.conflicts[0].gapMs, -2 * MIN);
  assert.equal(overlap.conflicts[0].shortfallMs, 2 * MIN);
  const withBuf = buildOccupancy(
    [{ id: 'd1', name: '麦', turnaroundMs: 5 * MIN, itemIds: ['a', 'b'] }],
    [row('a', 'A', 9, 0, 9, 10), row('b', 'B', 9, 8, 9, 20)],
  );
  assert.equal(withBuf.conflicts[0].gapMs, -2 * MIN);
  assert.equal(withBuf.conflicts[0].shortfallMs, 7 * MIN);

  // 背靠背（间隔 0）+ 缓冲 0：不冲突
  const backToBack = buildOccupancy(
    [{ id: 'd1', name: '麦', turnaroundMs: 0, itemIds: ['a', 'b'] }],
    [row('a', 'A', 9, 0, 9, 10), row('b', 'B', 9, 10, 9, 20)],
  );
  assert.equal(backToBack.conflicts.length, 0);

  // 恰好 5 分钟空当：不冲突
  const exact = buildOccupancy(
    [{ id: 'd1', name: '麦', turnaroundMs: 5 * MIN, itemIds: ['a', 'b'] }],
    [row('a', 'A', 9, 0, 9, 10), row('b', 'B', 9, 15, 9, 20)],
  );
  assert.equal(exact.conflicts.length, 0);
  assert.equal(exact.devices[0].occupations[1].conflict, false);
});

check('buildOccupancy：非相邻议程环节之间按预计区间比较（中间环节未绑定）', () => {
  const rows = [
    row('a', 'A', 9, 0, 9, 10),
    row('x', 'X', 9, 10, 9, 30), // 未绑定该设备
    row('b', 'B', 9, 30, 9, 40),
  ];
  const r = buildOccupancy(
    [{ id: 'd1', name: '麦', turnaroundMs: 5 * MIN, itemIds: ['a', 'b'] }],
    rows,
  );
  // a 结束 09:10，b 开始 09:30：空当 20 分钟，无冲突
  assert.equal(r.conflicts.length, 0);
});

check('buildOccupancy：跨午夜相邻占用正确判定冲突与缺口', () => {
  const rows = [
    row('a', 'A', 23, 50, 24, 0),
    row('b', 'B', 0, 5, 0, 15, { fixed: true, startMs: H(0, 5) }),
  ];
  const r = buildOccupancy(
    [{ id: 'd1', name: '麦', turnaroundMs: 10 * MIN, itemIds: ['a', 'b'] }],
    rows,
  );
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].gapMs, 5 * MIN);
  assert.equal(r.conflicts[0].shortfallMs, 5 * MIN);
});

check('buildOccupancy：冲突按最早发生（b.startMs）排序，设备顺序次之', () => {
  const rows = [
    row('a', 'A', 9, 0, 9, 10),
    row('b', 'B', 9, 12, 9, 20), // 冲突点 09:12
    row('c', 'C', 10, 0, 10, 10),
    row('e', 'E', 10, 2, 10, 30), // 冲突点 10:02
  ];
  const r = buildOccupancy(
    [
      { id: 'later', name: '晚冲突设备', turnaroundMs: 10 * MIN, itemIds: ['c', 'e'] },
      { id: 'early', name: '早冲突设备', turnaroundMs: 10 * MIN, itemIds: ['a', 'b'] },
    ],
    rows,
  );
  assert.equal(r.conflicts.length, 2);
  assert.equal(r.conflicts[0].b.itemId, 'b'); // 09:12 在前，尽管设备排第二
  assert.equal(r.conflicts[1].b.itemId, 'e');
});

check('buildOccupancy：绑定到不存在环节的 id 被忽略；空库/空绑定无冲突', () => {
  const r = buildOccupancy(
    [{ id: 'd1', name: '麦', turnaroundMs: 5 * MIN, itemIds: ['ghost'] }],
    [row('a', 'A', 9, 0, 9, 10)],
  );
  assert.deepEqual(r.devices[0].occupations, []);
  assert.deepEqual(r.devices[0].itemIds, []);
  assert.deepEqual(buildOccupancy([], []).conflicts, []);
});

check('devicesSignature：内容一致则签名一致（无变化保存不递增 seq）', () => {
  const a = [{ id: 'd1', name: '麦', turnaroundMs: 5 * MIN, itemIds: ['a'] }];
  const b = [{ id: 'd1', name: '麦', turnaroundMs: 5 * MIN, itemIds: ['a'] }];
  assert.equal(devicesSignature(a), devicesSignature(b));
});

console.log(`\n设备占用纯函数测试：${n} 通过`);
