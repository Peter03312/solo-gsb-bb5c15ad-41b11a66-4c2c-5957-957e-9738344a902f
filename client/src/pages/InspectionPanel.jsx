import { useEffect, useRef, useState } from 'react';

const MAX_ITEMS = 30;
const MAX_NAME_LEN = 30;
const MAX_AREA_LEN = 30;
const MAX_NOTE_LEN = 100;

const REASON_TEXT = {
  fault: '存在必检项故障',
  pending: '仍有必检项待检',
  recheck: '清单变更后需重新完成全部必检',
  version_changed: '巡检版本已变化，请重新完成必检',
};

function newId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? `i-${crypto.randomUUID()}`
    : `i-${Math.random().toString(36).slice(2, 10)}`;
}

const STATUS_LABEL = { pending: '待检', pass: '通过', fault: '故障' };

// 故障备注输入值：以本地草稿为权威，未输入过时回显该巡检项已登记的故障备注
function noteDraft(notes, id, items) {
  if (Object.prototype.hasOwnProperty.call(notes, id)) return notes[id];
  const it = items.find((x) => x.id === id);
  return it?.status === 'fault' ? it.note : '';
}

// 控制台“设备巡检门禁”面板：
//  - 持有者可维护最多 30 项巡检项（名称 / 区域 / 必检标记），保存后须逐项重新登记；
//  - 持有者逐项登记“通过”或“故障（必填备注）”；
//  - 所有必检项均通过且清单版本未变时门禁放行，服务端才允许开始当前计时；
//  - 任一必检项改回故障、或清单被编辑，门禁立即失效并广播原因（顶部横幅即时提示）；
//  - 投屏不接收任何巡检消息。
export default function InspectionPanel({ inspection, gateEvent, canEdit, send, lastError, onClearError }) {
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState([]);
  const [formError, setFormError] = useState('');
  const [notes, setNotes] = useState({});           // itemId -> 故障备注草稿
  const [flash, setFlash] = useState(null);         // 门禁翻转的瞬时横幅
  const flashTimer = useRef(null);

  const gate = inspection?.gate ?? null;
  const items = inspection?.items ?? [];

  // 进入编辑模式时以权威清单初始化草稿；非编辑态下清单被（本端保存/接管者）替换时同步
  useEffect(() => {
    if (!inspection) return;
    if (!editing) {
      setRows(inspection.items.map((it) => ({
        id: it.id, name: it.name, area: it.area, required: it.required,
      })));
    }
  }, [inspection, editing]);

  // 门禁翻转：红/绿横幅提示 8 秒（放行状态卡片本身始终展示权威状态）
  useEffect(() => {
    if (!gateEvent) return undefined;
    setFlash(gateEvent);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 8000);
    return () => clearTimeout(flashTimer.current);
  }, [gateEvent]);

  // 服务端错误（BAD_INSPECTION / NOT_FOUND / INSPECTION_GATE）展示 5 秒
  const inspectionError = lastError?.code === 'BAD_INSPECTION'
    || lastError?.code === 'NOT_FOUND'
    || lastError?.code === 'INSPECTION_GATE';
  useEffect(() => {
    if (!inspectionError || !onClearError) return undefined;
    const t = setTimeout(onClearError, 5000);
    return () => clearTimeout(t);
  }, [inspectionError, onClearError]);

  if (!inspection || !gate) {
    return (
      <fieldset className="panel" disabled>
        <legend>设备巡检门禁</legend>
        <p className="hint">正在加载巡检状态…</p>
      </fieldset>
    );
  }

  const counts = items.reduce(
    (acc, it) => {
      acc[it.status] += 1;
      if (it.required) acc.required += 1;
      return acc;
    },
    { pending: 0, pass: 0, fault: 0, required: 0 },
  );
  const requiredLeft = items.filter((it) => it.required && it.status !== 'pass').length;
  const faultItem = gate.reason === 'fault' ? gate.reasonItem : null;

  const startEdit = () => {
    setRows(items.map((it) => ({ id: it.id, name: it.name, area: it.area, required: it.required })));
    setFormError('');
    setEditing(true);
  };

  const updateRow = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const removeRow = (i) => setRows((rs) => rs.filter((_, j) => j !== i));
  const addRow = () => setRows((rs) => {
    if (rs.length >= MAX_ITEMS) return rs;
    return [...rs, { id: newId(), name: '', area: '', required: true }];
  });

  const save = () => {
    if (rows.length > MAX_ITEMS) {
      setFormError(`巡检项最多 ${MAX_ITEMS} 项`);
      return;
    }
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i].name.trim()) {
        setFormError(`第 ${i + 1} 项名称不能为空`);
        return;
      }
    }
    setFormError('');
    send({
      command: 'inspection_set',
      items: rows.map((r) => ({
        id: r.id,
        name: r.name.trim().slice(0, MAX_NAME_LEN),
        area: r.area.trim().slice(0, MAX_AREA_LEN),
        required: !!r.required,
      })),
    });
    setEditing(false);
  };

  const register = (id, status) => {
    if (!canEdit) return;
    if (status === 'fault') {
      const note = noteDraft(notes, id, items).trim().slice(0, MAX_NOTE_LEN);
      if (!note) return;
      send({ command: 'inspection_check', id, status: 'fault', note });
      return;
    }
    send({ command: 'inspection_check', id, status: 'pass' });
  };

  const gateCls = !gate.enabled
    ? 'insp-gate insp-gate-off'
    : gate.armed
      ? 'insp-gate insp-gate-armed'
      : 'insp-gate insp-gate-blocked';

  return (
    <fieldset className="panel inspection-panel" disabled={!canEdit}>
      <legend>
        设备巡检门禁（开始当前计时前，持有者须逐项登记；最多 {MAX_ITEMS} 项，必检项全部通过才放行）
      </legend>

      {/* 权威门禁状态卡片 */}
      <div className={gateCls}>
        {!gate.enabled ? (
          <>
            <span className="insp-gate-icon">⚪</span>
            <span className="insp-gate-title">未设置必检项，门禁不拦截开始</span>
            <span className="insp-gate-sub">勾选任一巡检项的“必检”并保存后启用</span>
          </>
        ) : gate.armed ? (
          <>
            <span className="insp-gate-icon">✅</span>
            <span className="insp-gate-title">巡检门禁已放行，可以开始当前计时</span>
            <span className="insp-gate-sub">放行版本 v{inspection.armedSeq ?? inspection.seq}；
              任一必检项改回故障或编辑清单将立即锁定</span>
          </>
        ) : (
          <>
            <span className="insp-gate-icon">⛔</span>
            <span className="insp-gate-title">
              门禁未放行：{REASON_TEXT[gate.reason] ?? '必检项未全部通过'}
            </span>
            <span className="insp-gate-sub">
              {gate.reason === 'fault' && faultItem
                ? <>必检项「{faultItem.name}」登记为故障{faultItem.note ? `：${faultItem.note}` : ''}</>
                : gate.reason === 'pending'
                  ? <>还有 {requiredLeft} 项必检待检/故障待复检</>
                  : '请对全部必检项重新逐项登记通过'}
            </span>
          </>
        )}
      </div>

      {/* 门禁翻转瞬时横幅：服务端广播原因后立即提示 */}
      {flash && (
        <div className={`insp-flash ${flash.armed ? 'insp-flash-armed' : 'insp-flash-blocked'}`}>
          {flash.armed
            ? '✅ 全部必检项通过，巡检门禁已放行'
            : `⛔ 巡检门禁已失效：${flash.reasonText || REASON_TEXT[flash.reason] || '必检项未全部通过'}`}
        </div>
      )}

      <div className="insp-summary">
        <span className="insp-count">共 {items.length}/{MAX_ITEMS} 项</span>
        <span className="insp-count insp-req">必检 {counts.required}</span>
        <span className="insp-count insp-pending">待检 {counts.pending}</span>
        <span className="insp-count insp-pass">通过 {counts.pass}</span>
        <span className="insp-count insp-fault">故障 {counts.fault}</span>
        {!editing && (
          <button type="button" className="btn btn-mini insp-edit-btn" onClick={startEdit}>
            ✎ 维护巡检项
          </button>
        )}
      </div>

      {/* ---- 编辑态：维护名称 / 区域 / 必检 ---- */}
      {editing ? (
        <>
          <div className="insp-edit-table" role="table">
            <div className="insp-row insp-head" role="row">
              <span>#</span>
              <span>巡检项名称</span>
              <span>区域</span>
              <span>必检</span>
              <span>操作</span>
            </div>
            {rows.map((r, i) => (
              <div className="insp-row" role="row" key={r.id}>
                <span className="insp-idx">{i + 1}</span>
                <span>
                  <input
                    value={r.name}
                    maxLength={MAX_NAME_LEN}
                    placeholder={`巡检项 ${i + 1}`}
                    onChange={(e) => updateRow(i, { name: e.target.value.slice(0, MAX_NAME_LEN) })}
                  />
                </span>
                <span>
                  <input
                    value={r.area}
                    maxLength={MAX_AREA_LEN}
                    placeholder="如：主席台 / 入口"
                    onChange={(e) => updateRow(i, { area: e.target.value.slice(0, MAX_AREA_LEN) })}
                  />
                </span>
                <span className="insp-required-cell">
                  <label title="必检项全部登记通过后，服务端才允许开始当前计时">
                    <input
                      type="checkbox"
                      checked={!!r.required}
                      onChange={(e) => updateRow(i, { required: e.target.checked })}
                    />
                    必检
                  </label>
                </span>
                <span className="insp-ops">
                  <button type="button" className="btn btn-mini btn-danger" onClick={() => removeRow(i)}>删</button>
                </span>
              </div>
            ))}
            {rows.length === 0 && <p className="hint">清单为空：不设必检项时门禁不拦截开始。</p>}
          </div>
          <div className="insp-actions">
            <button type="button" className="btn" onClick={addRow} disabled={rows.length >= MAX_ITEMS}>
              ＋ 添加巡检项（{rows.length}/{MAX_ITEMS}）
            </button>
            <button type="button" className="btn btn-primary" onClick={save}>保存清单</button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => { setEditing(false); setFormError(''); }}
            >
              取消
            </button>
          </div>
          <p className="hint hint-warn">
            保存（清单内容有任何变化）后，所有巡检项的登记状态将重置为“待检”、门禁立即失效，
            需逐项重新登记、全部必检项复检通过后才再次放行。
          </p>
          {formError && <p className="agenda-error">⚠ {formError}</p>}
        </>
      ) : (
        /* ---- 登记态：逐项登记通过 / 故障备注 ---- */
        <div className="insp-check-list">
          {items.length === 0 && (
            <p className="hint">
              尚未配置巡检项。点“维护巡检项”添加（如：麦克风 / 主席台、应急照明 / 通道），
              勾选“必检”的项目必须全部登记通过才允许开始计时。
            </p>
          )}
          {items.map((it, i) => (
            <div key={it.id} className={`insp-item insp-item-${it.status}`}>
              <span className="insp-item-idx">{i + 1}</span>
              <span className="insp-item-main">
                <span className="insp-item-name">
                  {it.required && <em className="insp-star" title="必检">★</em>}
                  {it.name}
                </span>
                {it.area && <span className="insp-item-area">📍 {it.area}</span>}
                {it.status === 'fault' && <span className="insp-item-note">故障备注：{it.note}</span>}
              </span>
              <span className={`insp-status insp-status-${it.status}`}>{STATUS_LABEL[it.status]}</span>
              <span className="insp-item-ops">
                <button
                  type="button"
                  className={`btn btn-mini ${it.status === 'pass' ? 'btn-pass-on' : 'btn-pass'}`}
                  disabled={!canEdit || it.status === 'pass'}
                  onClick={() => register(it.id, 'pass')}
                  title="登记为通过"
                >
                  ✓ 通过
                </button>
                <input
                  className="insp-note-input"
                  value={noteDraft(notes, it.id, items)}
                  maxLength={MAX_NOTE_LEN}
                  disabled={!canEdit}
                  placeholder={it.status === 'fault' ? '更新故障备注后重新登记' : '故障现象/处理（必填）'}
                  onChange={(e) => setNotes((m) => ({ ...m, [it.id]: e.target.value.slice(0, MAX_NOTE_LEN) }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') register(it.id, 'fault'); }}
                />
                <button
                  type="button"
                  className="btn btn-mini btn-fault"
                  disabled={!canEdit || !noteDraft(notes, it.id, items).trim()}
                  onClick={() => register(it.id, 'fault')}
                  title="必检项登记为故障后，门禁立即失效"
                >
                  ✕ 故障
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {inspectionError && <p className="agenda-error">⚠ {lastError.message}</p>}

      <p className="hint">
        门禁由服务端权威判定：仅当全部必检项为“通过”、且放行所依据的清单版本（v{inspection.seq}）未变化时，
        “开始当前计时”才会被接受；暂停后“继续”以及结束本环节自动进入下一环节不受门禁限制。
        巡检数据仅存服务端内存，服务 / 容器重启即清空。投屏不显示巡检信息。
      </p>
    </fieldset>
  );
}
