// 版本守卫纯函数单测：node test/guard.test.mjs
import assert from 'node:assert/strict';
import {
  judgeSnapshot,
  judgeCue,
  judgeHandover,
  judgeScene,
  INITIAL_BASELINE,
  INITIAL_CUE_BASELINE,
  INITIAL_HANDOVER_BASELINE,
  INITIAL_SCENE_BASELINE,
} from '../client/src/guard.js';

let n = 0;
const check = (name, fn) => { fn(); n += 1; console.log(`  ✓ ${name}`); };

// 模拟连接首包 hello 建立基线
let st = { currentEpoch: 'E1', currentVersion: 0 };

check('更高版本被接受', () => {
  const v = judgeSnapshot(st, { epoch: 'E1', version: 5 });
  assert.equal(v.accept, true);
  assert.equal(v.baseline, false);
  st = { currentEpoch: v.epoch, currentVersion: v.version };
});

check('过期低版本被丢弃（不得回滚画面）', () => {
  const v = judgeSnapshot(st, { epoch: 'E1', version: 2, phase: 'idle' });
  assert.equal(v.accept, false);
});

check('相同版本被丢弃（重复消息）', () => {
  const v = judgeSnapshot(st, { epoch: 'E1', version: 5 });
  assert.equal(v.accept, false);
});

check('旧纪元残留快照（重启前消息）被丢弃', () => {
  const v = judgeSnapshot(st, { epoch: 'E0', version: 999 });
  assert.equal(v.accept, false);
});

check('未来纪元快照也不会在 hello 之前被冒认为基线', () => {
  const v = judgeSnapshot(st, { epoch: 'E2', version: 1 });
  assert.equal(v.accept, false);
});

check('INITIAL_BASELINE 下首条快照兜底接受（hello 丢失场景）', () => {
  const v = judgeSnapshot(INITIAL_BASELINE, { epoch: 'E9', version: 3 });
  assert.equal(v.accept, true);
  assert.equal(v.baseline, true);
  assert.equal(v.version, 3);
});

// ---------------- 后台提示（cue）守卫 ----------------
let cueBase = { currentEpoch: 'E1', cueSeq: 10 };

check('cue：更大 seq 为新提示，接受并标记 fresh', () => {
  const v = judgeCue(cueBase, { epoch: 'E1', cueSeq: 11 });
  assert.equal(v.accept, true);
  assert.equal(v.fresh, true);
  cueBase = { currentEpoch: v.epoch, cueSeq: v.cueSeq };
});

check('cue：相等 seq（断线重连同一条补发）接受但非 fresh（幂等上屏）', () => {
  const v = judgeCue(cueBase, { epoch: 'E1', cueSeq: 11 });
  assert.equal(v.accept, true);
  assert.equal(v.fresh, false);
});

check('cue：更小 seq 的迟到旧提示丢弃（不得覆盖新提示）', () => {
  const v = judgeCue(cueBase, { epoch: 'E1', cueSeq: 9 });
  assert.equal(v.accept, false);
});

check('cue：旧纪元残留提示丢弃', () => {
  const v = judgeCue(cueBase, { epoch: 'E0', cueSeq: 99 });
  assert.equal(v.accept, false);
});

check('cue：新纪元（服务端重启）首条在 hello 重置基线后接受', () => {
  const v = judgeCue({ currentEpoch: 'E2', cueSeq: 0 }, { epoch: 'E2', cueSeq: 1 });
  assert.equal(v.accept, true);
  assert.equal(v.fresh, true);
});

check('cue：INITIAL_CUE_BASELINE 下首条兜底接受', () => {
  const v = judgeCue(INITIAL_CUE_BASELINE, { epoch: 'E9', cueSeq: 5 });
  assert.equal(v.accept, true);
  assert.equal(v.fresh, true);
});

// ---------------- 控制台交接（handover） ----------------
let hoBase = { currentEpoch: 'E1', seq: 0 };

check('handover：INITIAL 基线首条兜底接受（pending 等待态）', () => {
  const v = judgeHandover(INITIAL_HANDOVER_BASELINE, { epoch: 'E1', seq: 1, state: 'pending' });
  assert.equal(v.accept, true);
  assert.equal(v.fresh, true);
  hoBase = { currentEpoch: v.epoch, seq: v.seq };
});

check('handover：同 seq 的 pending（带码单播补发）接受但非 fresh，用于幂等补 code', () => {
  const v = judgeHandover(hoBase, { epoch: 'E1', seq: 1, state: 'pending', code: '123456' });
  assert.equal(v.accept, true);
  assert.equal(v.fresh, false);
});

check('handover：更大 seq 的 success 终态接受（fresh）', () => {
  const v = judgeHandover(hoBase, { epoch: 'E1', seq: 2, state: 'success' });
  assert.equal(v.accept, true);
  assert.equal(v.fresh, true);
  hoBase = { currentEpoch: v.epoch, seq: v.seq };
});

check('handover：相同 seq 的终态重复消息丢弃（结果横幅不重复刷新）', () => {
  const v = judgeHandover(hoBase, { epoch: 'E1', seq: 2, state: 'success' });
  assert.equal(v.accept, false);
});

check('handover：更旧 seq 的迟到 pending 丢弃（旧码不得覆盖已成功/过期的结果）', () => {
  const v = judgeHandover(hoBase, { epoch: 'E1', seq: 1, state: 'pending', code: '000000' });
  assert.equal(v.accept, false);
});

check('handover：旧纪元残留交接事件丢弃', () => {
  const v = judgeHandover(hoBase, { epoch: 'E0', seq: 99, state: 'pending' });
  assert.equal(v.accept, false);
});

check('handover：重新生成（pending→更大 seq pending）作为新事件接受', () => {
  const v = judgeHandover({ currentEpoch: 'E1', seq: 3 }, { epoch: 'E1', seq: 4, state: 'pending' });
  assert.equal(v.accept, true);
  assert.equal(v.fresh, true);
});

// ---------------- 投屏场景（scene_switch / scene_markers）守卫 ----------------
let sceneBase = { currentEpoch: 'E1', activeVersion: 3 };

check('scene：更大 activeVersion 为新场景，接受并标记 fresh（一次性替换）', () => {
  const v = judgeScene(sceneBase, { epoch: 'E1', activeVersion: 4 });
  assert.equal(v.accept, true);
  assert.equal(v.fresh, true);
  sceneBase = { currentEpoch: v.epoch, activeVersion: v.activeVersion };
});

check('scene：相等 activeVersion（断线重连 replay / scene_markers 更新）接受但非 fresh', () => {
  const v = judgeScene(sceneBase, { epoch: 'E1', activeVersion: 4 });
  assert.equal(v.accept, true);
  assert.equal(v.fresh, false);
  assert.equal(v.replay, true);
});

check('scene：更小 activeVersion 的旧场景迟到消息丢弃（不得覆盖新场景）', () => {
  const v = judgeScene(sceneBase, { epoch: 'E1', activeVersion: 2 });
  assert.equal(v.accept, false);
});

check('scene：旧纪元残留场景消息丢弃（服务重启前）', () => {
  const v = judgeScene(sceneBase, { epoch: 'E0', activeVersion: 99 });
  assert.equal(v.accept, false);
});

check('scene：新纪元在 hello 重置基线后首条接受（重连恢复当前场景）', () => {
  const v = judgeScene({ currentEpoch: 'E2', activeVersion: 0 }, { epoch: 'E2', activeVersion: 1 });
  assert.equal(v.accept, true);
  assert.equal(v.fresh, true);
});

check('scene：INITIAL_SCENE_BASELINE 下首条兜底接受（hello 丢失场景）', () => {
  const v = judgeScene(INITIAL_SCENE_BASELINE, { epoch: 'E9', activeVersion: 7 });
  assert.equal(v.accept, true);
  assert.equal(v.fresh, true);
  assert.equal(v.activeVersion, 7);
});

console.log(`\n守卫单测：${n} 通过，0 失败`);
