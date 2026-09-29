import { useEffect, useRef, useState } from 'react';
import { formatClock } from '../time.js';

const MAX_DEVICES = 20;
const MAX_NAME_LEN = 30;
const MAX_TURNAROUND_MIN = 24 * 60;

function newId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? `d-${crypto.randomUUID()}`
    : `d-${Math.random().toString(36).slice(2, 10)}`;
}

// 缺口/空当毫秒格式化：正数“间隔 5 分”，0“背靠背”，负数“重叠 3 分”
function formatGap(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const abs = Math.abs(ms);
  if (abs < 1000) return '背靠背';
  const min = Math.round(abs / 60000);
  const text = min >= 1 ? `${min} 分` : `${Math.round(abs / 1000)} 秒`;
  return ms < 0 ? `重叠 ${text}` : `间隔 ${text}`;
}

// 缺口分钟数（冲突 shortfall：还需补多少周转缓冲）
function formatShortfall(ms) {
  if (ms == null || ms <= 0) return null;
  const min = Math.round(ms / 60000);
  return min >= 1 ? `缺口 ${min} 分` : `缺口 ${Math.round(ms / 1000)} 秒`;
}

// 控制台“设备占用”面板：
//  - 持有者维护最多 20 项共享设备（名称 / 周转缓冲分钟），勾选设备绑定到哪些议程环节；
//  - 占用区间由服务端按权威议程推演逐帧给出（顺延 / 固定开始 / 跨午夜均已正确比较）；
//  - 同一设备相邻占用未达到周转缓冲时实时标红冲突双方，并按最早冲突在顶部汇总；
//  - 议程被替换后绑定到被删除环节的记录由服务端自动清理；投屏永不接收设备数据。
export default function DevicePanel({ devices, snap, canEdit, send, lastError, onClearError }) {
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState([]);
  const [formError, setFormError] = useState('');
  const lastSeqRef = useRef(0);

  const payload = devices;
  const agendaItems = snap?.agenda?.items ?? [];

  // 非编辑态下以权威设备库回填本地草稿（seq 变化：保存被接纳 / 被接管者改写 / 绑定被自动清理）
  useEffect(() => {
    if (!payload || editing) return;
    if (payload.seq !== lastSeqRef.current) {
      lastSeqRef.current = payload.seq;
      setRows(payload.devices.map((d) => ({
        id: d.id,
        name: d.name,
        turnaroundMin: d.turnaroundMs / 60000,
        itemIds: [...d.itemIds],
      })));
    }
  }, [payload, editing]);

  // 服务端错误（BAD_DEVICES）展示 5 秒
  const deviceError = lastError?.code === 'BAD_DEVICES';
  useEffect(() => {
    if (!deviceError || !onClearError) return undefined;
    const t = setTimeout(onClearError, 5000);
    return () => clearTimeout(t);
  }, [deviceError, onClearError]);

  if (!payload) {
    return (
      <fieldset className="panel" disabled>
        <legend>设备占用</legend>
        <p className="hint">正在加载设备占用状态…</p>
      </fieldset>
    );
  }

  const startEdit = () => {
    setRows(payload.devices.map((d) => ({
      id: d.id,
      name: d.name,
      turnaroundMin: d.turnaroundMs / 60000,
      itemIds: [...d.itemIds],
    })));
    setFormError('');
    setEditing(true);
  };

  const updateRow = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const removeRow = (i) => setRows((rs) => rs.filter((_, j) => j !== i));
  const addRow = () => setRows((rs) => {
    if (rs.length >= MAX_DEVICES) return rs;
    return [...rs, { id: newId(), name: '', turnaroundMin: 5, itemIds: [] }];
  });
  const toggleBinding = (i, itemId) => setRows((rs) => rs.map((r, j) => {
    if (j !== i) return r;
    const has = r.itemIds.includes(itemId);
    return {
      ...r,
      // 勾选后按议程顺序插入，保证占用相邻关系与议程一致
      itemIds: has
        ? r.itemIds.filter((id) => id !== itemId)
        : [...r.itemIds, itemId].sort(
          (a, b) => agendaItems.findIndex((it) => it.id === a) - agendaItems.findIndex((it) => it.id === b),
        ),
    };
  }));

  const save = () => {
    if (rows.length > MAX_DEVICES) {
      setFormError(`共享设备最多 ${MAX_DEVICES} 项`);
      return;
    }
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i].name.trim()) {
        setFormError(`第 ${i + 1} 项设备名称不能为空`);
        return;
      }
      const t = Number(rows[i].turnaroundMin);
      if (!Number.isFinite(t) || t < 0 || t > MAX_TURNAROUND_MIN) {
        setFormError(`第 ${i + 1} 项周转缓冲需为 0~${MAX_TURNAROUND_MIN} 分钟`);
        return;
      }
    }
    setFormError('');
    send({
      command: 'devices_set',
      devices: rows.map((r) => ({
        id: r.id,
        name: r.name.trim().slice(0, MAX_NAME_LEN),
        turnaroundMin: Math.max(0, Number(r.turnaroundMin) || 0),
        itemIds: r.itemIds,
      })),
    });
    setEditing(false);
  };

  const totalConflicts = payload.conflicts.length;

  return (
    <fieldset className="panel devices-panel" disabled={!canEdit}>
      <legend>
        设备占用（共享设备与议程环节绑定；相邻占用不足周转缓冲时实时标冲突；投屏不接收）
      </legend>

      {/* ---- 顶部冲突汇总：按最早冲突排序 ---- */}
      {!editing && totalConflicts > 0 && (
        <div className="dev-conflict-summary">
          <div className="dev-conflict-head">
            ⚠ 检测到 <b>{totalConflicts}</b> 处周转冲突（按最早发生排序）
          </div>
          <ol className="dev-conflict-list">
            {payload.conflicts.map((c, i) => (
              <li key={`${c.deviceId}-${c.a.itemId}-${c.b.itemId}`} className="dev-conflict-item">
                <span className="dev-conflict-idx">{i + 1}</span>
                <span className="dev-conflict-device">🎤 {c.deviceName}</span>
                <span className="dev-conflict-pair">
                  <b>{c.a.itemName}</b>
                  <em className="dev-conflict-arrow">→</em>
                  <b>{c.b.itemName}</b>
                </span>
                <span className="dev-conflict-gap">{formatGap(c.gapMs)}</span>
                <span className="dev-conflict-short">
                  缓冲 {Math.round(c.turnaroundMs / 60000)} 分 · {formatShortfall(c.shortfallMs)}
                </span>
                <span className="dev-conflict-time">后者 {formatClock(c.b.startMs)} 开始</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="dev-summary">
        <span className="dev-count">共享设备 {payload.devices.length}/{MAX_DEVICES} 项</span>
        <span className={totalConflicts > 0 ? 'dev-count dev-conflict-badge' : 'dev-count dev-ok-badge'}>
          {totalConflicts > 0 ? `周转冲突 ${totalConflicts} 处` : '周转无冲突'}
        </span>
        {!editing && (
          <button type="button" className="btn btn-mini dev-edit-btn" onClick={startEdit}>
            ✎ 维护设备与绑定
          </button>
        )}
      </div>

      {editing ? (
        /* ---- 编辑态：设备名称 / 周转缓冲 / 议程环节绑定矩阵 ---- */
        <>
          <div className="dev-edit-list" role="table">
            <div className="dev-edit-row dev-head" role="row">
              <span>#</span>
              <span>设备名称</span>
              <span>周转缓冲(分)</span>
              <span>绑定议程环节</span>
              <span>操作</span>
            </div>
            {rows.map((r, i) => (
              <div className="dev-edit-row" role="row" key={r.id}>
                <span className="dev-idx">{i + 1}</span>
                <span>
                  <input
                    value={r.name}
                    maxLength={MAX_NAME_LEN}
                    placeholder={`设备 ${i + 1}（如：无线麦）`}
                    onChange={(e) => updateRow(i, { name: e.target.value.slice(0, MAX_NAME_LEN) })}
                  />
                </span>
                <span>
                  <input
                    className="dev-turn-input"
                    type="number"
                    min="0"
                    max={MAX_TURNAROUND_MIN}
                    step="1"
                    value={r.turnaroundMin}
                    onChange={(e) => updateRow(i, { turnaroundMin: e.target.value })}
                  />
                </span>
                <span className="dev-bindings-cell">
                  {agendaItems.length === 0 ? (
                    <em className="hint">议程为空，请先在“议程偏差推演”中维护环节</em>
                  ) : (
                    <div className="dev-binding-chips">
                      {agendaItems.map((it) => {
                        const on = r.itemIds.includes(it.id);
                        return (
                          <button
                            type="button"
                            key={it.id}
                            className={`dev-chip ${on ? 'dev-chip-on' : ''}`}
                            onClick={() => toggleBinding(i, it.id)}
                            title={on ? '取消绑定' : '绑定该环节'}
                          >
                            {on ? '✓ ' : ''}{it.name}{it.fixed ? ' 📌' : ''}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </span>
                <span className="dev-ops">
                  <button type="button" className="btn btn-mini btn-danger" onClick={() => removeRow(i)}>删</button>
                </span>
              </div>
            ))}
            {rows.length === 0 && <p className="hint">尚未配置共享设备。</p>}
          </div>
          <div className="dev-actions">
            <button type="button" className="btn" onClick={addRow} disabled={rows.length >= MAX_DEVICES}>
              ＋ 添加设备（{rows.length}/{MAX_DEVICES}）
            </button>
            <button type="button" className="btn btn-primary" onClick={save}>保存设备配置</button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => { setEditing(false); setFormError(''); }}
            >
              取消
            </button>
          </div>
          <p className="hint hint-warn">
            保存后服务端会自动剔除议程中已删除的环节绑定；占用区间与冲突随后按当前权威推演实时计算。
          </p>
          {formError && <p className="agenda-error">⚠ {formError}</p>}
        </>
      ) : (
        /* ---- 查看态：每个设备的占用时间线（冲突双方标红） ---- */
        <div className="dev-timeline-list">
          {payload.devices.length === 0 && (
            <p className="hint">
              尚未配置共享设备。点“维护设备与绑定”添加设备（如：无线麦、同传箱、发言台），
              设置相邻两场占用之间需要的周转缓冲（分钟），并勾选该设备被哪些议程环节占用。
            </p>
          )}
          {payload.devices.map((d) => (
            <div
              key={d.id}
              className={`dev-card ${d.conflictCount > 0 ? 'dev-card-conflict' : ''}`}
            >
              <div className="dev-card-head">
                <span className="dev-card-name">🎤 {d.name}</span>
                <span className="dev-card-turn">周转缓冲 {Math.round(d.turnaroundMs / 60000)} 分</span>
                {d.conflictCount > 0 && (
                  <span className="dev-card-badge">{d.conflictCount} 场占用卷入冲突</span>
                )}
              </div>
              {d.occupations.length === 0 ? (
                <p className="hint">未绑定任何议程环节。</p>
              ) : (
                <ol className="dev-occ-list">
                  {d.occupations.map((o) => (
                    <li
                      key={o.itemId}
                      className={`dev-occ ${o.conflict ? 'dev-occ-conflict' : ''}`}
                    >
                      <span className="dev-occ-name">
                        {o.itemName}
                        {o.fixed && <em className="dev-occ-fixed" title="固定开始环节">📌</em>}
                        {o.status === 'current' && <em className="tag tag-now">当前</em>}
                        {o.status === 'done' && <em className="tag tag-done">已结束</em>}
                        {o.insufficient && <em className="tag tag-short">时间不足</em>}
                      </span>
                      <span className="dev-occ-range">
                        {formatClock(o.startMs)} – {formatClock(o.endMs)}
                      </span>
                      {o.gapMs != null && (
                        <span className={`dev-occ-gap ${o.conflict ? 'dev-gap-bad' : 'dev-gap-ok'}`}>
                          {formatGap(o.gapMs)}
                          {o.conflict && o.shortfallMs > 0 && (
                            <em className="dev-gap-short">（{formatShortfall(o.shortfallMs)}）</em>
                          )}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ))}
        </div>
      )}

      {deviceError && <p className="agenda-error">⚠ {lastError.message}</p>}

      <p className="hint">
        预计起止区间完全采用服务端权威议程推演（顺延 / 固定开始 / 跨午夜均正确比较）；
        设备配置、绑定与冲突结果只存服务端内存，服务 / 容器重启即清空，控制台断线重连后完整恢复。
      </p>
    </fieldset>
  );
}
