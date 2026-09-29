// 全场遮屏（blackout）纯函数模块（便于单测）
//
// 模型：
//  - 会场出现不宜上屏的临时内容时，持有控制权的控制台可开启“全场遮屏”，
//    所有投屏仅显示遮屏画面与 1~30 字的说明；计时与议程照常推进，不暂停、不回退。
//  - 遮屏按“轮次（round）”区分：每次开启（含已遮屏时更新说明）都开启新一轮，round 递增；
//    解除消息必须携带它所针对的 round，旧轮次的迟到解除消息不能关闭新一轮遮屏。
//  - seq 为“遮屏事件序号”：开启与解除各占一个事件、严格递增（开启=奇序事件、解除=偶序），
//    客户端据此对开启/解除排序；round 标识解除属于哪一轮。
//  - 仅存服务端内存（与议程/标记/提示同级），服务进程重启即解除并从 seq=0/round=0 重新开始。
//
// 状态：{ seq, round, active, reason }
//  - seq：遮屏事件序号，全服务单调递增，只增不归零；
//  - round：当前/最近一轮遮屏轮次（开启时递增）；
//  - active：当前是否处于遮屏；
//  - reason：本轮遮屏说明（开启时校验通过的 trim 文案），解除后为 null。

export const MAX_BLACKOUT_REASON_LEN = 30;

export function defaultBlackout() {
  return { seq: 0, round: 0, active: false, reason: null };
}

// 开启遮屏 / 更新说明：说明 trim 后需为 1~30 字；校验失败返回错误且状态不变。
// 每次开启都是“新一轮遮屏”：round 与事件 seq 同时递增并替换说明，
// 因此针对旧轮次的迟到解除消息随后会被 blackoutOff 拒绝。
export function blackoutOn(state, rawReason) {
  const reason = String(rawReason ?? '').trim();
  if (!reason || reason.length > MAX_BLACKOUT_REASON_LEN) {
    return { error: 'BAD_BLACKOUT', message: `遮屏说明需为 1~${MAX_BLACKOUT_REASON_LEN} 字` };
  }
  state.seq += 1;
  state.round += 1;
  state.active = true;
  state.reason = reason.slice(0, MAX_BLACKOUT_REASON_LEN);
  return { ok: true, seq: state.seq, round: state.round, reason: state.reason };
}

// 解除遮屏。rawRound 为客户端所针对的轮次：
//  - 当前未遮屏：幂等成功（changed:false，不广播、不改状态）；
//  - 缺少合法正整数轮次：BAD_BLACKOUT，拒绝且状态不变；
//  - 轮次与当前不一致（旧轮次迟到解除 / 轮次超前）：BAD_BLACKOUT_SEQ，拒绝且状态不变；
//  - 轮次一致：事件 seq 递增并解除（round 保留供对账），reason 清空。
export function blackoutOff(state, rawRound) {
  if (!state.active) return { ok: true, changed: false };
  const round = Number(rawRound);
  if (!Number.isInteger(round) || round <= 0) {
    return { error: 'BAD_BLACKOUT', message: '解除遮屏需携带合法的遮屏轮次 round' };
  }
  if (round !== state.round) {
    return { error: 'BAD_BLACKOUT_SEQ', message: '旧轮次的迟到解除消息不能关闭新一轮遮屏' };
  }
  state.seq += 1;
  state.active = false;
  state.reason = null;
  return { ok: true, changed: true, seq: state.seq, round: state.round };
}

// 下发负载：控制台与投屏同口径（遮屏状态全场一致），带 epoch + 事件 seq 守卫。
export function blackoutPayload(state, epoch) {
  return {
    type: 'blackout',
    epoch,
    seq: state.seq,
    round: state.round,
    active: state.active,
    reason: state.reason,
  };
}
