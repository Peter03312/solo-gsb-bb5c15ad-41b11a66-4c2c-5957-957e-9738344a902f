import { useEffect, useState } from 'react';

const MAX_REASON_LEN = 30;
const ERROR_CODES = new Set(['BAD_BLACKOUT', 'BAD_BLACKOUT_SEQ', 'NOT_CONTROLLER']);

// 控制台“全场遮屏”面板：
//  - 持有者填写 1~30 字说明后开启全场遮屏，所有投屏只显示遮屏画面与说明；
//  - 遮屏期间计时与议程照常推进，仍可切换场景、发送后台提示（投屏解除后才呈现）；
//  - 解除携带当前轮次 seq，旧轮次迟到解除无法关闭新一轮遮屏（服务端权威拒绝）；
//  - 非持有者操作 / 说明非法 / 轮次不匹配均被服务端拒绝，状态不改变。
export default function BlackoutPanel({ blackout, canEdit, onOn, onOff, lastError, onClearError }) {
  const [reason, setReason] = useState('');
  const active = !!blackout?.active;

  // 进入遮屏态（或新一轮更换说明）时把输入框同步为当前说明，便于直接修改后再次开启
  useEffect(() => {
    if (active && blackout?.reason) setReason(blackout.reason);
  }, [active, blackout?.round]); // eslint-disable-line react-hooks/exhaustive-deps

  const trimmed = reason.trim();
  const valid = trimmed.length >= 1 && trimmed.length <= MAX_REASON_LEN;

  const turnOn = () => {
    if (!canEdit || !valid) return;
    onOn(trimmed.slice(0, MAX_REASON_LEN));
  };

  return (
    <fieldset
      className={`panel blackout-panel ${active ? 'blackout-active' : ''}`}
      disabled={!canEdit}
    >
      <legend>全场遮屏（临时不宜上屏时遮盖全部投屏，计时/议程照常推进）</legend>

      {active ? (
        <div className="blackout-status">
          <div className="blackout-status-head">
            <span className="blackout-live-dot" />
            <b>全场遮屏中</b>
            <span className="blackout-seq">第 {blackout.round} 轮</span>
          </div>
          <div className="blackout-current-reason">当前说明：{blackout.reason}</div>
          <div className="blackout-actions">
            <input
              value={reason}
              maxLength={MAX_REASON_LEN}
              placeholder={`修改说明后可开启新一轮（1~${MAX_REASON_LEN} 字）`}
              onChange={(e) => setReason(e.target.value.slice(0, MAX_REASON_LEN))}
              onKeyDown={(e) => { if (e.key === 'Enter') turnOn(); }}
            />
            <span className="cue-counter">{trimmed.length}/{MAX_REASON_LEN}</span>
            <button
              type="button"
              className="btn btn-blackout-on"
              onClick={turnOn}
              disabled={!valid}
              title="以新说明开启新一轮遮屏（旧轮次解除将失效）"
            >
              更新说明并续遮
            </button>
            <button
              type="button"
              className="btn btn-primary btn-blackout-off"
              onClick={() => onOff(blackout.round)}
              title="解除：各屏按最新场景、当前计时与议程恢复，再呈现待显示提示"
            >
              解除遮屏
            </button>
          </div>
        </div>
      ) : (
        <div className="blackout-actions">
          <input
            value={reason}
            maxLength={MAX_REASON_LEN}
            placeholder={`遮屏说明（1~${MAX_REASON_LEN} 字，投屏将只显示该说明）`}
            onChange={(e) => {
              setReason(e.target.value.slice(0, MAX_REASON_LEN));
              if (lastError && ERROR_CODES.has(lastError.code)) onClearError();
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') turnOn(); }}
          />
          <span className="cue-counter">{trimmed.length}/{MAX_REASON_LEN}</span>
          <button
            type="button"
            className="btn btn-blackout-on"
            onClick={turnOn}
            disabled={!valid}
            title={valid ? '全部投屏立即只显示遮屏画面与说明' : '先填写 1~30 字说明'}
          >
            开启全场遮屏
          </button>
        </div>
      )}

      {lastError && ERROR_CODES.has(lastError.code) ? (
        <p className="agenda-error">⚠ {lastError.message}</p>
      ) : null}
      <p className="hint">
        遮屏期间计时与议程照常推进，可继续切换场景、发送后台提示；投屏不露出场景与提示，
        也不上报提示已显示/确认，每屏只保留最新未确认提示。解除后各屏按最新场景、
        当前计时与议程恢复并呈现待显示提示，不回放旧场景或已被覆盖的提示。
      </p>
    </fieldset>
  );
}
