// 投屏持久身份：首次打开生成不可重复的屏幕 ID 并写入 localStorage，
// 之后页面刷新 / 浏览器重启均沿用同一 ID（服务端据此补发未确认提示）。
const SCREEN_ID_KEY = 'venue.screenId';
const SCREEN_NAME_KEY = 'venue.screenName';

function genScreenId() {
  const c = typeof crypto !== 'undefined';
  if (c && crypto.randomUUID) return `s-${crypto.randomUUID()}`;
  if (c && crypto.getRandomValues) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `s-${hex}`;
  }
  return `s-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 18)}`;
}

export function defaultScreenName(id) {
  return `投屏 ${String(id).slice(2, 8).toUpperCase()}`;
}

// 读取（必要时生成）持久身份。对象引用在页面生命周期内保持稳定，
// 供 WebSocket 重连时反复注册；改名时就地更新其 name 字段。
export function loadScreen() {
  let id = '';
  let name = '';
  try {
    id = localStorage.getItem(SCREEN_ID_KEY) || '';
    name = localStorage.getItem(SCREEN_NAME_KEY) || '';
  } catch {
    id = '';
  }
  if (!/^s-[0-9a-zA-Z-]{8,64}$/.test(id)) {
    id = genScreenId();
    try {
      localStorage.setItem(SCREEN_ID_KEY, id);
    } catch {
      // 隐身模式等写入受限场景：本次会话内沿用内存 ID（刷新后会换 ID）
    }
  }
  if (!name.trim()) {
    name = defaultScreenName(id);
    try {
      localStorage.setItem(SCREEN_NAME_KEY, name);
    } catch {
      /* 同上 */
    }
  }
  return { id, name };
}

export function saveScreenName(id, name) {
  try {
    localStorage.setItem(SCREEN_NAME_KEY, name);
  } catch {
    /* 写入受限时仅在内存生效 */
  }
  return { id, name };
}
