import { useEffect, useMemo, useRef, useState } from 'react';
import { formatClock, liveAgenda, monoNow } from '../time.js';
import {
  rehearseAgenda,
  diffOccupancy,
  snapshotAgendaParams,
  linearSchedule,
} from '../../../server/src/rehearsal.js';

const MAX_EXTRA_MIN = 24 * 60; // 预演“再持续”上限 24 小时（分钟）

// 缺口/空当毫秒格式化：与 DevicePanel 同一口径
function formatGap(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const abs = Math.abs(ms);
  if (abs < 1000) return '背靠背';
  const min = Math.round(abs / 60000);
  const text = min >= 1 ? `${min} 分` : `${Math.round(abs / 1000)} 秒`;
  return ms < 0 ? `重叠 ${text}` : `间隔 ${text}`;
}

function formatShortfall(ms) {
  if (ms == null || ms <= 0) return null;
  const min = Math.round(ms / 60000);
  return min >= 1 ? `缺口 ${min} 分` : `缺口 ${Math.round(ms / 1000)} 秒`;
}

// 有符号毫秒时长 → “5 分 / 40 秒”（取绝对值，用于“缺口 +5 分”这类标注）
function formatMinutes(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const abs = Math.abs(ms);
  const min = Math.round(abs / 60000);
  return min >= 1 ? `${min} 分` : `${Math.round(abs / 1000)} 秒`;
}

// 模拟时刻相对现场的变化：“+5 分 / −3 分 / 不变”
function formatDelta(ms) {
  if (ms == null || !Number.isFinite(ms) || Math.abs(ms) < 1000) return '不变';
  const abs = Math.abs(ms);
  const min = Math.round(abs / 60000);
  const text = min >= 1 ? `${min} 分` : `${Math.round(abs / 1000)} 秒`;
  return ms > 0 ? `+${text}` : `−${text}`;
}

function deltaClass(ms) {
  if (ms == null || Math.abs(ms) < 1000) return 'reh-delta-same';
  return ms > 0 ? 'reh-delta-late' : 'reh-delta-early';
}

const KIND_LABEL = {
  new: { text: '新增', cls: 'reh-kind-new' },
  worse: { text: '缺口增大', cls: 'reh-kind-worse' },
  better: { text: '缓解', cls: 'reh-kind-better' },
  same: { text: '不变', cls: 'reh-kind-same' },
};

// 控制台“结束时间预演”面板（纯本地推演，不发送任何指令）：
//  - 仅当前环节运行/暂停时可输入“预计再持续 N 分钟”；
//  - 依据最新权威快照，复用服务端 projectAgenda（顺延/固定点压缩/跨午夜）与
//    buildOccupancy（周转缓冲冲突/跨午夜线性展开）在浏览器内模拟最终结束点；
//  - 展示后续环节模拟起止及相对现场的变化，并列出模拟后的设备周转冲突，
//    标出相对现场“新增/缺口增大”的冲突；
//  - 当前环节切换、服务重启（epoch 变化）或断线重连后清空旧输入，按新快照重算。
export default function RehearsalPanel({ snap, devices, connState }) {
  const [minutesText, setMinutesText] = useState('');

  // 旧输入作废条件：当前环节切换 / 纪元变化（服务重启）/ 重连恢复 / 离开运行或暂停。
  // 首次挂载 prev 为 null，不触发清空（此时输入本就为空）。
  const lastSigRef = useRef(null);
  useEffect(() => {
    const sig = {
      currentId: snap?.agenda?.currentId ?? null,
      epoch: snap?.epoch ?? null,
      phase: snap?.phase ?? null,
      conn: connState,
    };
    const prev = lastSigRef.current;
    lastSigRef.current = sig;
    if (!prev) return;
    const changedCurrent = prev.currentId !== sig.currentId;
    const changedEpoch = prev.epoch !== sig.epoch;
    const reconnected = prev.conn === 'reconnecting' && sig.conn === 'open';
    const notActive = sig.phase !== 'running' && sig.phase !== 'paused';
    if (changedCurrent || changedEpoch || reconnected || notActive) setMinutesText('');
  }, [snap?.agenda?.currentId, snap?.epoch, snap?.phase, connState, snap]);

  const active = !!snap && (snap.phase === 'running' || snap.phase === 'paused');

  const parsed = useMemo(() => {
    const t = String(minutesText ?? '').trim();
    if (!t) return { ok: false, empty: true, minutes: null, error: '' };
    const v = Number(t);
    if (!Number.isFinite(v)) return { ok: false, empty: false, minutes: null, error: '请输入数字分钟数' };
    if (v <= 0) return { ok: false, empty: false, minutes: null, error: '请输入大于 0 的分钟数' };
    if (v > MAX_EXTRA_MIN) return { ok: false, empty: false, minutes: null, error: `预演时长不超过 ${MAX_EXTRA_MIN} 分钟` };
    return { ok: true, empty: false, minutes: v, error: '' };
  }, [minutesText]);

  // 预演随 100ms 重绘（ConsolePage 已驱动）自动按最新时刻计算；此处直接读取本地插值时刻
  const model = useMemo(() => {
    if (!snap || !active || !parsed.ok) return null;

    // 当前环节此刻已用毫秒：与 liveRemaining/liveAgenda 同一套“快照间本地插值”
    const since = snap.phase === 'running'
      ? Math.max(0, monoNow() - snap.receivedAtMono)
      : 0;
    const p = snapshotAgendaParams(snap);
    const elapsedNow = Math.min(p.elapsedMs, p.liveDurationMs) + since;
    const extraMs = Math.round(parsed.minutes * 60_000);

    const liveRows = liveAgenda(snap).items;
    const sim = rehearseAgenda(snap, { extraMs, elapsedMs: elapsedNow });
    if (!sim) return null;

    const deviceList = devices?.devices ?? [];
    const diff = diffOccupancy(deviceList, liveRows, sim.rows);

    // 当前 + 后续行展开到线性时间轴（跨午夜固定点正确显示“次日”），现场与模拟同一套展开
    const simLin = linearSchedule(sim.rows, sim.currentId);
    const liveLin = linearSchedule(liveRows, sim.currentId);
    const simRowById = new Map(sim.rows.map((r) => [r.id, r]));
    const viewRows = [...simLin.entries()].map(([id, lin]) => {
      const row = simRowById.get(id);
      const live = liveLin.get(id);
      return {
        row,
        startMs: lin.startMs,
        endMs: lin.endMs,
        startDelta: live ? lin.startMs - live.startMs : null,
        endDelta: live ? lin.endMs - live.endMs : null,
      };
    });

    // 现场当前环节的线性结束点（与模拟 curEndMs 同一时间轴口径）
    const liveCurLin = liveLin.get(sim.currentId) ?? null;

    // 新增 / 缺口增大冲突涉及的占用行（相邻双方都高亮）
    const hot = new Set();
    for (const c of diff.conflicts) {
      if (c.kind === 'new' || c.kind === 'worse') {
        hot.add(`${c.deviceId}|${c.a.itemId}`);
        hot.add(`${c.deviceId}|${c.b.itemId}`);
      }
    }

    return {
      sim, diff, viewRows, hot,
      endDelta: liveCurLin ? sim.curEndMs - liveCurLin.endMs : null,
    };
  }, [snap, devices, active, parsed.ok, parsed.minutes]);

  const curRow = snap?.agenda?.items?.find((it) => it.id === snap?.agenda?.currentId) ?? null;

  return (
    <fieldset className="panel rehearsal-panel">
      <legend>
        结束时间预演（本地模拟：不改计时 / 议程 / 投屏；复用权威议程推演与设备周转规则）
      </legend>

      <div className="reh-input-row">
        <label>
          预计再持续
          <input
            className="reh-min-input"
            type="number"
            min="0"
            max={MAX_EXTRA_MIN}
            step="1"
            value={minutesText}
            placeholder="分钟"
            disabled={!active}
            onChange={(e) => setMinutesText(e.target.value)}
          />
          分钟
        </label>
        {[5, 10, 15, 30].map((m) => (
          <button
            key={m}
            type="button"
            className="btn btn-mini"
            disabled={!active}
            onClick={() => setMinutesText(String(m))}
          >
            +{m} 分
          </button>
        ))}
        <button
          type="button"
          className="btn btn-mini btn-ghost"
          disabled={!active || !minutesText}
          onClick={() => setMinutesText('')}
        >
          清空
        </button>
        {active && curRow && (
          <span className="hint reh-state-hint">
            当前环节 <b>{curRow.name}</b>
            {snap.phase === 'paused' && '（已暂停：按“现在继续、再持续该时长”模拟）'}
            {snap.phase === 'running' && '（运行中：按现在起再持续该时长模拟）'}
          </span>
        )}
      </div>

      {!active && (
        <p className="hint">
          {snap?.phase === 'finished'
            ? '当前环节已处于超时结束状态；预演仅在当前环节运行或暂停时可用。'
            : '设定当前环节并开始（或暂停运行中）后，可输入预计再持续的分钟数预演最终结束点。'}
        </p>
      )}
      {active && parsed.error && <p className="agenda-error">⚠ {parsed.error}</p>}
      {active && parsed.empty && (
        <p className="hint">
          输入分钟数后立即在本地模拟：后续普通环节顺延、📌 固定环节锚定计划点
          （时间不足时压缩其前最后一个普通环节）、跨午夜（23:50 → 次日 00:05）正确比较，
          并复用设备占用周转规则重算冲突。
        </p>
      )}

      {model && (
        <div className="reh-result">
          {/* ---- 当前环节最终结束点 ---- */}
          <div className="reh-endpoint">
            <span className="reh-endpoint-label">模拟最终结束点</span>
            <b className="reh-endpoint-time">{formatClock(model.sim.curEndMs)}</b>
            <span className={`reh-endpoint-delta ${deltaClass(model.endDelta)}`}>
              {`较现场 ${formatDelta(model.endDelta)}`}
            </span>
            {model.sim.clamped && (
              <span className="tag tag-short" title="结束点撞上后续固定环节，溢出部分被固定点吸收">
                撞固定点压缩 · 吸收 {Math.round(model.sim.absorbedMs / 60000)} 分
              </span>
            )}
          </div>
          {model.sim.clamped && (
            <p className="hint hint-warn">
              自然结束点为 {formatClock(model.sim.naturalEndMs)}，与后续 📌 固定环节重叠：
              固定点不可移动，溢出 {formatDelta(model.sim.absorbedMs)} 由固定点吸收
              （其前最后一个普通环节被压缩并标“时间不足”）。
            </p>
          )}

          {/* ---- 后续环节模拟起止 ---- */}
          <div className="reh-agenda" role="table">
            <div className="reh-agenda-row reh-head" role="row">
              <span>环节</span>
              <span>模拟开始</span>
              <span>模拟结束</span>
              <span>较现场变化</span>
            </div>
            {model.viewRows.map(({ row, startMs, endMs, startDelta, endDelta }) => (
              <div
                key={row.id}
                className={`reh-agenda-row ${row.status === 'current' ? 'reh-row-current' : ''}`}
                role="row"
              >
                <span className="reh-agenda-name">
                  {row.name}
                  {row.fixed && <em title="固定开始环节"> 📌</em>}
                  {row.status === 'current' && <em className="tag tag-now">当前</em>}
                  {row.insufficient && <em className="tag tag-short">时间不足</em>}
                </span>
                <span className="reh-agenda-time">{formatClock(startMs)}</span>
                <span className="reh-agenda-time">{formatClock(endMs)}</span>
                <span className="reh-agenda-delta">
                  开始 <em className={deltaClass(startDelta)}>{formatDelta(startDelta)}</em>
                  {' · '}结束 <em className={deltaClass(endDelta)}>{formatDelta(endDelta)}</em>
                </span>
              </div>
            ))}
          </div>

          {/* ---- 设备周转冲突（相对现场标注新增/缺口增大） ---- */}
          <RehearsalConflicts model={model} />
        </div>
      )}

      <p className="hint">
        预演只在本浏览器内计算，不发送任何指令，服务端计时、议程、投屏画面与设备配置均不改变；
        当前环节切换、断线重连或服务重启后输入自动清空并按新快照重算。跨午夜时间按线性时间轴显示“次日”。
      </p>
    </fieldset>
  );
}

function RehearsalConflicts({ model }) {
  const { diff, hot } = model;
  const c = diff.counts;

  return (
    <div className="reh-devices">
      <div className="reh-dev-summary">
        <span className="dev-count">模拟后设备周转冲突 {c.sim} 处</span>
        <span className="dev-count">现场 {c.live} 处</span>
        {c.added > 0 && <span className="dev-count dev-conflict-badge">新增 {c.added}</span>}
        {c.worse > 0 && <span className="dev-count dev-conflict-badge">缺口增大 {c.worse}</span>}
        {c.better > 0 && <span className="dev-count dev-ok-badge">缓解 {c.better}</span>}
        {c.resolved > 0 && <span className="dev-count dev-ok-badge">消失 {c.resolved}</span>}
        {c.added === 0 && c.worse === 0 && (
          <span className="dev-count dev-ok-badge">无相对现场新增或扩大的冲突</span>
        )}
      </div>

      {diff.conflicts.length > 0 && (
        <div className="dev-conflict-summary reh-conflict-box">
          <div className="dev-conflict-head">模拟后的周转冲突（按最早发生排序）</div>
          <ol className="dev-conflict-list">
            {diff.conflicts.map((cf) => {
              const k = KIND_LABEL[cf.kind] ?? KIND_LABEL.same;
              return (
                <li
                  key={`${cf.deviceId}-${cf.a.itemId}-${cf.b.itemId}`}
                  className={`dev-conflict-item ${cf.kind === 'new' || cf.kind === 'worse'
                    ? 'reh-conflict-hot'
                    : ''}`}
                >
                  <span className={`reh-kind ${k.cls}`}>{k.text}</span>
                  <span className="dev-conflict-device">🎤 {cf.deviceName}</span>
                  <span className="dev-conflict-pair">
                    <b>{cf.a.itemName}</b>
                    <em className="dev-conflict-arrow">→</em>
                    <b>{cf.b.itemName}</b>
                  </span>
                  <span className="dev-conflict-gap">{formatGap(cf.gapMs)}</span>
                  <span className="dev-conflict-short">
                    {formatShortfall(cf.shortfallMs)}
                    {(cf.kind === 'worse' || cf.kind === 'better') && (
                      <em className="reh-short-delta">
                        {`（${cf.kind === 'worse' ? '缺口 +' : '缺口 −'}${formatMinutes(cf.deltaMs)}）`}
                      </em>
                    )}
                  </span>
                  <span className="dev-conflict-time">后者 {formatClock(cf.b.startMs)} 开始</span>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {diff.resolved.length > 0 && (
        <p className="hint reh-resolved">
          ✓ 模拟后 {diff.resolved.length} 处现场冲突消失：
          {diff.resolved.slice(0, 4).map((cf) => `🎤${cf.deviceName}（${cf.a.itemName}→${cf.b.itemName}）`).join('；')}
          {diff.resolved.length > 4 ? ' 等' : ''}
        </p>
      )}

      {/* 各设备模拟占用区间（仅展示有绑定的设备；卷入新增/扩大冲突的行高亮） */}
      <div className="dev-timeline-list">
        {diff.sim.devices
          .filter((d) => d.occupations.length > 0)
          .map((d) => (
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
              <ol className="dev-occ-list">
                {d.occupations.map((o) => (
                  <li
                    key={o.itemId}
                    className={`dev-occ ${o.conflict ? 'dev-occ-conflict' : ''} ${
                      hot.has(`${d.id}|${o.itemId}`) ? 'reh-occ-hot' : ''
                    }`}
                  >
                    <span className="dev-occ-name">
                      {o.itemName}
                      {o.fixed && <em className="dev-occ-fixed" title="固定开始环节">📌</em>}
                      {o.status === 'current' && <em className="tag tag-now">当前</em>}
                      {o.insufficient && <em className="tag tag-short">时间不足</em>}
                    </span>
                    <span className="dev-occ-range">
                      {formatClock(o.startMs)} – {formatClock(o.endMs)}
                    </span>
                    <span className={`dev-occ-gap reh-occ-delta ${deltaClass(o.endDeltaMs)}`}>
                      结束 {formatDelta(o.endDeltaMs)}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        {diff.sim.devices.every((d) => d.occupations.length === 0) && (
          <p className="hint">设备库中暂无环节绑定；可在“设备占用”面板维护共享设备与绑定。</p>
        )}
      </div>
    </div>
  );
}
