// 投屏场景编排（纯函数模块，便于单测）
//
// 模型：
//  - 持有者可保存最多 MAX_SCENES（8）个场景；每个场景选择若干展示模块及布局参数；
//  - 模块（MODULE_KEYS）：
//      countdown 倒计时（当前环节/剩余时间/醒目状态）
//      agenda    议程（当前/下一环节及预计开始时间）
//      cue       提示（最新一条后台提示内联展示，可现场确认）
//      markers   标记摘要（本场会话最近现场标记时间线）
//  - 布局（LAYOUTS）：
//      stack 纵向排布（大屏单列）
//      grid  网格排布（两列，按模块尺寸跨行）
//  - 模块尺寸（MODULE_SIZES）：sm | md | lg，仅作为布局参数下发给投屏；
//  - 场景库整体替换：内容（id/名称/布局/模块配置）确实变化时调用方递增库 seq；
//  - 激活与库内容解耦：编辑保存只改场景库，再次“切换/激活”后投屏才换画面，
//    每次激活都产生新的激活版本（activeVersion），服务端据此生成完整快照并广播。
//
// 与既有领域模型一致：不引入持久化，服务进程重启即回到默认单场景。

export const MAX_SCENES = 8;
export const MAX_SCENE_NAME_LEN = 20;
export const MODULE_KEYS = ['countdown', 'agenda', 'cue', 'markers'];
export const MODULE_LABELS = {
  countdown: '倒计时',
  agenda: '议程',
  cue: '提示',
  markers: '标记摘要',
};
export const LAYOUTS = ['stack', 'grid'];
export const MODULE_SIZES = ['sm', 'md', 'lg'];

export function genSceneId() {
  return `sc-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultModule(enabled, size = 'md') {
  return { enabled, size };
}

// 服务进程启动时的默认场景：传统投屏画面（倒计时 + 议程）
export function defaultScenes() {
  return [{
    id: genSceneId(),
    name: '标准投屏',
    layout: 'stack',
    modules: {
      countdown: defaultModule(true, 'lg'),
      agenda: defaultModule(true, 'md'),
      cue: defaultModule(false, 'md'),
      markers: defaultModule(false, 'sm'),
    },
  }];
}

// 校验并规范化单个场景。名称缺省时按序号补“场景 N”；
// 至少启用一个模块，否则返回 BAD_SCENE（空场景没有可投屏内容）。
// 客户端未显式给出的模块一律按“禁用 + 中尺寸”规范化，不猜测编排意图。
export function normalizeScene(raw, index = 0) {
  const r = raw && typeof raw === 'object' ? raw : {};

  const name = String(r.name ?? '').trim().slice(0, MAX_SCENE_NAME_LEN) || `场景 ${index + 1}`;

  const layout = LAYOUTS.includes(r.layout) ? r.layout : 'stack';

  const rawModules = r.modules && typeof r.modules === 'object' ? r.modules : {};
  const modules = {};
  for (const key of MODULE_KEYS) {
    const m = rawModules[key] && typeof rawModules[key] === 'object' ? rawModules[key] : {};
    const size = MODULE_SIZES.includes(m.size) ? m.size : 'md';
    modules[key] = { enabled: !!m.enabled, size };
  }
  if (!MODULE_KEYS.some((k) => modules[k].enabled)) {
    return { error: 'BAD_SCENE', message: `「${name}」至少需要启用一个模块` };
  }

  let id = typeof r.id === 'string' && /^[\w.-]{1,64}$/.test(r.id) ? r.id : genSceneId();

  return { value: { id, name, layout, modules } };
}

// 校验并规范化控制台下发的完整场景库。返回 { scenes } 或 { error, message }。
export function normalizeSceneLibrary(raw) {
  if (!Array.isArray(raw)) {
    return { error: 'BAD_SCENE', message: '场景库必须是数组' };
  }
  if (raw.length < 1) {
    return { error: 'BAD_SCENE', message: '至少保留 1 个场景' };
  }
  if (raw.length > MAX_SCENES) {
    return { error: 'BAD_SCENE', message: `场景最多保存 ${MAX_SCENES} 个` };
  }

  const scenes = [];
  const seenIds = new Set();
  for (let i = 0; i < raw.length; i++) {
    const result = normalizeScene(raw[i], i);
    if (result.error) return result;
    const scene = result.value;
    if (seenIds.has(scene.id)) scene.id = genSceneId();
    seenIds.add(scene.id);
    scenes.push(scene);
  }
  return { scenes };
}

// 场景库内容签名：只比较编排内容（忽略激活状态），内容无变化的保存不递增版本
export function sceneLibrarySignature(scenes) {
  return JSON.stringify(scenes.map((s) => [
    s.id, s.name, s.layout,
    MODULE_KEYS.map((k) => [s.modules[k].enabled, s.modules[k].size]),
  ]));
}

export function findScene(scenes, id) {
  return scenes.find((s) => s.id === id) ?? null;
}
