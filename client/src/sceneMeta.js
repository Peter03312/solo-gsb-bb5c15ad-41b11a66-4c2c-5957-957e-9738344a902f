// 投屏场景编排的客户端共享常量（与服务端 server/src/scenes.js 口径一致）
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
