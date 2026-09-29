import { useEffect, useRef, useState } from 'react';
import { formatClock, parseClock } from '../time.js';

// 议程编辑面板：维护有序环节（名称 / 计划开始 / 时长 / 固定标记），
// 可把任一项设为当前环节。编辑仅存本地草稿，点“保存议程”才整体下发；
// 权威快照（agenda.seq 变化）回来后自动对账，避免覆盖他人的接管修改。
function newId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `a-${Math.random().toString(36).slice(2, 10)}`;
}

function toDraftRow(it) {
  return { id: it.id, name: it.name, start: formatClock(it.startMs), durMin: it.durationMs / 60000, fixed: it.fixed };
}

function blankRow(prevStartMs = 9 * 3600_000, prevDurMs = 10 * 60_000) {
  return {
    id: newId(),
    name: '',
    start: formatClock(prevStartMs + prevDurMs),
    durMin: 10,
    fixed: false,
  };
}

export default function AgendaPanel({ snap, canEdit, send, lastError, onClearError }) {
  const agenda = snap?.agenda ?? null;
  const [rows, setRows] = useState([]);
  const [hydrated, setHydrated] = useState(false);
  const [savedSeq, setSavedSeq] = useState(0);   // 已确认接纳的议程 seq
  const [formError, setFormError] = useState('');
  const lastSeqRef = useRef(0);

  // 首次挂载 / 服务端议程被接纳或被其他控制台替换时，用权威快照回填草稿
  useEffect(() => {
    if (!agenda) return;
    if (!hydrated || agenda.seq !== lastSeqRef.current) {
      lastSeqRef.current = agenda.seq;
      setRows(agenda.items.map(toDraftRow));
      setSavedSeq(agenda.seq);
      setHydrated(true);
      setFormError('');
    }
  }, [agenda, hydrated]);

  // 服务端错误（如 BAD_AGENDA）展示 4 秒
  useEffect(() => {
    if (!lastError) return undefined;
    const t = setTimeout(onClearError, 4000);
    return () => clearTimeout(t);
  }, [lastError, onClearError]);

  if (!hydrated || !agenda) {
    return (
      <fieldset className="panel" disabled>
        <legend>议程偏差推演</legend>
        <p className="hint">正在加载议程…</p>
      </fieldset>
    );
  }

  // 权威快照中的推演结果（按 id 索引，供草稿旁边实时对照）
  const projected = new Map(agenda.items.map((it) => [it.id, it]));
  // 服务端 seq 领先（内容刚被接纳/被接管者改写）或本地草稿与权威议程不一致，都视为待保存
  const dirty = agenda.seq !== savedSeq
    || JSON.stringify(agenda.items.map(toDraftRow)) !== JSON.stringify(rows);

  const update = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i, delta) => setRows((rs) => {
    const j = i + delta;
    if (j < 0 || j >= rs.length) return rs;
    const next = rs.slice();
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const remove = (i) => setRows((rs) => rs.filter((_, j) => j !== i));
  const add = () => setRows((rs) => {
    const last = rs[rs.length - 1];
    if (!last) return [blankRow()];
    const startMs = parseClock(last.start) ?? 9 * 3600_000;
    const durMs = (Number(last.durMin) || 10) * 60000;
    return [...rs, blankRow(startMs, durMs)];
  });

  const save = () => {
    const items = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const startMs = parseClock(r.start);
      const durMin = Number(r.durMin);
      if (startMs == null) {
        setFormError(`第 ${i + 1} 项开始时间格式应为 HH:MM`);
        return;
      }
      if (!Number.isFinite(durMin) || durMin < 1 / 60 || durMin > 12 * 60) {
        setFormError(`第 ${i + 1} 项时长需在 0.1 分钟 ~ 12 小时之间`);
        return;
      }
      items.push({
        id: r.id,
        name: r.name.trim(),
        startMs,
        durationMs: Math.round(durMin * 60000),
        fixed: !!r.fixed,
      });
    }
    setFormError('');
    send({ command: 'agenda_set', items });
  };

  const setCurrent = (id) => send({ command: 'agenda_current', id });

  return (
    <fieldset className="panel" disabled={!canEdit}>
      <legend>议程偏差推演（普通环节按偏差顺延；📌 固定环节保留计划开始时间）</legend>

      <div className="agenda-table" role="table">
        <div className="agenda-row agenda-head" role="row">
          <span>#</span>
          <span>环节名称</span>
          <span>计划开始</span>
          <span>时长(分)</span>
          <span>固定</span>
          <span>预计开始</span>
          <span>预计结束</span>
          <span>操作</span>
        </div>

        {rows.map((r, i) => {
          const p = projected.get(r.id);
          const isCurrent = agenda.currentId === r.id;
          const wasDone = p && p.status === 'done';
          return (
            <div
              className={`agenda-row ${isCurrent ? 'agenda-current' : ''} ${wasDone ? 'agenda-done' : ''}`}
              role="row"
              key={r.id}
            >
              <span className="agenda-idx">{i + 1}</span>
              <span className="agenda-name-cell">
                <input
                  value={r.name}
                  maxLength={40}
                  placeholder={`环节 ${i + 1}`}
                  onChange={(e) => update(i, { name: e.target.value })}
                />
                {p?.insufficient && <em className="tag tag-short">时间不足</em>}
                {isCurrent && <em className="tag tag-now">当前</em>}
                {wasDone && <em className="tag tag-done">已结束</em>}
              </span>
              <span>
                <input
                  className="agenda-time-input"
                  value={r.start}
                  placeholder="09:00"
                  onChange={(e) => update(i, { start: e.target.value })}
                />
              </span>
              <span>
                <input
                  className="agenda-dur-input"
                  type="number"
                  min="0.1"
                  step="1"
                  value={r.durMin}
                  onChange={(e) => update(i, { durMin: e.target.value })}
                />
              </span>
              <span className="agenda-fixed-cell">
                <label title="固定环节始终保留计划开始时间，不随偏差顺延">
                  <input
                    type="checkbox"
                    checked={!!r.fixed}
                    onChange={(e) => update(i, { fixed: e.target.checked })}
                  />
                  {r.fixed ? '📌' : ''}
                </label>
              </span>
              <span className={`agenda-proj ${p?.insufficient ? 'proj-short' : ''}`}>
                {dirty ? '—' : formatClock(p?.projStartMs)}
              </span>
              <span className={`agenda-proj ${p?.insufficient ? 'proj-short' : ''}`}>
                {dirty ? '—' : formatClock(p?.projEndMs)}
              </span>
              <span className="agenda-ops">
                <button
                  type="button"
                  className="btn btn-mini"
                  onClick={() => setCurrent(r.id)}
                  disabled={isCurrent}
                  title="设为当前环节（载入其时长并回到待开始）"
                >
                  {isCurrent ? '进行中' : '设为当前'}
                </button>
                <button type="button" className="btn btn-mini" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                <button type="button" className="btn btn-mini" onClick={() => move(i, 1)} disabled={i === rows.length - 1}>↓</button>
                <button type="button" className="btn btn-mini btn-danger" onClick={() => remove(i)}>删</button>
              </span>
            </div>
          );
        })}

        {rows.length === 0 && <p className="hint">议程为空，请添加环节。</p>}
      </div>

      <div className="agenda-actions">
        <button type="button" className="btn" onClick={add}>＋ 添加环节</button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={save}
          disabled={!dirty}
        >
          {dirty ? '保存议程并同步投屏' : '议程已同步'}
        </button>
      </div>

      {(formError || lastError) && (
        <p className="agenda-error">⚠ {formError || lastError.message}</p>
      )}
      <p className="hint">
        预计开始/结束随当前环节的提前与超时实时推演；未保存的草稿（“—”）不会影响投屏。
        重叠时自动压缩固定环节前最后一个普通环节并标红“时间不足”。
      </p>
    </fieldset>
  );
}
