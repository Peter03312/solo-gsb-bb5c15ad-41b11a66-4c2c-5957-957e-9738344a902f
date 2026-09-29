import { useEffect, useRef, useState } from 'react';
import { useSocket } from '../useSocket.js';
import {
  formatTime,
  formatClock,
  formatSessionClock,
  liveRemaining,
  liveAgenda,
} from '../time.js';
import { loadScreen, saveScreenName } from '../screen.js';

const MODULE_ORDER = ['countdown', 'agenda', 'cue', 'markers'];
const MAX_MARKERS_SHOWN = 6;

// 投屏页：按控制台编排的“当前场景”一次性替换画面。
// 场景包含倒计时 / 议程 / 提示 / 标记摘要四个模块及布局参数（stack | grid）。
// 未收到场景前以“标准投屏”（倒计时+议程）兜底；提示模块未启用时保留原全屏覆盖行为。
export default function DisplayPage() {
  // 仅初始化一次：WebSocket 重连时反复使用同一身份注册
  const screenRef = useRef(null);
  if (!screenRef.current) screenRef.current = loadScreen();
  const {
    snap, connState, cue, scene, screenConflict, renameScreen, ackCue,
  } = useSocket({ role: 'display', screenRef: screenRef.current });
  const [, force] = useState(0);

  // 100ms 重绘：对 running 快照做本地插值，保证大屏数字与议程预计时间平滑
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 100);
    return () => clearInterval(t);
  }, []);

  const layout = scene?.scene?.layout ?? 'stack';
  const modules = scene?.scene?.modules ?? null;
  const enabled = (key) => !modules || modules[key]?.enabled; // 无场景时默认倒计时+议程
  const sizeOf = (key) => modules?.[key]?.size ?? 'md';
  const activeModules = MODULE_ORDER.filter(enabled);

  // 提示模块未启用时，后台提示仍走原“全屏覆盖”通道（不丢提示）；
  // 启用时提示作为场景模块内联展示（不再遮挡其他模块）。
  const cueInline = !!modules?.cue?.enabled && !!cue;

  useEffect(() => {
    document.title = cue
      ? `${cue.text} · 后台提示`
      : snap
        ? `${formatTime(liveRemaining(snap))} · 发言计时`
        : '发言计时投屏';
  });

  const rootClass = cue
    ? 'display display-cue-mode'
    : snap?.finished
      ? 'display display-finished'
      : snap?.warning
        ? 'display display-warning'
        : snap?.phase === 'idle'
          ? 'display display-idle'
          : 'display display-running';

  return (
    <div className={rootClass}>
      {connState !== 'open' && (
        <div className="reconnect-banner">
          {connState === 'reconnecting' ? '网络中断，正在重连并同步当前场景…' : '连接中…'}
        </div>
      )}

      {screenConflict && (
        <div className="screen-conflict-banner">
          此屏幕身份已被新打开的投屏页顶替，本页面不再接收提示；请关闭重复页面后刷新本页。
        </div>
      )}

      {cue && !modules?.cue?.enabled ? (
        <CueOverlay cue={cue} onAck={() => ackCue(cue.cueSeq)} />
      ) : (
        <div className={`scene-stage scene-${layout}`}>
          {activeModules.map((key) => {
            const size = sizeOf(key);
            return (
              <section
                key={key}
                className={`scene-module scene-mod-${key} scene-size-${size}`}
                data-module={key}
              >
                {key === 'countdown' && <CountdownModule snap={snap} />}
                {key === 'agenda' && <AgendaModule snap={snap} />}
                {key === 'cue' && (
                  <CueModule
                    cue={cue}
                    onAck={() => cue && ackCue(cue.cueSeq)}
                    inline={cueInline}
                  />
                )}
                {key === 'markers' && <MarkersModule markers={scene?.markers ?? []} />}
              </section>
            );
          })}
        </div>
      )}

      <ScreenNameChip
        screenRef={screenRef}
        renameScreen={renameScreen}
        sceneName={scene?.scene?.name ?? null}
        activeVersion={scene?.activeVersion ?? null}
      />
    </div>
  );
}

// ---------------- 模块一：倒计时（当前环节 / 剩余时间 / 状态） ----------------
function CountdownModule({ snap }) {
  if (!snap) {
    return (
      <>
        <div className="display-time">--:--</div>
        <div className="display-state">等待连接…</div>
      </>
    );
  }
  const remaining = liveRemaining(snap);
  const agenda = liveAgenda(snap);
  const cur = agenda?.items.find((it) => it.status === 'current') ?? null;

  return (
    <>
      {cur && (
        <div className="display-current">
          <span className="display-current-name">{cur.name}</span>
          {cur.fixed && <span className="display-pin">📌 固定环节</span>}
          {cur.insufficient && <span className="display-short">⚠ 时间不足</span>}
        </div>
      )}

      <div className="display-phase">{phaseText(snap.phase)}</div>

      <div className="display-time">
        {snap.finished ? '00:00' : formatTime(remaining, { tenths: snap.warning && snap.phase === 'running' })}
      </div>

      <div className="display-state">
        {snap.finished
          ? '时间到'
          : snap.phase === 'idle'
            ? '待开始'
            : snap.phase === 'paused'
              ? '已暂停'
              : snap.warning
                ? '剩余不足 1 分钟'
                : '发言进行中'}
      </div>
    </>
  );
}

// ---------------- 模块二：议程（当前 / 下一环节及预计开始时间） ----------------
function AgendaModule({ snap }) {
  if (!snap) return <div className="scene-empty">等待连接…</div>;
  const agenda = liveAgenda(snap);
  const cur = agenda?.items.find((it) => it.status === 'current') ?? null;
  const curIdx = cur ? agenda.items.findIndex((it) => it.id === cur.id) : -1;
  const next = curIdx >= 0 ? agenda.items[curIdx + 1] ?? null : null;

  return (
    <div className="agenda-module-body">
      <div className="scene-module-title">议程</div>
      {cur && (
        <div className="agenda-mod-current">
          <span className="agenda-mod-label">当前</span>
          <span className="agenda-mod-name">{cur.name}{cur.fixed ? ' 📌' : ''}</span>
          {cur.insufficient && <span className="display-short">⚠ 时间不足</span>}
        </div>
      )}
      {next ? (
        <div className={`display-next ${next.insufficient ? 'display-next-short' : ''}`}>
          <span className="display-next-label">下一环节</span>
          <span className="display-next-name">{next.name}{next.fixed ? ' 📌' : ''}</span>
          <span className="display-next-time">预计开始 {formatClock(next.projStartMs)}</span>
        </div>
      ) : cur ? (
        <div className="display-next">
          <span className="display-next-label">本环节为最后一项</span>
        </div>
      ) : (
        <div className="display-duration">设定时长 {formatTime(snap.durationMs)}</div>
      )}
    </div>
  );
}

// ---------------- 模块三：提示（最新后台提示内联展示，可现场确认） ----------------
function CueModule({ cue, onAck }) {
  if (!cue) {
    return (
      <div className="cue-module cue-module-empty">
        <div className="scene-module-title">后台提示</div>
        <div className="cue-module-none">暂无后台提示</div>
      </div>
    );
  }
  const typeLabel = {
    stage: '请上场',
    hurry: '加快',
    finish: '结束',
    custom: '后台提示',
  }[cue.cueType] || '后台提示';

  return (
    <div className={`cue-module cue-inline cue-${cue.cueType}`}>
      <div className="cue-overlay-label">{typeLabel}</div>
      <div className="cue-inline-text">{cue.text}</div>
      <button type="button" className="cue-ack-btn" onClick={onAck}>
        ✓ 确认收到
      </button>
      <div className="cue-overlay-hint">#{cue.cueSeq} · 控制台后台提示</div>
    </div>
  );
}

// ---------------- 模块四：标记摘要（本场会话最近现场标记时间线） ----------------
function MarkersModule({ markers }) {
  const recent = markers.slice(-MAX_MARKERS_SHOWN).reverse();
  return (
    <div className="markers-module">
      <div className="scene-module-title">
        现场标记摘要{markers.length > MAX_MARKERS_SHOWN ? `（最近 ${MAX_MARKERS_SHOWN}/${markers.length} 条）` : ''}
      </div>
      {recent.length === 0 ? (
        <div className="scene-empty">本场会话暂无标记</div>
      ) : (
        <ol className="markers-mod-list">
          {recent.map((m) => (
            <li key={m.seq} className="markers-mod-item">
              <span className="markers-mod-time">T+{formatSessionClock(m.sessionElapsedMs)}</span>
              <span className="markers-mod-name">{m.name}</span>
              {m.itemName && <span className="markers-mod-item">📍 {m.itemName}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// 后台提示全屏覆盖层（提示模块未启用时的原有行为）：现场人员按“确认收到”后收起
function CueOverlay({ cue, onAck }) {
  const typeLabel = {
    stage: '请上场',
    hurry: '加快',
    finish: '结束',
    custom: '后台提示',
  }[cue.cueType] || '后台提示';

  return (
    <div className={`cue-overlay cue-${cue.cueType}`}>
      <div className="cue-overlay-label">{typeLabel}</div>
      <div className="cue-overlay-text">{cue.text}</div>
      <button type="button" className="cue-ack-btn" onClick={onAck}>
        ✓ 确认收到
      </button>
      <div className="cue-overlay-hint">#{cue.cueSeq} · 控制台后台提示</div>
    </div>
  );
}

// 左下角显示名设置（持久 ID 不展示全文，悬停可见）；右上角展示当前场景名
function ScreenNameChip({ screenRef, renameScreen, sceneName, activeVersion }) {
  const screen = screenRef.current;
  const [nameDraft, setNameDraft] = useState(screen.name);
  const [editing, setEditing] = useState(false);

  const commit = () => {
    const name = nameDraft.trim().slice(0, 20) || screen.name;
    saveScreenName(screen.id, name);
    screen.name = name;
    setNameDraft(name);
    setEditing(false);
    renameScreen(name);
  };

  return (
    <>
      {sceneName && (
        <div className="display-scene-chip" title={`当前场景版本 v${activeVersion}`}>
          🎬 {sceneName} · v{activeVersion}
        </div>
      )}
      <div className="display-screen-chip" title={`屏幕 ID（刷新不变）：${screen.id}`}>
        {editing ? (
          <span className="screen-name-edit">
            <input
              autoFocus
              value={nameDraft}
              maxLength={20}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') { setNameDraft(screen.name); setEditing(false); }
              }}
            />
            <button type="button" className="btn btn-mini btn-primary" onClick={commit}>保存</button>
            <button
              type="button"
              className="btn btn-mini"
              onClick={() => { setNameDraft(screen.name); setEditing(false); }}
            >
              取消
            </button>
          </span>
        ) : (
          <span className="screen-name-view">
            🖥 {screen.name}
            <button type="button" className="screen-name-btn" onClick={() => setEditing(true)}>
              设置显示名
            </button>
          </span>
        )}
      </div>
    </>
  );
}

function phaseText(phase) {
  return { idle: 'READY', running: 'SPEAKING', paused: 'PAUSED', finished: 'TIME UP' }[phase] || '';
}
