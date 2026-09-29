// 设备巡检门禁（纯函数模块，便于单测）
//
// 模型：
//  - 巡检清单最多 30 项，每项含名称、区域与“必检”标记；
//  - 每项状态为 pending（待检）| pass（通过）| fault（故障，带备注）；
//  - seq 为巡检清单内容版本：仅在清单整体替换且内容确实变化时递增；
//  - armedSeq 为门禁“放行锚点”：门禁放行（armed）后记录当时的 seq。
//
// 门禁规则（evaluateGate）：
//  - 没有任何必检项：门禁不启用（enabled=false），不拦截开始；
//  - 任一必检项为 fault：门禁失效（disarmed，原因 fault）；
//  - 任一必检项为 pending：门禁未放行（disarmed，原因 pending）；
//  - 全部必检项为 pass 但 armedSeq 为空：尚未完成本轮必检（disarmed，原因 recheck）；
//  - 全部必检项为 pass 且 armedSeq 与当前 seq 不一致：清单已被编辑、
//    放行所依据的巡检版本已变化（disarmed，原因 version_changed）；
//  - 全部必检项为 pass 且版本一致：门禁放行（armed），允许开始当前计时。
//
// 关键不变量：
//  - 编辑清单（inspection_set）后全部登记状态重置为 pending 且 armedSeq=null：
//    任何编辑都必须由持有者逐项重新登记，全部必检项重检通过后才再次放行；
//  - 任一必检项被登记回 fault 时 armedSeq 立即置空，门禁立即失效；
//  - 非必检项不参与门禁：其故障/待检不拦截开始。

export const MAX_INSPECTION_ITEMS = 30;
export const MAX_INSPECTION_NAME_LEN = 30;
export const MAX_INSPECTION_AREA_LEN = 30;
export const MAX_INSPECTION_NOTE_LEN = 100;
export const INSPECTION_STATUSES = ['pending', 'pass', 'fault'];

export function genInspectionId() {
  return `i-${Math.random().toString(36).slice(2, 10)}`;
}

export function defaultInspection() {
  return { seq: 1, items: [], armedSeq: null };
}

// 校验并规范化控制台下发的完整巡检清单。返回 { items } 或 { error, message }。
// 状态不在此处接受客户端值：编辑保存后一律从 pending 重新登记。
export function normalizeInspection(raw) {
  if (!Array.isArray(raw)) {
    return { error: 'BAD_INSPECTION', message: '巡检清单必须是数组' };
  }
  if (raw.length > MAX_INSPECTION_ITEMS) {
    return { error: 'BAD_INSPECTION', message: `巡检项最多 ${MAX_INSPECTION_ITEMS} 项` };
  }

  const seenIds = new Set();
  const items = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const name = String(r?.name ?? '').trim().slice(0, MAX_INSPECTION_NAME_LEN);
    if (!name) {
      return { error: 'BAD_INSPECTION', message: `第 ${i + 1} 项巡检名称需为 1~${MAX_INSPECTION_NAME_LEN} 字` };
    }
    const area = String(r?.area ?? '').trim().slice(0, MAX_INSPECTION_AREA_LEN);

    let id = typeof r?.id === 'string' && /^[\w.-]{1,64}$/.test(r.id) ? r.id : genInspectionId();
    if (seenIds.has(id)) id = genInspectionId();
    seenIds.add(id);

    items.push({ id, name, area, required: !!r?.required, status: 'pending', note: '' });
  }
  return { items };
}

// 整体替换巡检清单：内容（id/名称/区域/必检，忽略状态）确实变化时才递增版本。
// 任何成功替换都把登记状态全部重置为待检并使门禁失效——编辑后必须重新逐项巡检。
export function setChecklist(inspection, rawItems) {
  const result = normalizeInspection(rawItems);
  if (result.error) return result;

  const signature = JSON.stringify(result.items.map((it) => [it.id, it.name, it.area, it.required]));
  const current = JSON.stringify(inspection.items.map((it) => [it.id, it.name, it.area, it.required]));
  if (signature === current) {
    return { ok: true, changed: false, seq: inspection.seq };
  }

  return {
    ok: true,
    changed: true,
    state: { seq: inspection.seq + 1, items: result.items, armedSeq: null },
  };
}

// 门禁状态派生：纯函数，返回 { enabled, armed, reason }。
export function evaluateGate(inspection) {
  const required = inspection.items.filter((it) => it.required);
  if (required.length === 0) {
    return { enabled: false, armed: true, reason: null, requiredTotal: 0 };
  }
  const fault = required.find((it) => it.status === 'fault');
  if (fault) {
    return {
      enabled: true,
      armed: false,
      reason: 'fault',
      reasonItem: { id: fault.id, name: fault.name, note: fault.note },
      requiredTotal: required.length,
    };
  }
  const pending = required.find((it) => it.status === 'pending');
  if (pending) {
    return { enabled: true, armed: false, reason: 'pending', requiredTotal: required.length };
  }
  if (inspection.armedSeq == null) {
    return { enabled: true, armed: false, reason: 'recheck', requiredTotal: required.length };
  }
  if (inspection.armedSeq !== inspection.seq) {
    return { enabled: true, armed: false, reason: 'version_changed', requiredTotal: required.length };
  }
  return { enabled: true, armed: true, reason: null, requiredTotal: required.length };
}

// 持有者逐项登记：status=pass 通过；status=fault 必须带 1~100 字备注。
// 返回 { ok, state, gate, changed, disarmed, armed } 或 { error, message }。
export function registerResult(inspection, rawId, rawStatus, rawNote) {
  const id = String(rawId ?? '');
  const idx = inspection.items.findIndex((it) => it.id === id);
  if (idx === -1) {
    return { error: 'NOT_FOUND', message: '巡检项不存在（可能已被编辑删除）' };
  }
  const status = String(rawStatus ?? '');
  if (!INSPECTION_STATUSES.includes(status)) {
    return { error: 'BAD_INSPECTION', message: '巡检状态非法（需为 pass 或 fault）' };
  }

  let note = '';
  if (status === 'fault') {
    note = String(rawNote ?? '').trim().slice(0, MAX_INSPECTION_NOTE_LEN);
    if (!note) {
      return { error: 'BAD_INSPECTION', message: `故障必须填写 1~${MAX_INSPECTION_NOTE_LEN} 字备注` };
    }
  }

  const before = evaluateGate(inspection);
  const items = inspection.items.map((it, i) => (i === idx ? { ...it, status, note } : it));

  // 必检项被登记回故障：放行锚点立即清空，门禁立即失效（即使此前从未放行，也保持 null）。
  let armedSeq = inspection.armedSeq;
  if (status === 'fault' && items[idx].required) armedSeq = null;

  // 全部必检项均为通过时，在当前清单版本上锚定放行（armedSeq === seq）；
  // 已在同一版本放行后重复登记通过，锚点保持不变。
  // 注意：必须直接依据 items 判定，不能用 armedSeq 尚未更新时算出的 gate。
  const requiredItems = items.filter((it) => it.required);
  if (requiredItems.length > 0 && requiredItems.every((it) => it.status === 'pass')) {
    armedSeq = inspection.seq;
  }

  const state = { ...inspection, items, armedSeq };
  const after = evaluateGate(state);
  return {
    ok: true,
    state,
    gate: after,
    changed: true,
    disarmed: before.armed && !after.armed,
    armed: !before.armed && after.armed,
  };
}
