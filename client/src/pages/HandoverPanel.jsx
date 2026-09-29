import { useEffect, useRef, useState } from 'react';

const TTL_FALLBACK_MS = 60_000;
const TERMINAL_HOLD_MS = 8_000; // 成功/过期/取消结果展示后自动收起

const HANDOVER_ERROR_CODES = new Set([
  'NOT_CONTROLLER',
  'HANDOVER_BAD_CODE',
  'HANDOVER_EXPIRED',
  'HANDOVER_NONE',
  'HANDOVER_SELF',
]);

// 交接码剩余有效期（ms）：以服务端单调时钟锚点换算到本地时钟，避免直接相信本地挂钟
function remainingMs(h) {
  if (!h || h.state !== 'pending' || h.expiresAtMono == null || h.serverTimeMono == null) {
    return TTL_FALLBACK_MS;
  }
  const skew = h.receivedAtMono - h.serverTimeMono;
  return Math.max(0, h.expiresAtMono + skew - performance.now());
}

function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// 控制台交接面板：
//  - 持有者视角：生成 60 秒一次性 6 位交接码，生成后仍可操作；可取消/重新生成；
//  - 接收方视角：锁定面板中输入正确码，服务端原子转移控制权；
//  - 双方实时看到 等待 / 成功 / 过期 / 取消 结果；投屏全程不中断。
export default function HandoverPanel({
  variant,                // 'holder'（持有者面板内）| 'receiver'（锁定面板内）
  myId,
  handover,
  canCreate,
  onCreate,
  onCancel,
  onRedeem,
  onClearResult,
  lastError,
}) {
  const [codeInput, setCodeInput] = useState('');
  const [, force] = useState(0);
  const terminalTimer = useRef(null);

  // 等待中：每 250ms 刷新倒计时（ConsolePage 本身也有 100ms 重绘，这里保证独立使用也走字）
  useEffect(() => {
    if (handover?.state !== 'pending') return undefined;
    const t = setInterval(() => force((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [handover?.state]);

  // 终态结果展示 8 秒后自动收起（仅清本地横幅，服务端状态已是 idle/终态）
  useEffect(() => {
    if (!handover || handover.state === 'pending') return undefined;
    clearTimeout(terminalTimer.current);
    terminalTimer.current = setTimeout(() => {
      onClearResult?.();
      setCodeInput('');
    }, TERMINAL_HOLD_MS);
    return () => clearTimeout(terminalTimer.current);
  }, [handover?.state, handover?.seq, onClearResult]);

  // 自己刚刚成为新持有者：清掉输入框
  useEffect(() => {
    if (handover?.state === 'success' && handover.newHolderId === myId) setCodeInput('');
  }, [handover, myId]);

  const isHolder = variant === 'holder';
  const pending = handover?.state === 'pending';
  const mine = pending && handover.holderId === myId;
  const terminal = handover && handover.state !== 'pending' ? handover : null;
  const errorMsg = lastError && HANDOVER_ERROR_CODES.has(lastError.code) ? lastError.message : '';

  // ---------------- 持有者视角 ----------------
  if (isHolder) {
    return (
      <fieldset className="panel handover-panel">
        <legend>控制台交接（一次性交接码，{Math.round((handover?.ttlMs ?? TTL_FALLBACK_MS) / 1000)} 秒有效）</legend>

        {pending ? (
          <div className="handover-card handover-waiting">
            <div className="handover-card-head">
              <span className="handover-dot" />
              <span className="handover-title">交接码等待使用中</span>
              <span className="handover-countdown">{formatCountdown(remainingMs(handover))}</span>
            </div>
            <p className="handover-code" aria-label="一次性交接码">
              {mine ? handover.code : '······'}
            </p>
            <p className="hint">
              {mine
                ? '请把 6 位交接码口头告知接收控制台；对方输入正确码前，你仍可正常操作计时、议程、巡检与提示，投屏不中断。'
                : '另一台控制台正在等待交接完成。'}
            </p>
            {mine && (
              <div className="handover-actions">
                <button type="button" className="btn" onClick={onCreate}>↻ 重新生成（旧码立即失效）</button>
                <button type="button" className="btn btn-ghost" onClick={onCancel}>取消交接</button>
              </div>
            )}
          </div>
        ) : (
          <div className="handover-card handover-idle">
            <p className="hint handover-intro">
              生成一枚 <b>{Math.round(TTL_FALLBACK_MS / 1000)} 秒有效</b>的 6 位一次性交接码；接收方在另一台控制台的“接收交接”处输入后，
              服务端<b>原子转移</b>唯一控制权：计时、议程、巡检、标记与提示状态连续保持，投屏不中断。
              交接成功或超时后码立即失效。
            </p>
            <div className="handover-actions">
              <button type="button" className="btn btn-primary" disabled={!canCreate} onClick={onCreate}>
                🔑 生成交接码
              </button>
            </div>
          </div>
        )}

        {terminal && (
          <div className={`handover-result handover-result-${terminal.state}`}>
            {terminal.state === 'success' && '✅ 控制权已交接给接收方'}
            {terminal.state === 'expired' && '⌛ 交接码已过期（60 秒内未被使用），可重新生成'}
            {terminal.state === 'cancelled' && `🚫 交接已取消${terminal.reason && terminal.reason !== 'cancelled' ? `（${CANCEL_REASON_TEXT[terminal.reason] ?? terminal.reason}）` : ''}`}
          </div>
        )}
      </fieldset>
    );
  }

  // ---------------- 接收方视角（锁定面板内）------------------
  const iAmNewHolder = terminal?.state === 'success' && terminal.newHolderId === myId;
  return (
    <div className="handover-receiver">
      {pending ? (
        <>
          <p className="handover-receiver-title">🔑 持有者已发起交接，输入 6 位交接码立即接管</p>
          <div className="handover-receive-row">
            <input
              className="handover-code-input"
              value={codeInput}
              inputMode="numeric"
              maxLength={6}
              placeholder="6 位数字"
              onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && codeInput.length === 6) onRedeem(codeInput);
              }}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={codeInput.length !== 6}
              onClick={() => onRedeem(codeInput)}
            >
              立即接管
            </button>
            <span className="handover-countdown">{formatCountdown(remainingMs(handover))}</span>
          </div>
          <p className="hint">交接成功后计时、议程、巡检与投屏画面无缝连续；错误码与重复提交会被服务端拒绝。</p>
        </>
      ) : terminal ? (
        <div className={`handover-result handover-result-${terminal.state}`}>
          {terminal.state === 'success' && (iAmNewHolder
            ? '✅ 交接成功，控制权已转到本机'
            : '✅ 交接已完成（控制权由另一台控制台接管）')}
          {terminal.state === 'expired' && '⌛ 交接码已过期，请等待持有者重新生成'}
          {terminal.state === 'cancelled' && `🚫 交接已取消${terminal.reason && terminal.reason !== 'cancelled' ? `（${CANCEL_REASON_TEXT[terminal.reason] ?? terminal.reason}）` : ''}`}
        </div>
      ) : null}
      {errorMsg && <p className="agenda-error handover-error">⚠ {errorMsg}</p>}
    </div>
  );
}

const CANCEL_REASON_TEXT = {
  released: '持有者主动释放',
  disconnected: '持有者断线',
  timeout: '持有者心跳失联',
};
