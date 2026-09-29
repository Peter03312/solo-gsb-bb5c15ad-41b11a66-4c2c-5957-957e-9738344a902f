import { useEffect, useRef, useState } from 'react';
import { MODULE_KEYS, MODULE_LABELS, MODULE_SIZES, LAYOUTS, MAX_SCENES } from '../sceneMeta.js';

// 控制台“投屏场景编排”面板：
//  - 持有者保存最多 8 个场景：每场景选择倒计时/议程/提示/标记摘要模块、模块尺寸与布局；
//  - “切换并广播”产生新的场景版本，服务端生成完整快照原子广播给所有投屏；
//  - 逐屏显示当前切换的确认状态（未确认/已确认，在线屏才参与本轮确认）；
//  - 编辑只存本地草稿，保存场景库后不直接换画面，需再切换才重新发布；
//    权威场景库（seq）回来后自动对账，避免覆盖接管者的修改。

function newId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? `sc-${crypto.randomUUID()}`
    : `sc-${Math.random().toString(36).slice(2, 10)}`;
}

function toDraft(scene) {
  return {
    id: scene.id,
    name: scene.name,
    layout: scene.layout,
    modules: MODULE_KEYS.map((key) => ({
      key,
      enabled: !!scene.modules[key]?.enabled,
      size: scene.modules[key]?.size ?? 'md',
    })),
  };
}

function blankScene(index) {
  return {
    id: newId(),
    name: `场景 ${index + 1}`,
    layout: 'stack',
    modules: MODULE_KEYS.map((key, i) => ({
      key,
      enabled: i === 0, // 默认仅倒计时
      size: i === 0 ? 'lg' : 'md',
    })),
  };
}

function draftToWire(draft) {
  const modules = {};
  for (const m of draft.modules) modules[m.key] = { enabled: m.enabled, size: m.size };
  return { id: draft.id, name: draft.name.trim() || draft.id, layout: draft.layout, modules };
}

const MODULE_HINTS = {
  countdown: '当前环节与倒计时',
  agenda: '当前/下一环节与预计开始',
  cue: '最新后台提示内联，可现场确认',
  markers: '本场会话最近标记时间线',
};

export default function ScenePanel({ sceneLib, screens, canEdit, send, lastError, onClearError }) {
  const [drafts, setDrafts] = useState([]);
  const [hydrated, setHydrated] = useState(false);
  const [savedSeq, setSavedSeq] = useState(0);
  const [formError, setFormError] = useState('');
  const lastSeqRef = useRef(0);

  // 权威场景库（首包 / 保存被接纳 / 被接管者改写）回填本地草稿
  useEffect(() => {
    if (!sceneLib) return;
    if (!hydrated || sceneLib.seq !== lastSeqRef.current) {
      lastSeqRef.current = sceneLib.seq;
      setDrafts(sceneLib.scenes.map(toDraft));
      setSavedSeq(sceneLib.seq);
      setHydrated(true);
      setFormError('');
    }
  }, [sceneLib, hydrated]);

  // 服务端错误（BAD_SCENE / NOT_FOUND）展示 4 秒
  useEffect(() => {
    if (!lastError || !String(lastError.code || '').startsWith('BAD_SCENE')) return undefined;
    const t = setTimeout(onClearError, 4000);
    return () => clearTimeout(t);
  }, [lastError, onClearError]);

  if (!hydrated || !sceneLib) {
    return (
      <fieldset className="panel" disabled>
        <legend>投屏场景编排</legend>
        <p className="hint">正在加载场景…</p>
      </fieldset>
    );
  }

  // 草稿与权威库不一致，或保存后库版本领先：均视为待保存
  const dirty = sceneLib.seq !== savedSeq
    || JSON.stringify(sceneLib.scenes.map(toDraft)) !== JSON.stringify(drafts);

  const updateScene = (i, patch) => setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const updateModule = (si, mi, patch) => setDrafts((ds) => ds.map((d, j) => {
    if (j !== si) return d;
    return { ...d, modules: d.modules.map((m, k) => (k === mi ? { ...m, ...patch } : m)) };
  }));
  const addScene = () => setDrafts((ds) => (ds.length >= MAX_SCENES ? ds : [...ds, blankScene(ds.length)]));
  const removeScene = (i) => setDrafts((ds) => ds.filter((_, j) => j !== i));

  const saveLibrary = () => {
    if (drafts.length === 0) {
      setFormError('至少保留 1 个场景');
      return;
    }
    for (let i = 0; i < drafts.length; i++) {
      const name = drafts[i].name.trim();
      if (name.length === 0 || name.length > 20) {
        setFormError(`第 ${i + 1} 个场景名称需为 1~20 字`);
        return;
      }
      if (!drafts[i].modules.some((m) => m.enabled)) {
        setFormError(`「${name}」至少需要启用一个模块`);
        return;
      }
    }
    setFormError('');
    send({ command: 'scene_set', scenes: drafts.map(draftToWire) });
  };

  const activate = (id) => send({ command: 'scene_activate', id });

  // 各屏对“当前激活版本”的确认状态
  const onlineScreens = screens.filter((s) => s.online);
  const confirmedScreens = onlineScreens.filter((s) => s.sceneVersion === sceneLib.activeVersion);
  const pendingScreens = onlineScreens.filter((s) => s.sceneVersion !== sceneLib.activeVersion);
  const switchDone = onlineScreens.length > 0 && pendingScreens.length === 0;

  return (
    <fieldset className="panel scene-panel" disabled={!canEdit}>
      <legend>投屏场景编排（最多 {MAX_SCENES} 个场景；切换按版本原子广播，投屏一次性替换）</legend>

      <div className="scene-activate-bar">
        <div className="scene-active-info">
          当前激活：
          <b>{sceneLib.scenes.find((s) => s.id === sceneLib.activeId)?.name ?? '—'}</b>
          <em className="tag scene-version-tag">v{sceneLib.activeVersion}</em>
          {sceneLib.activeSeq !== sceneLib.seq && (
            <em className="tag tag-short" title="场景库在当前激活之后又被编辑过，需重新切换才会发布到投屏">
              有未发布修改
            </em>
          )}
        </div>
        <div className={`scene-confirm-summary ${switchDone ? 'scene-confirm-ok' : 'scene-confirm-wait'}`}>
          各屏确认：已确认 {confirmedScreens.length}/{onlineScreens.length}
          {onlineScreens.length === 0 && <span className="hint">（当前无在线投屏）</span>}
          {!switchDone && onlineScreens.length > 0 && <span className="tag cue-tag-offline">切换中</span>}
        </div>
      </div>

      {screens.length > 0 && (
        <div className="scene-screen-acks">
          {screens.map((s) => {
            const confirmed = s.online && s.sceneVersion === sceneLib.activeVersion;
            return (
              <span
                key={s.id}
                className={`scene-screen-ack ${s.online ? '' : 'scene-ack-offline'} ${confirmed ? 'scene-ack-yes' : 'scene-ack-no'}`}
                title={s.online
                  ? (confirmed ? `已确认切换到 v${sceneLib.activeVersion}` : '尚未确认当前场景（旧画面/切换中）')
                  : '离线：重连注册后自动恢复当前场景并确认'}
              >
                {confirmed ? '✓' : s.online ? '◌' : '○'} {s.name}
              </span>
            );
          })}
        </div>
      )}

      <div className="scene-cards">
        {drafts.map((d, si) => {
          const isActive = sceneLib.activeId === d.id;
          return (
            <div key={d.id} className={`scene-card ${isActive ? 'scene-card-active' : ''}`}>
              <div className="scene-card-head">
                <span className="scene-card-idx">场景 {si + 1}</span>
                <input
                  className="scene-name-input"
                  value={d.name}
                  maxLength={20}
                  placeholder={`场景 ${si + 1}`}
                  onChange={(e) => updateScene(si, { name: e.target.value.slice(0, 20) })}
                />
                {isActive && <em className="tag tag-now">当前</em>}
                <button
                  type="button"
                  className="btn btn-mini btn-danger"
                  onClick={() => removeScene(si)}
                  disabled={drafts.length <= 1}
                  title={drafts.length <= 1 ? '至少保留 1 个场景' : '删除该场景'}
                >
                  删
                </button>
              </div>

              <div className="scene-card-modules">
                {d.modules.map((m, mi) => (
                  <label key={m.key} className={`scene-mod-row ${m.enabled ? 'scene-mod-on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={m.enabled}
                      onChange={(e) => updateModule(si, mi, { enabled: e.target.checked })}
                    />
                    <span className="scene-mod-name">{MODULE_LABELS[m.key]}</span>
                    <select
                      value={m.size}
                      disabled={!m.enabled}
                      onChange={(e) => updateModule(si, mi, { size: e.target.value })}
                      title="模块布局尺寸"
                    >
                      {MODULE_SIZES.map((sz) => (
                        <option key={sz} value={sz}>
                          {sz === 'sm' ? '小' : sz === 'md' ? '中' : '大'}
                        </option>
                      ))}
                    </select>
                    <span className="scene-mod-hint">{MODULE_HINTS[m.key]}</span>
                  </label>
                ))}
              </div>

              <div className="scene-card-foot">
                <label className="scene-layout-pick">
                  布局
                  <select value={d.layout} onChange={(e) => updateScene(si, { layout: e.target.value })}>
                    {LAYOUTS.map((l) => (
                      <option key={l} value={l}>{l === 'stack' ? '纵向排布' : '网格排布'}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="btn btn-primary btn-mini"
                  onClick={() => activate(d.id)}
                  title="按新场景版本生成完整快照并原子广播给所有在线投屏"
                >
                  ⏻ 切换并广播
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="scene-actions">
        <button type="button" className="btn" onClick={addScene} disabled={drafts.length >= MAX_SCENES}>
          ＋ 添加场景（{drafts.length}/{MAX_SCENES}）
        </button>
        <button type="button" className="btn btn-primary" onClick={saveLibrary} disabled={!dirty}>
          {dirty ? '保存场景库' : '场景库已保存'}
        </button>
      </div>

      {(formError || (lastError && String(lastError.code || '').startsWith('BAD_SCENE'))) && (
        <p className="agenda-error">⚠ {formError || lastError.message}</p>
      )}
      <p className="hint">
        保存场景库只更新编排内容；点“切换并广播”后服务端按新版本生成完整快照并原子广播，
        投屏一次性替换，断线重连自动恢复当前场景。切换不清空未确认提示；
        旧场景的迟到消息按版本丢弃，不会覆盖新画面。
      </p>
    </fieldset>
  );
}
