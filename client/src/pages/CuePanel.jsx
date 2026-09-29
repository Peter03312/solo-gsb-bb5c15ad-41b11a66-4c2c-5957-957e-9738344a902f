import { useMemo, useState } from 'react';

const PRESETS = [
  { type: 'stage', label: '请上场', cls: 'cue-btn-stage' },
  { type: 'hurry', label: '加快', cls: 'cue-btn-hurry' },
  { type: 'finish', label: '结束', cls: 'cue-btn-finish' },
];
const MAX_CUSTOM_LEN = 30;

const STATUS_TEXT = {
  pending: '未送达',
  displayed: '已显示',
  acknowledged: '已确认',
};

// 控制台后台提示面板：
//  - 逐屏列出在线状态与最新提示的 未送达 / 已显示 / 已确认；
//  - 可勾选一块、多块或“全部在线”作为目标，发送预设/不超过 30 字自定义提示；
//  - 新提示覆盖旧提示，目标之外的屏幕不显示。
export default function CuePanel({ screens, canSend, send, lastError }) {
  const [selected, setSelected] = useState(() => new Set());
  const [custom, setCustom] = useState('');

  const onlineScreens = useMemo(() => screens.filter((s) => s.online), [screens]);
  const allOnlineSelected = onlineScreens.length > 0
    && onlineScreens.every((s) => selected.has(s.id));

  const targets = useMemo(() => screens.filter((s) => selected.has(s.id)), [screens, selected]);

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const toggleAllOnline = () => setSelected((prev) => {
    if (onlineScreens.every((s) => prev.has(s.id))) {
      const next = new Set(prev);
      onlineScreens.forEach((s) => next.delete(s.id));
      return next;
    }
    return new Set([...prev, ...onlineScreens.map((s) => s.id)]);
  });

  // 屏幕被注销（服务端重启）后从勾选中清理
  const validTargets = targets.map((s) => s.id);

  const sendCue = (cueType, text) => {
    if (!canSend || validTargets.length === 0) return;
    send({ command: 'cue_send', targets: validTargets, cueType, text });
  };

  const sendCustom = () => {
    const text = custom.trim().slice(0, MAX_CUSTOM_LEN);
    if (!text) return;
    sendCue('custom', text);
    setCustom('');
  };

  return (
    <fieldset className="panel cue-panel" disabled={!canSend}>
      <legend>后台提示（向目标投屏全屏推送，现场确认后回传状态）</legend>

      {screens.length === 0 ? (
        <p className="hint">尚无投屏注册。在大屏浏览器打开 /display 后，这里会实时列出每块屏幕。</p>
      ) : (
        <div className="cue-screens">
          <div className="cue-screen-row cue-screen-head">
            <label className="cue-check-all">
              <input
                type="checkbox"
                checked={allOnlineSelected}
                onChange={toggleAllOnline}
                disabled={onlineScreens.length === 0}
              />
              全选在线（{onlineScreens.length}/{screens.length}）
            </label>
            <span className="cue-col-status">在线</span>
            <span className="cue-col-cue">最新提示 / 状态</span>
          </div>

          {screens.map((s) => {
            const checked = selected.has(s.id);
            const status = s.cue?.status;
            return (
              <div key={s.id} className={`cue-screen-row ${checked ? 'cue-row-selected' : ''} ${s.online ? '' : 'cue-row-offline'}`}>
                <label className="cue-screen-pick" title={s.id}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(s.id)}
                  />
                  <span className="cue-screen-name">{s.name}</span>
                  {!s.online && <em className="tag cue-tag-offline">离线</em>}
                </label>
                <span className={`cue-col-status cue-dot ${s.online ? 'cue-online' : 'cue-offline'}`}>
                  {s.online ? '● 在线' : '○ 离线'}
                </span>
                <span className="cue-col-cue">
                  {s.cue ? (
                    <>
                      <span className="cue-latest-text">
                        #{s.cue.seq} {s.cue.text}
                      </span>
                      <em className={`tag cue-status-${status}`}>{STATUS_TEXT[status] || status}</em>
                    </>
                  ) : (
                    <span className="cue-none">—</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="cue-send">
        <div className="cue-presets">
          {PRESETS.map((p) => (
            <button
              key={p.type}
              type="button"
              className={`btn ${p.cls}`}
              onClick={() => sendCue(p.type, p.label)}
              disabled={validTargets.length === 0}
              title={validTargets.length === 0 ? '先勾选至少一块投屏' : `向 ${validTargets.length} 块投屏发送“${p.label}”`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="cue-custom">
          <input
            value={custom}
            maxLength={MAX_CUSTOM_LEN}
            placeholder={`自定义提示（最多 ${MAX_CUSTOM_LEN} 字）`}
            onChange={(e) => setCustom(e.target.value.slice(0, MAX_CUSTOM_LEN))}
            onKeyDown={(e) => { if (e.key === 'Enter') sendCustom(); }}
          />
          <span className="cue-counter">{custom.trim().length}/{MAX_CUSTOM_LEN}</span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={sendCustom}
            disabled={!custom.trim() || validTargets.length === 0}
          >
            发送自定义
          </button>
        </div>
      </div>

      {lastError?.code?.startsWith?.('BAD_CUE') || lastError?.code === 'BAD_TARGET' || lastError?.code === 'NO_SCREEN' ? (
        <p className="agenda-error">⚠ {lastError.message}</p>
      ) : null}
      <p className="hint">
        目标可选一块或多块（勾选离线屏会排队，其重连后补发）；
        新提示覆盖旧提示，迟到的旧确认不会改变新提示状态；非目标屏不显示、不能确认。
      </p>
    </fieldset>
  );
}
