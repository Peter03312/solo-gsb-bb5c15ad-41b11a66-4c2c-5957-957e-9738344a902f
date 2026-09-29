import { useState } from 'react';
import {
  formatDeviation,
  formatDeviationSeconds,
  formatSessionClock,
  formatWallTime,
  formatWallDateTime,
  formatElapsed,
  csvCell,
} from '../time.js';

const MAX_MARK_NAME_LEN = 30;

// 常用事件一键记录（仍可自定义任意不超过 30 字的名称）
const PRESETS = ['发言切换', '设备故障', '提示上场', '现场干扰'];

const PHASE_TEXT = { idle: '待开始', running: '运行中', paused: '已暂停', finished: '已超时' };

// 控制台“现场标记”面板：
//  - 持有控制权时可在当前环节记录带名称的事件，发生时刻/归属环节/偏差由服务端在记录瞬间固化；
//  - 按时间线展示本场会话全部标记，支持删除最近一条；
//  - 可按本场会话导出 CSV（无需控制权）；
//  - 投屏从不接收标记消息，因此不会在大屏显示任何标记。
export default function MarkerPanel({ markers, canEdit, send, lastError }) {
  const [name, setName] = useState('');

  const add = (text) => {
    const trimmed = String(text ?? name).trim().slice(0, MAX_MARK_NAME_LEN);
    if (!canEdit || !trimmed) return;
    send({ command: 'mark_add', name: trimmed });
    setName('');
  };

  const deleteLatest = () => {
    if (!canEdit || markers.length === 0) return;
    send({ command: 'mark_delete_latest' });
  };

  const exportCsv = () => {
    const header = ['序号', '发生时刻', '会话内时间', '环节序号', '环节名称',
      '环节已用(秒)', '相对计划偏差(秒)', '计时状态', '标记名称'];
    const lines = [header.map(csvCell).join(',')];
    for (const m of markers) {
      lines.push([
        m.seq,
        csvCell(formatWallDateTime(m.wallTime)),
        formatSessionClock(m.sessionElapsedMs),
        m.itemIndex == null ? '' : m.itemIndex + 1,
        csvCell(m.itemName ?? '（未设定环节）'),
        m.itemElapsedMs == null ? '' : Math.round(m.itemElapsedMs / 1000),
        formatDeviationSeconds(m.deviationMs),
        PHASE_TEXT[m.phase] ?? m.phase,
        csvCell(m.name),
      ].join(','));
    }
    // UTF-8 BOM：保证 Excel 直接打开中文不乱码
    const blob = new Blob([`﻿${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = formatWallDateTime(new Date().toISOString()).replace(/[-: ]/g, '');
    a.href = url;
    a.download = `现场标记-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const markerError = lastError?.code === 'BAD_MARK' || lastError?.code === 'MARK_LIMIT' || lastError?.code === 'NO_MARK';

  return (
    <fieldset className="panel marker-panel">
      <legend>现场标记（记录发言切换 / 设备故障等事件；投屏不显示）</legend>

      <div className="marker-add">
        <input
          value={name}
          maxLength={MAX_MARK_NAME_LEN}
          placeholder={`标记名称（最多 ${MAX_MARK_NAME_LEN} 字），回车记录`}
          disabled={!canEdit}
          onChange={(e) => setName(e.target.value.slice(0, MAX_MARK_NAME_LEN))}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canEdit || !name.trim()}
          onClick={() => add()}
        >
          ＋ 记录标记
        </button>
        <button
          type="button"
          className="btn"
          disabled={!canEdit || markers.length === 0}
          onClick={deleteLatest}
          title="删除本场会话最近一条标记"
        >
          删除最近一条
        </button>
        <button
          type="button"
          className="btn"
          disabled={markers.length === 0}
          onClick={exportCsv}
          title="按本场会话导出全部标记为 CSV"
        >
          ⭳ 导出 CSV
        </button>
      </div>

      <div className="marker-presets">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className="btn btn-mini marker-preset"
            disabled={!canEdit}
            onClick={() => add(p)}
          >
            {p}
          </button>
        ))}
        <span className="marker-counter">{name.trim().length}/{MAX_MARK_NAME_LEN}</span>
      </div>

      {markerError && <p className="agenda-error">⚠ {lastError.message}</p>}

      {markers.length === 0 ? (
        <p className="hint">
          本场会话尚无标记。持有控制权时输入名称回车即可记录；
          发生时刻、当前环节与相对计划偏差在记录瞬间固化，暂停、重连或进入下一环节均不改变。
        </p>
      ) : (
        <ol className="marker-timeline">
          {markers.map((m) => (
            <li key={m.seq} className="marker-item">
              <span className="marker-dot" aria-hidden="true" />
              <span className="marker-time" title="挂钟发生时刻">{formatWallTime(m.wallTime)}</span>
              <span className="marker-session" title="本场会话内相对时间">
                T+{formatSessionClock(m.sessionElapsedMs)}
              </span>
              <span className="marker-name">{m.name}</span>
              <span className="marker-item-name" title="归属环节（记录瞬间固化）">
                {m.itemName ? `📍 ${m.itemName}` : '📍（未设定环节）'}
                {m.itemIndex != null && <em className="marker-item-idx">#{m.itemIndex + 1}</em>}
                {m.itemElapsedMs != null && (
                  <em className="marker-elapsed" title="记录时该环节已用时长">
                    已用 {formatElapsed(m.itemElapsedMs)}
                  </em>
                )}
              </span>
              <span className={`marker-dev ${deviationClass(m.deviationMs)}`} title="记录瞬间相对计划偏差">
                {formatDeviation(m.deviationMs)}
              </span>
              <em className={`marker-phase marker-phase-${m.phase}`}>{PHASE_TEXT[m.phase] ?? m.phase}</em>
            </li>
          ))}
        </ol>
      )}

      <p className="hint">
        标记与归属仅存服务端内存：服务进程重启即开始新的一场会话；
        暂停计时、断线重连、进入下一环节或改写议程后，历史标记的顺序与归属保持不变。
      </p>
    </fieldset>
  );
}

function deviationClass(ms) {
  if (Math.abs(ms) < 1000) return 'dev-ok';
  return ms < 0 ? 'dev-early' : 'dev-late';
}
