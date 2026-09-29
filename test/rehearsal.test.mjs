// 结束时间预演纯函数单测：node test/rehearsal.test.mjs
// 覆盖：
//  - 快照参数反推（普通/固定环节的 devIn、running/paused/finished 的已用时长）；
//  - 预演复用 projectAgenda：普通环节背靠背顺延、固定环节压缩当前/后续普通环节、
//    固定点吸收溢出、跨午夜线性时间轴；
//  - diffOccupancy 对账：新增冲突、缺口增大（worse）、不变（same）、消失（resolved）、
//    占用区间相对现场偏移。
import assert from 'node:assert/strict';
import { projectAgenda } from '../server/src/agenda.js';
import {
  snapshotAgendaParams,
  projectFromSnapshot,
  rehearseAgenda,
  diffOccupancy,
} from '../server/src/rehearsal.js';

let n = 0;
const check = (name, fn) => { fn(); n += 1; console.log(`  ✓ ${name}`); };

const DAY = 24 * 60 * 60 * 1000;
const H = (h, m = 0) => ((h * 60 + m) * 60) * 1000;
const MIN = 60_000;

const mk = (id, name, h, m, durMin, fixed = false) => ({
  id, name, startMs: H(h, m), durationMs: durMin * MIN, fixed,
});

// 议程：A 09:00 10 分（普通，当前默认）；B 09:10 10 分（普通）；
//       C 09:30 10 分（固定）；D 09:40 10 分（普通）
const items = [
  mk('a', 'A', 9, 0, 10),
  mk('b', 'B', 9, 10, 10),
  mk('c', 'C', 9, 30, 10, true),
  mk('d', 'D', 9, 40, 10),
];

// 构造一帧与 server buildSnapshot 同构的“权威快照”
function makeSnap({
  currentId = 'a',
  phase = 'running',
  durationMs = 10 * MIN,
  elapsedMs = 0,
  devInMs = 0,
  overdue = phase === 'finished',
} = {}) {
  const rows = projectAgenda(items, {
    currentId,
    devInMs,
    virtElapsedMs: overdue ? elapsedMs : Math.min(elapsedMs, durationMs),
    liveDurationMs: durationMs,
    overdue,
  });
  return {
    epoch: 'e1',
    phase,
    durationMs,
    remainingMs: Math.max(0, durationMs - elapsedMs),
    agenda: { seq: 1, currentId, elapsedMs, items: rows },
  };
}

check('snapshotAgendaParams：普通当前环节反推进环节偏差 devIn', () => {
  // B 为当前、提前 2 分钟进入（devIn=-2）：projStart=09:08
  const snap = makeSnap({ currentId: 'b', devInMs: -2 * MIN, elapsedMs: 0, phase: 'idle' });
  const p = snapshotAgendaParams(snap);
  assert.equal(p.currentId, 'b');
  assert.equal(p.devInMs, -2 * MIN);
  assert.equal(p.elapsedMs, 0);
  assert.equal(p.liveDurationMs, 10 * MIN);
});

check('snapshotAgendaParams：固定当前环节 devIn 恒为 0；finished 已用时长按结束行反推', () => {
  const snap = makeSnap({ currentId: 'c', phase: 'finished', elapsedMs: 15 * MIN });
  const p = snapshotAgendaParams(snap);
  assert.equal(p.devInMs, 0);
  // finished 下 projEnd = projStart + 实际已用 → 09:45
  assert.equal(p.elapsedMs, 15 * MIN);
});

check('snapshotAgendaParams：running 的快照已用时长夹取到采用时长之内', () => {
  const snap = makeSnap({ phase: 'running', elapsedMs: 3 * MIN });
  const p = snapshotAgendaParams(snap);
  assert.equal(p.elapsedMs, 3 * MIN);
  assert.equal(p.overdue, false);
});

check('预演：再持续 N 分钟 → 当前环节结束点后移，后续普通环节背靠背顺延', () => {
  // A 09:00 开始、已运行 3 分钟、设定 10 分钟；预演“再持续 12 分钟”：
  // 总运行 15 分钟 → A 09:15 结束（现场假设准时结束是 09:10，后移 5 分）
  const snap = makeSnap({ phase: 'running', elapsedMs: 3 * MIN });
  const r = rehearseAgenda(snap, { extraMs: 12 * MIN, elapsedMs: 3 * MIN });
  assert.equal(r.curEndMs, H(9, 15));
  assert.equal(r.naturalEndMs, H(9, 15));
  assert.equal(r.clamped, false);
  const byId = new Map(r.rows.map((x) => [x.id, x]));
  assert.equal(byId.get('b').projStartMs, H(9, 15));
  assert.equal(byId.get('b').projEndMs, H(9, 25));
});

check('预演：暂停态按“现在继续、再持续 N 分”模拟（冻结已用时长作为起点）', () => {
  // A 已暂停，冻结已用 8 分钟；再持续 5 分钟 → 总 13 分钟，09:13 结束
  const snap = makeSnap({ phase: 'paused', elapsedMs: 8 * MIN });
  const r = rehearseAgenda(snap, { extraMs: 5 * MIN, elapsedMs: 8 * MIN });
  assert.equal(r.curEndMs, H(9, 13));
});

check('预演：延长撞上固定环节 → 压缩其前最后一个普通环节并标“时间不足”', () => {
  // A 已用 3 分钟、再持续 20 分钟 → 总 23 分钟，自然结束 09:23；
  // B 09:23~09:30（有效 7 分 < 计划 10 分，时间不足）；C 仍锚定 09:30；D 仍 09:40
  const snap = makeSnap({ phase: 'running', elapsedMs: 3 * MIN });
  const r = rehearseAgenda(snap, { extraMs: 20 * MIN, elapsedMs: 3 * MIN });
  assert.equal(r.curEndMs, H(9, 23));
  const byId = new Map(r.rows.map((x) => [x.id, x]));
  assert.equal(byId.get('b').projStartMs, H(9, 23));
  assert.equal(byId.get('b').projEndMs, H(9, 30));
  assert.equal(byId.get('b').effDurationMs, 7 * MIN);
  assert.equal(byId.get('b').insufficient, true);
  assert.equal(byId.get('c').projStartMs, H(9, 30));
  assert.equal(byId.get('d').projStartMs, H(9, 40));
  assert.equal(r.clamped, false); // 被压缩的是后续普通环节，当前环节自身未被截断
});

check('预演：可被压缩的最后一个普通环节就是当前环节本身（当前后紧跟固定环节）', () => {
  const it2 = [mk('a', 'A', 9, 0, 10), mk('c', 'C', 9, 10, 10, true)];
  const rows = projectAgenda(it2, {
    currentId: 'a', virtElapsedMs: 3 * MIN, liveDurationMs: 10 * MIN,
  });
  const snap = {
    epoch: 'e1', phase: 'running', durationMs: 10 * MIN,
    agenda: { seq: 1, currentId: 'a', elapsedMs: 3 * MIN, items: rows },
  };
  // 再持续 10 分钟 → 总 13 分钟，自然结束 09:13，被固定点 09:10 截断，吸收 3 分钟
  const r = rehearseAgenda(snap, { extraMs: 10 * MIN, elapsedMs: 3 * MIN });
  assert.equal(r.naturalEndMs, H(9, 13));
  assert.equal(r.curEndMs, H(9, 10));
  assert.equal(r.clamped, true);
  assert.equal(r.absorbedMs, 3 * MIN);
  const cur = r.rows.find((x) => x.id === 'a');
  // 截断到固定点 09:10 = 当前环节设定的完整 10 分钟（未短于设定时长，
  // 故 agenda 规则不标 insufficient）；预演自身以 clamped/absorbedMs 标注溢出
  assert.equal(cur.effDurationMs, 10 * MIN);
  assert.equal(cur.insufficient, false);
});

check('预演：跨午夜顺延到固定环节，截断量与次日落位在线性时间轴正确', () => {
  // E 23:50 10 分普通（当前，已运行 5 分）；F 00:05 10 分固定（次日）
  const cross = [mk('e', 'E', 23, 50, 10), mk('f', 'F', 0, 5, 10, true)];
  const rows = projectAgenda(cross, {
    currentId: 'e', virtElapsedMs: 5 * MIN, liveDurationMs: 10 * MIN,
  });
  const snap = {
    epoch: 'e1', phase: 'running', durationMs: 10 * MIN,
    agenda: { seq: 1, currentId: 'e', elapsedMs: 5 * MIN, items: rows },
  };
  // 再持续 15 分钟 → 总 20 分钟，自然结束 次日 00:10；固定点 次日 00:05 截断，吸收 5 分钟。
  // 议程层 projEndMs 固定点重置回 ms-of-day（00:05=300000），次日归属由
  // buildOccupancy.linearizeRows 按前一占用“最近一天”展开（与设备面板同一口径）。
  const r = rehearseAgenda(snap, { extraMs: 15 * MIN, elapsedMs: 5 * MIN });
  assert.equal(r.naturalEndMs, DAY + 10 * MIN);
  assert.equal(r.curEndMs, DAY + 5 * MIN); // ms-of-day 00:05 经最近一天展开为次日 00:05
  assert.equal(r.clamped, true);
  assert.equal(r.absorbedMs, 5 * MIN);

  // 设备占用线性化：E 的 ms-of-day 结束点经“最近一天”展开到次日 00:05，
  // F 也在次日 00:05，两场背靠背，跨午夜空当为 0
  const devs = [{ id: 'm', name: '麦', turnaroundMs: 5 * MIN, itemIds: ['e', 'f'] }];
  const diff = diffOccupancy(devs, rows, r.rows);
  const occ = diff.sim.devices[0].occupations;
  assert.equal(occ[0].startMs, H(23, 50));
  assert.equal(occ[0].endMs, DAY + 5 * MIN);
  assert.equal(occ[1].startMs, DAY + 5 * MIN);
  assert.equal(occ[1].endMs, DAY + 15 * MIN);
  assert.equal(diff.conflicts[0].gapMs, 0);
  assert.equal(diff.conflicts[0].shortfallMs, 5 * MIN);
});

check('projectFromSnapshot：显式已用时长重跑推演', () => {
  const snap = makeSnap({ phase: 'paused', elapsedMs: 8 * MIN });
  const rows = projectFromSnapshot(snap, 20 * MIN);
  const a = rows.find((x) => x.id === 'a');
  assert.equal(a.projEndMs, H(9, 20));
});

check('rehearseAgenda：无当前环节返回 null', () => {
  const rows = projectAgenda(items, {});
  const snap = { epoch: 'e1', phase: 'idle', durationMs: 10 * MIN, agenda: { currentId: null, items: rows } };
  assert.equal(rehearseAgenda(snap, { extraMs: 5 * MIN }), null);
  assert.equal(snapshotAgendaParams(snap).currentId, null);
});

// ---- diffOccupancy 设备周转对账 ----

check('diffOccupancy：现场无冲突 → 预演延后产生“新增”冲突', () => {
  const liveRows = makeSnap({ phase: 'running', elapsedMs: 3 * MIN }).agenda.items;
  // A 09:00–10、C 固定 09:30–40：间隔 20 分 > 缓冲 10 分，现场无冲突
  const devs = [{ id: 'm', name: '麦', turnaroundMs: 10 * MIN, itemIds: ['a', 'c'] }];
  assert.equal(diffOccupancy(devs, liveRows, liveRows).conflicts.length, 0);

  // 再持续 17 分（总 20）：A 09:20 结束、B 09:20–30 压缩、C 仍 09:30 → A/C 间隔恰好 10 分
  const snap = makeSnap({ phase: 'running', elapsedMs: 3 * MIN });
  const simOk = rehearseAgenda(snap, { extraMs: 17 * MIN, elapsedMs: 3 * MIN });
  assert.equal(diffOccupancy(devs, liveRows, simOk.rows).conflicts.length, 0);

  // 再持续 18 分（总 21）：A 09:21 → A/C 间隔 9 分 < 10 分 → 新增冲突，缺口 1 分
  const sim = rehearseAgenda(snap, { extraMs: 18 * MIN, elapsedMs: 3 * MIN });
  assert.equal(sim.curEndMs, H(9, 21));
  const diff = diffOccupancy(devs, liveRows, sim.rows);
  assert.equal(diff.counts.live, 0);
  assert.equal(diff.conflicts.length, 1);
  assert.equal(diff.conflicts[0].kind, 'new');
  assert.equal(diff.conflicts[0].gapMs, 9 * MIN);
  assert.equal(diff.conflicts[0].shortfallMs, 1 * MIN);
  assert.equal(diff.counts.added, 1);
  // 相邻双方都卷入冲突（面板据此标红）
  assert.equal(diff.sim.devices[0].occupations[0].conflict, true);
  assert.equal(diff.sim.devices[0].occupations[1].conflict, true);
});

check('diffOccupancy：现场已冲突，预演延后使缺口增大（worse）；零延后与现场相同（same）', () => {
  const snap = makeSnap({ phase: 'running', elapsedMs: 3 * MIN });
  const liveRows = snap.agenda.items;
  // 设备绑 a/c：A 09:00–10 与固定 C 09:30 现场间隔 20 分；缓冲 25 分 → 现场缺口 5 分。
  // 预演把 A（普通环节）推向固定点 C，间隔缩小、缺口增大。
  const mic = [{ id: 'mic', name: '无线麦', turnaroundMs: 25 * MIN, itemIds: ['a', 'c'] }];
  const live = diffOccupancy(mic, liveRows, liveRows);
  assert.equal(live.live.conflicts.length, 1);
  assert.equal(live.live.conflicts[0].gapMs, 20 * MIN);
  assert.equal(live.live.conflicts[0].shortfallMs, 5 * MIN);

  // 再持续 8 分（已用 3 → 总 11，超过设定 10）：A 09:11，间隔 19 分，缺口 6（+1，worse）
  const sim = rehearseAgenda(snap, { extraMs: 8 * MIN, elapsedMs: 3 * MIN });
  assert.equal(sim.curEndMs, H(9, 11));
  let diff = diffOccupancy(mic, liveRows, sim.rows);
  assert.equal(diff.conflicts[0].kind, 'worse');
  assert.equal(diff.conflicts[0].gapMs, 19 * MIN);
  assert.equal(diff.conflicts[0].shortfallMs, 6 * MIN);
  assert.equal(diff.conflicts[0].deltaMs, 1 * MIN);
  assert.equal(diff.counts.worse, 1);

  // 再持续 0 且模拟帧与参照帧一致 → kind=same、delta=0（用超时帧做自参照，
  // 该帧 A 09:12 与 C 间隔 18 分 < 缓冲 25 分，冲突确实存在）
  const overRef = makeSnap({ phase: 'finished', elapsedMs: 12 * MIN }).agenda.items;
  const overSim = rehearseAgenda(snap, { extraMs: 9 * MIN, elapsedMs: 3 * MIN }); // 总 12
  assert.equal(overSim.curEndMs, H(9, 12));
  const same = diffOccupancy(mic, overRef, overSim.rows);
  assert.equal(same.conflicts.length, 1);
  assert.equal(same.conflicts[0].kind, 'same');
  assert.ok(Math.abs(same.conflicts[0].deltaMs) < 1);
});

check('diffOccupancy：超时现场下预演继续延后，固定点不移动 → 缺口逐帧增大', () => {
  // 归零后超时 2 分：A 09:12 结束，与固定 C 09:30 间隔 18 分；缓冲 25 分 → 现场缺口 7 分
  const overSnap = makeSnap({ phase: 'finished', elapsedMs: 12 * MIN });
  const overRows = overSnap.agenda.items;
  const mic = [{ id: 'mic', name: '无线麦', turnaroundMs: 25 * MIN, itemIds: ['a', 'c'] }];
  const over = diffOccupancy(mic, overRows, overRows);
  assert.equal(over.live.conflicts[0].shortfallMs, 7 * MIN);

  // 超时现场再持续 3 分：A 09:15 → 间隔 15 分，缺口 10（+3，worse）
  const sim = rehearseAgenda(overSnap, { extraMs: 3 * MIN, elapsedMs: 12 * MIN });
  const diff = diffOccupancy(mic, overRows, sim.rows);
  assert.equal(diff.conflicts[0].kind, 'worse');
  assert.equal(diff.conflicts[0].gapMs, 15 * MIN);
  assert.equal(diff.conflicts[0].shortfallMs, 10 * MIN);
  assert.equal(diff.conflicts[0].deltaMs, 3 * MIN);

  // 再持续 0：以超时帧自身重算，与现场一致 → same
  const same = rehearseAgenda(overSnap, { extraMs: 0, elapsedMs: 12 * MIN });
  const d2 = diffOccupancy(mic, overRows, same.rows);
  assert.equal(d2.conflicts[0].kind, 'same');
});

check('diffOccupancy：普通环节背靠背同移不改空当（a/b 缺口不变），固定点吸收后才扩大', () => {
  // 设备绑 a/b、缓冲 10 分：现场 A/B 背靠背 gap=0、缺口 10。
  // A 延长 5 分钟（超过设定时长）：A 与 B 同时后移 5 分仍背靠背，gap 恒为 0 → same。
  // 这是物理事实：占用双方在同一传导链上等量平移不改变相邻空当。
  const snap = makeSnap({ phase: 'running', elapsedMs: 3 * MIN });
  const liveRows = snap.agenda.items;
  const mic = [{ id: 'mic', name: '无线麦', turnaroundMs: 10 * MIN, itemIds: ['a', 'b'] }];
  const sim = rehearseAgenda(snap, { extraMs: 8 * MIN, elapsedMs: 3 * MIN }); // 总 11 分
  assert.equal(sim.curEndMs, H(9, 11));
  const diff = diffOccupancy(mic, liveRows, sim.rows);
  assert.equal(diff.conflicts[0].gapMs, 0);
  assert.equal(diff.conflicts[0].shortfallMs, 10 * MIN);
  assert.equal(diff.conflicts[0].kind, 'same');
});

check('diffOccupancy：现场冲突在另一帧消失 → resolved', () => {
  // 设备绑 b/c、缓冲 5 分：
  //  - 未超时现场：B 09:10–20、C 09:30 → 间隔 10 分，不冲突；
  //  - 超时帧（A 运行 25 分）：B 被压缩到 09:25–30，与 C 背靠背 → 冲突。
  const devs = [{ id: 'm', name: '麦', turnaroundMs: 5 * MIN, itemIds: ['b', 'c'] }];
  const okRows = makeSnap({ phase: 'running', elapsedMs: 3 * MIN }).agenda.items;
  assert.equal(diffOccupancy(devs, okRows, okRows).conflicts.length, 0);

  const overRows = makeSnap({ phase: 'finished', elapsedMs: 25 * MIN }).agenda.items;
  const bOver = overRows.find((x) => x.id === 'b');
  assert.equal(bOver.projStartMs, H(9, 25));
  assert.equal(bOver.projEndMs, H(9, 30));
  const over = diffOccupancy(devs, overRows, overRows);
  assert.equal(over.live.conflicts.length, 1);

  // 以超时帧为“现场”、未超时帧为“模拟”：冲突消失 → resolved
  const diff = diffOccupancy(devs, overRows, okRows);
  assert.equal(diff.conflicts.length, 0);
  assert.equal(diff.resolved.length, 1);
  assert.equal(diff.resolved[0].b.itemId, 'c');
  assert.equal(diff.counts.resolved, 1);
});

check('diffOccupancy：占用区间携带相对现场的开始/结束偏移', () => {
  const snap = makeSnap({ phase: 'running', elapsedMs: 3 * MIN });
  const liveRows = snap.agenda.items;
  // 再持续 12 分 → 总 15 分：A 09:15、B 09:15–25（现场 B 09:10–20，整体 +5 分）
  const sim = rehearseAgenda(snap, { extraMs: 12 * MIN, elapsedMs: 3 * MIN });
  assert.equal(sim.curEndMs, H(9, 15));
  const devs = [{ id: 'm', name: '麦', turnaroundMs: 0, itemIds: ['b'] }];
  const diff = diffOccupancy(devs, liveRows, sim.rows);
  const bOcc = diff.sim.devices[0].occupations[0];
  assert.equal(bOcc.itemId, 'b');
  assert.equal(bOcc.liveStartMs, H(9, 10));
  assert.equal(bOcc.startDeltaMs, 5 * MIN); // B 09:10 → 09:15
  assert.equal(bOcc.endDeltaMs, 5 * MIN);
});

check('diffOccupancy：空设备库/空绑定不产生冲突；非数组入参安全降级', () => {
  const snap = makeSnap({ phase: 'running', elapsedMs: 3 * MIN });
  const sim = rehearseAgenda(snap, { extraMs: 20 * MIN, elapsedMs: 3 * MIN });
  assert.deepEqual(diffOccupancy([], snap.agenda.items, sim.rows).conflicts, []);
  assert.deepEqual(diffOccupancy(null, snap.agenda.items, sim.rows).resolved, []);
});

console.log(`\n结束时间预演纯函数测试：${n} 通过，0 失败`);
