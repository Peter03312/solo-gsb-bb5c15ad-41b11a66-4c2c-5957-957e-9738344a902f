// 投屏场景编排纯函数单测：node test/scenes.test.mjs
import assert from 'node:assert/strict';
import {
  MAX_SCENES,
  MODULE_KEYS,
  LAYOUTS,
  MODULE_SIZES,
  defaultScenes,
  normalizeScene,
  normalizeSceneLibrary,
  sceneLibrarySignature,
  findScene,
} from '../server/src/scenes.js';

let n = 0;
const check = (name, fn) => { fn(); n += 1; console.log(`  ✓ ${name}`); };

check('默认场景：1 个、含 4 个模块配置、倒计时+议程默认启用', () => {
  const ds = defaultScenes();
  assert.equal(ds.length, 1);
  for (const key of MODULE_KEYS) {
    assert.ok(ds[0].modules[key], `缺少模块 ${key}`);
    assert.ok(MODULE_SIZES.includes(ds[0].modules[key].size));
  }
  assert.equal(ds[0].modules.countdown.enabled, true);
  assert.equal(ds[0].modules.agenda.enabled, true);
  assert.equal(ds[0].modules.cue.enabled, false);
  assert.equal(ds[0].modules.markers.enabled, false);
  assert.ok(LAYOUTS.includes(ds[0].layout));
});

check('规范化单场景：trim 名称、非法布局回退 stack、非法尺寸回退 md；缺省模块禁用', () => {
  const r = normalizeScene({
    id: 'sc-1',
    name: '  主持模式  ',
    layout: 'bogus',
    modules: { countdown: { enabled: true, size: 'huge' }, agenda: { enabled: 1 } },
  });
  assert.ok(r.value);
  assert.equal(r.value.name, '主持模式');
  assert.equal(r.value.layout, 'stack');
  assert.equal(r.value.modules.countdown.size, 'md');
  assert.equal(r.value.modules.agenda.enabled, true);
  assert.equal(r.value.modules.cue.enabled, false);
  assert.equal(r.value.modules.markers.enabled, false);
});

check('空名称按序号补“场景 N”；缺失 id 自动生成', () => {
  const r = normalizeScene({ name: '   ', modules: { countdown: { enabled: true } } }, 2);
  assert.equal(r.value.name, '场景 3');
  assert.match(r.value.id, /^sc-/);
});

check('所有模块均未启用返回 BAD_SCENE', () => {
  const r = normalizeScene({ name: '空', modules: { countdown: { enabled: false } } });
  assert.equal(r.error, 'BAD_SCENE');
});

check('场景库：非数组 / 空数组 / 超过 8 个均被拒', () => {
  assert.equal(normalizeSceneLibrary(null).error, 'BAD_SCENE');
  assert.equal(normalizeSceneLibrary([]).error, 'BAD_SCENE');
  const tooMany = Array.from({ length: MAX_SCENES + 1 }, (_, i) => ({
    name: `s${i}`, modules: { countdown: { enabled: true } },
  }));
  assert.equal(normalizeSceneLibrary(tooMany).error, 'BAD_SCENE');
});

check('场景库：恰好 8 个合法；重复 id 自动去重', () => {
  const lib = Array.from({ length: MAX_SCENES }, (_, i) => ({
    id: 'sc-dup', name: `场景 ${i}`, modules: { cue: { enabled: true } },
  }));
  const r = normalizeSceneLibrary(lib);
  assert.ok(r.scenes);
  assert.equal(r.scenes.length, 8);
  const ids = new Set(r.scenes.map((s) => s.id));
  assert.equal(ids.size, 8);
});

check('库内任一场景非法模块组合（全禁用）整库拒绝', () => {
  const r = normalizeSceneLibrary([
    { name: 'A', modules: { countdown: { enabled: true } } },
    {
      name: 'B',
      modules: {
        countdown: { enabled: false }, agenda: { enabled: false },
        cue: { enabled: false }, markers: { enabled: false },
      },
    },
  ]);
  assert.equal(r.error, 'BAD_SCENE');
});

check('签名：内容一致签名相同（无变化保存不递增版本）；改名后签名不同', () => {
  const a = normalizeSceneLibrary([{ name: 'X', layout: 'grid', modules: { agenda: { enabled: true, size: 'lg' } } }]).scenes;
  const b = normalizeSceneLibrary([{ name: 'X', layout: 'grid', modules: { agenda: { enabled: true, size: 'lg' } } }]).scenes;
  // b 的 id 会重新生成，用 a 自身深拷贝比较签名口径
  const clone = JSON.parse(JSON.stringify(a));
  assert.equal(sceneLibrarySignature(a), sceneLibrarySignature(clone));
  clone[0].name = 'Y';
  assert.notEqual(sceneLibrarySignature(a), sceneLibrarySignature(clone));
  assert.ok(findScene(b, b[0].id));
  assert.equal(findScene(b, 'sc-missing'), null);
});

console.log(`\n场景编排纯函数单测：${n} 通过，0 失败`);
