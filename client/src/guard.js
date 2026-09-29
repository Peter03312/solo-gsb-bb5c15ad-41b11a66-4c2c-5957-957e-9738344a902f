// 快照版本守卫（纯函数，便于单测）：
// 基线（epoch）只由连接首包 hello 显式建立/重置；
// 之后只接受同 epoch 且 version 严格更高的快照，
// 过期/重复消息以及旧纪元残留消息一律丢弃，画面不得回滚。
export const INITIAL_BASELINE = Object.freeze({ currentEpoch: null, currentVersion: 0 });

export function judgeSnapshot(baseline, msg) {
  if (baseline.currentEpoch === null) {
    return { accept: true, baseline: true, epoch: msg.epoch, version: msg.version };
  }
  if (msg.epoch !== baseline.currentEpoch) {
    return { accept: false }; // 旧纪元（重启前）残留消息
  }
  if (msg.version <= baseline.currentVersion) {
    return { accept: false }; // 过期或重复
  }
  return { accept: true, baseline: false, epoch: msg.epoch, version: msg.version };
}

// 控制台交接（handover）守卫（纯函数，便于单测）：
// 交接事件带服务进程 epoch 与全服务单调 seq。规则：
//   - 旧纪元残留一律丢弃（服务重启后旧交接不可能再有效）；
//   - seq 更大：接受（新等待码顶替旧码、终态结束等待、idle 清空横幅都靠它）；
//   - seq 相等：仅 pending 幂等接受（等待态广播与生成者带码单播共用同一 seq；
//     重连首包也用当前 seq 补发 pending），允许后到的带码单播补上 code；
//     终态/idle 的重复消息不重复处理。
export const INITIAL_HANDOVER_BASELINE = Object.freeze({ currentEpoch: null, seq: 0 });

export function judgeHandover(baseline, msg) {
  if (baseline.currentEpoch === null) {
    return { accept: true, fresh: true, epoch: msg.epoch, seq: msg.seq };
  }
  if (msg.epoch !== baseline.currentEpoch) {
    return { accept: false }; // 服务端重启前的残留交接事件
  }
  if (msg.seq > baseline.seq) {
    return { accept: true, fresh: true, epoch: msg.epoch, seq: msg.seq };
  }
  if (msg.seq === baseline.seq && msg.state === 'pending') {
    return { accept: true, fresh: false, epoch: msg.epoch, seq: msg.seq }; // 同 seq 补发（补码）
  }
  return { accept: false }; // 迟到的旧事件 / 终态重复
}

// 后台提示（cue）守卫（纯函数，便于单测）：
// 规则与快照一致——基线（epoch）只由连接首包 hello 显式建立/重置；
// 同 epoch 内只接受 cueSeq >= 已见 seq 的提示：
//   seq 更大 = 新提示，覆盖旧提示；seq 相等 = 断线重连后的同一条补发，幂等重新上屏；
//   seq 更小 = 迟到的旧提示（或旧纪元残留），一律丢弃，新提示状态不得回滚。
export const INITIAL_CUE_BASELINE = Object.freeze({ currentEpoch: null, cueSeq: 0 });

export function judgeCue(baseline, msg) {
  if (baseline.currentEpoch === null) {
    return { accept: true, fresh: true, epoch: msg.epoch, cueSeq: msg.cueSeq };
  }
  if (msg.epoch !== baseline.currentEpoch) {
    return { accept: false }; // 服务端重启前的残留提示
  }
  if (msg.cueSeq < baseline.cueSeq) {
    return { accept: false }; // 迟到的旧提示，不得覆盖新提示
  }
  return {
    accept: true,
    fresh: msg.cueSeq > baseline.cueSeq,
    epoch: msg.epoch,
    cueSeq: msg.cueSeq,
  };
}

// 投屏场景（scene_switch / scene_markers）守卫（纯函数，便于单测）：
// 与快照同一套 epoch + 单调版本规则：
//   - 旧纪元残留（服务重启前）一律丢弃；
//   - activeVersion 更大：新场景，投屏一次性替换整个画面；
//   - activeVersion 相等：同场景重发（断线重连补发 / 注册时的 replay），幂等接受；
//   - activeVersion 更小：旧场景的迟到消息，绝不允许覆盖新场景。
// 返回 fresh=true 表示发生了场景切换（需要重新渲染并上报 scene_displayed）。
export const INITIAL_SCENE_BASELINE = Object.freeze({ currentEpoch: null, activeVersion: 0 });

export function judgeScene(baseline, msg) {
  if (baseline.currentEpoch === null) {
    return { accept: true, fresh: true, epoch: msg.epoch, activeVersion: msg.activeVersion };
  }
  if (msg.epoch !== baseline.currentEpoch) {
    return { accept: false }; // 服务端重启前的旧场景消息
  }
  if (msg.activeVersion < baseline.activeVersion) {
    return { accept: false }; // 旧场景迟到，不得覆盖新场景
  }
  return {
    accept: true,
    fresh: msg.activeVersion > baseline.activeVersion,
    replay: msg.activeVersion === baseline.activeVersion,
    epoch: msg.epoch,
    activeVersion: msg.activeVersion,
  };
}
