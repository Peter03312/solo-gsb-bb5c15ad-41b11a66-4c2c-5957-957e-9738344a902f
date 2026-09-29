import { useEffect, useRef, useState } from 'react';
import { useSocket } from '../useSocket.js';
import { formatTime, formatClock, formatDeviation, liveRemaining, liveAgenda } from '../time.js';
import AgendaPanel from './AgendaPanel.jsx';
import CuePanel from './CuePanel.jsx';
import ScenePanel from './ScenePanel.jsx';
import MarkerPanel from './MarkerPanel.jsx';
import InspectionPanel from './InspectionPanel.jsx';
import DevicePanel from './DevicePanel.jsx';
import RehearsalPanel from './RehearsalPanel.jsx';
import HandoverPanel from './HandoverPanel.jsx';

// 控制台：同一时刻全服务仅一个实例可持有控制权。
export default function ConsolePage() {
  const {
    snap, screens, markers, inspection, gateEvent, devices, connState, control, myId, handover, lastError,
    sceneLib,
    send, acquire, release, clearError,
    createHandover, cancelHandover, redeemHandover, clearHandover,
  } = useSocket({ role: 'console' });
  const [minutes, setMinutes] = useState(5);
  const [seconds, setSeconds] = useState(0);
  const [, force] = useState(0);

  // 100ms 重绘运行中的预览时间与议程推演
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 100);
    return () => clearInterval(t);
  }, []);

  // 首次收到快照时用服务端时长回填输入框
  const hydrated = useRef(false);
  if (!hydrated.current && snap) {
    hydrated.current = true;
    setMinutes(Math.floor(snap.durationMs / 60000));
    setSeconds(Math.round((snap.durationMs % 60000) / 1000));
  }

  const phase = snap?.phase ?? 'idle';
  const durationMs = Math.max(1000, (Number(minutes) || 0) * 60000 + (Number(seconds) || 0) * 1000);

  const applyDuration = () => send({ command: 'set_duration', durationMs });
  const cmd = (command, extra = {}) => send({ command, ...extra });

  const remaining = snap ? liveRemaining(snap) : 0;
  const agenda = snap ? liveAgenda(snap) : null;
  const curRow = agenda?.items.find((it) => it.status === 'current') ?? null;
  const curIdx = agenda ? agenda.items.findIndex((it) => it.id === agenda.currentId) : -1;
  const nextRow = curIdx >= 0 ? agenda.items[curIdx + 1] ?? null : null;

  // 设备巡检门禁：仅拦截“从零开始”（idle/finished），暂停后的继续不受影响
  const gate = inspection?.gate ?? null;
  const startBlocked = (phase === 'idle' || phase === 'finished')
    && !!gate && gate.enabled && !gate.armed;
  const startBlockTitle = startBlocked
    ? `巡检门禁未放行：${gate.reason === 'fault'
      ? '存在必检项故障'
      : gate.reason === 'pending'
        ? '仍有必检项待检'
        : '清单变更后需重新完成全部必检'}`
    : '';

  return (
    <div className="console">
      <header className="console-header">
        <h1>发言计时 · 控制台</h1>
        <div className="badges">
          <span className={`badge badge-${connState}`}>
            {connState === 'open' ? '● 已连接' : connState === 'reconnecting' ? '● 重连中' : '● 连接中'}
          </span>
          {control.granted ? (
            <span className="badge badge-held">🎙 持有控制权</span>
          ) : (
            <span className="badge badge-locked">🔒 未持有控制权</span>
          )}
        </div>
      </header>

      {!control.granted && (
        <section className="lock-panel">
          {control.locked ? (
            <>
              <p>已有其他控制台持有控制权，需等待其释放或失联（约 15 秒无心跳）后自动释放；
                也可请持有者生成<b>交接码</b>，输入后立即无缝接管。</p>
              {handover && (
                <HandoverPanel
                  variant="receiver"
                  myId={myId}
                  handover={handover}
                  onRedeem={redeemHandover}
                  onClearResult={clearHandover}
                  lastError={lastError}
                />
              )}
              <button className="btn" onClick={acquire}>重新申请控制权</button>
              {control.reason === 'reconnect' && <p className="hint">网络重连后将自动重新申请。</p>}
              {control.reason === 'handover' && (
                <p className="hint hint-handover">控制权已通过交接码转移给另一台控制台；交接码立即失效。</p>
              )}
            </>
          ) : (
            <>
              <p>当前无控制台持有控制权。</p>
              <button className="btn btn-primary" onClick={acquire}>申请控制权</button>
            </>
          )}
        </section>
      )}

      <section className={`preview ${snap?.finished ? 'preview-finished' : snap?.warning ? 'preview-warning' : ''}`}>
        <div className="preview-time">
          {snap ? formatTime(remaining, { tenths: snap.warning && phase === 'running' }) : '--:--'}
        </div>
        <div className="preview-state">{stateLabel(phase, snap?.warning, snap?.finished)}</div>
        <div className="preview-meta">
          {curRow ? (
            <>
              当前环节 <b>{curRow.name}</b>
              {curRow.fixed && <span className="pin"> 📌固定</span>}
              {' '}· 偏差 <b className={deviationClass(agenda.deviationMs)}>
                {formatDeviation(agenda.deviationMs)}
              </b>
              {curRow.insufficient && <span className="tag tag-short">时间不足</span>}
            </>
          ) : (
            '尚未设定当前环节（在下方议程中选择）'
          )}
        </div>
      </section>

      {curRow && (
        <section className="panel next-panel">
          <div className="next-item">
            <span className="next-label">下一环节</span>
            {nextRow ? (
              <>
                <span className="next-name">{nextRow.name}{nextRow.fixed && ' 📌'}</span>
                <span className={`next-time ${nextRow.insufficient ? 'proj-short' : ''}`}>
                  预计开始 {formatClock(nextRow.projStartMs)}
                </span>
                {nextRow.insufficient && <span className="tag tag-short">时间不足</span>}
              </>
            ) : (
              <span className="next-name">已是最后一项</span>
            )}
          </div>
        </section>
      )}

      <InspectionPanel
        inspection={inspection}
        gateEvent={gateEvent}
        canEdit={control.granted}
        send={send}
        lastError={lastError}
        onClearError={clearError}
      />

      <fieldset className="panel" disabled={!control.granted}>
        <legend>计时控制</legend>
        <div className="controls">
          <button
            className="btn btn-start"
            onClick={() => cmd('start')}
            disabled={phase === 'running' || startBlocked}
            title={startBlocked ? startBlockTitle : '待开始/超时后开始需先通过巡检门禁'}
          >
            ▶ 开始
          </button>
          <button
            className="btn btn-pause"
            onClick={() => cmd('pause')}
            disabled={phase !== 'running'}
          >
            ⏸ 暂停
          </button>
          <button
            className="btn btn-resume"
            onClick={() => cmd('resume')}
            disabled={phase !== 'paused'}
          >
            ⏵ 继续
          </button>
          <button
            className="btn btn-advance"
            onClick={() => cmd('advance')}
            disabled={phase === 'idle' || !agenda?.currentId}
            title={phase === 'idle' || !agenda?.currentId
              ? '设定当前环节并开始后，可提前结束或超时结束本环节'
              : '按当前实际结束点推演后续环节，并自动进入下一环节'}
          >
            ⏭ 结束本环节 / 进入下一环节
          </button>
          <button className="btn btn-reset" onClick={() => cmd('reset', { durationMs })}>
            ⟲ 重置当前环节
          </button>
        </div>
        {snap?.finished && agenda?.currentId && (
          <p className="hint hint-overtime">
            已超时：偏差正逐秒累积，后续普通环节预计开始时间持续后移；点击“结束本环节”固化顺延。
          </p>
        )}
        {startBlocked && (
          <p className="hint hint-gate">
            ⛔ {startBlockTitle}。请在上方“设备巡检门禁”面板逐项登记，全部必检项通过后方可开始。
          </p>
        )}
      </fieldset>

      <fieldset className="panel" disabled={!control.granted}>
        <legend>设定时长（手动覆盖当前环节时长）</legend>
        <div className="duration-inputs">
          <label>
            分
            <input
              type="number"
              min="0"
              max="1440"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </label>
          <label>
            秒
            <input
              type="number"
              min="0"
              max="59"
              step="5"
              value={seconds}
              onChange={(e) => setSeconds(e.target.value)}
            />
          </label>
          <button
            className="btn"
            onClick={applyDuration}
            disabled={phase === 'running'}
            title={phase === 'running' ? '运行中请先暂停/重置' : '应用新时长（画面回到待开始）'}
          >
            应用时长
          </button>
        </div>
        <p className="hint">运行中不可修改时长；应用新时长会回到待开始状态。</p>
      </fieldset>

      <MarkerPanel
        markers={markers}
        canEdit={control.granted}
        send={send}
        lastError={lastError}
      />

      <CuePanel
        screens={screens}
        canSend={control.granted}
        send={send}
        lastError={lastError}
      />

      <ScenePanel
        sceneLib={sceneLib}
        screens={screens}
        canEdit={control.granted}
        send={send}
        lastError={lastError}
        onClearError={clearError}
      />

      <AgendaPanel
        snap={snap}
        canEdit={control.granted}
        send={send}
        lastError={lastError}
        onClearError={clearError}
      />

      <DevicePanel
        devices={devices}
        snap={snap}
        canEdit={control.granted}
        send={send}
        lastError={lastError}
        onClearError={clearError}
      />

      <RehearsalPanel snap={snap} devices={devices} connState={connState} />

      {control.granted && (
        <>
          <HandoverPanel
            variant="holder"
            myId={myId}
            handover={handover}
            canCreate={control.granted}
            onCreate={createHandover}
            onCancel={cancelHandover}
            onClearResult={clearHandover}
            lastError={lastError}
          />
          <div className="release-row">
            <button className="btn btn-ghost" onClick={release}>释放控制权（供其他控制台接管）</button>
          </div>
        </>
      )}

      <p className="foot-tip">投屏地址：<a href="/display" target="_blank" rel="noreferrer">/display</a>（可多屏打开）</p>
    </div>
  );
}

function deviationClass(ms) {
  if (Math.abs(ms) < 1000) return 'dev-ok';
  return ms < 0 ? 'dev-early' : 'dev-late';
}

function stateLabel(phase, warning, finished) {
  if (finished) return '时间到';
  if (phase === 'idle') return '待开始';
  if (phase === 'paused') return '已暂停';
  return warning ? '剩余不足 1 分钟' : '发言进行中';
}
