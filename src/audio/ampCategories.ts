import { BUNDLED_WAVENET_MODELS, NAM_SWEEP_PACKS } from './namWasm';

/**
 * 箱头分类(4 类,对应 4 个箱头皮肤 amp-clean/chime/crunch/recto):
 * 每类一个 tab,类内可再选具体型号(内置手工建模 / NAM WASM / 增益扫档包)。
 *
 * 型号寻址:`${kind}:${ref}`,kind ∈ builtin(AMP_REGISTRY 的手工箱头 id)/
 * nam-wasm(BUNDLED_WAVENET_MODELS id)/
 * nam-wasm-pack(NAM_SWEEP_PACKS id);
 * 自定义文件加载用 `${kind}:custom`(源已由 loadNam*FromFile 设置)。
 */
export type AmpModelKind = 'builtin' | 'nam-wasm' | 'nam-wasm-pack' | 'tone3000';

export interface AmpModelEntry {
  key: string;
  name: string;
  kind: AmpModelKind;
  /** builtin: 箱头 def id;nam-*: 对应 BUNDLED 清单的模型 id */
  ref: string;
}

export interface AmpCategory {
  /** 前四类与皮肤 CSS 类同名(amp-clean/chime/crunch/recto);tone3000 无专属皮肤,UI 侧 fallback */
  id: 'clean' | 'chime' | 'crunch' | 'recto' | 'tone3000';
  name: string;
  models: AmpModelEntry[];
}

const builtin = (ref: string, name: string): AmpModelEntry => ({ key: `builtin:${ref}`, name, kind: 'builtin', ref });
const wasm = (ref: string, name: string): AmpModelEntry => ({ key: `nam-wasm:${ref}`, name, kind: 'nam-wasm', ref });
const wasmPack = (ref: string): AmpModelEntry => ({
  key: `nam-wasm-pack:${ref}`,
  name: NAM_SWEEP_PACKS[ref]?.name ?? ref,
  kind: 'nam-wasm-pack',
  ref,
});

/** 扫档包条目(已获授权,随 git 发布) */
const sweepEntry = (ref: string): AmpModelEntry[] => [wasmPack(ref)];

const WASM_NAME = new Map(BUNDLED_WAVENET_MODELS.map((m) => [m.id, m.name]));

export const AMP_CATEGORIES: AmpCategory[] = [
  {
    id: 'clean',
    name: 'Fender Clean',
    models: [
      builtin('clean', 'Clean Twin(内置建模)'),
      builtin('wdfchamp', 'WDF Champ ⚗(WDF 电路建模)'),
      builtin('wdftwin', 'WDF Twin ⚗(WDF 电路建模)'),
      builtin('wdfjc120', 'WDF JC-120 ⚗(WDF 电路建模)'),
      ...sweepEntry('bassman-sweep'),
      wasm('fender-twinverb', WASM_NAME.get('fender-twinverb')!),
      wasm('wavenet-deluxe', WASM_NAME.get('wavenet-deluxe')!),
      wasm('peavey-5152-clean', WASM_NAME.get('peavey-5152-clean')!),
      wasm('deluxe-3x24', WASM_NAME.get('deluxe-3x24')!),
      wasm('lstm-demo', WASM_NAME.get('lstm-demo')!),
      wasm('ref-2x16', WASM_NAME.get('ref-2x16')!),
    ],
  },
  {
    id: 'chime',
    name: 'Vox',
    models: [
      builtin('chime', 'AC Chime(内置建模)'),
      builtin('wdfac30', 'WDF AC30 ⚗(WDF 电路建模)'),
      wasm('wavenet-ac10', WASM_NAME.get('wavenet-ac10')!),
      wasm('vox-ac15', WASM_NAME.get('vox-ac15')!),
    ],
  },
  {
    id: 'crunch',
    name: 'Marshall Crunch',
    models: [
      builtin('crunch', 'British Crunch(内置建模)'),
      wasm('jcm2000-clean', WASM_NAME.get('jcm2000-clean')!),
      wasm('jcm2000-crunch', WASM_NAME.get('jcm2000-crunch')!),
      ...sweepEntry('jcm800-sweep'),
      ...sweepEntry('dualterror-sweep'),
      wasm('bug1990-lead', WASM_NAME.get('bug1990-lead')!),
      wasm('sovtek-mig50', WASM_NAME.get('sovtek-mig50')!),
      wasm('orange-rockerverb', WASM_NAME.get('orange-rockerverb')!),
      wasm('laney-gh100s', WASM_NAME.get('laney-gh100s')!),
      wasm('friedman-shirley-clean', WASM_NAME.get('friedman-shirley-clean')!),
      wasm('boss-1x16', WASM_NAME.get('boss-1x16')!),
      wasm('boss-2x16', WASM_NAME.get('boss-2x16')!),
    ],
  },
  {
    id: 'recto',
    name: 'High Gain',
    models: [
      builtin('recto', 'Modern Recto(内置建模)'),
      builtin('wdfbogner', 'WDF Bogner ⚗(WDF 电路建模)'),
      ...sweepEntry('evh-green-sweep'),
      ...sweepEntry('recto-red-sweep'),
      wasm('jcm900-g12', WASM_NAME.get('jcm900-g12')!),
      wasm('jcm900-g16', WASM_NAME.get('jcm900-g16')!),
      wasm('5150-blockletter', WASM_NAME.get('5150-blockletter')!),
      wasm('6505-red', WASM_NAME.get('6505-red')!),
    ],
  },
  {
    // TONE3000(ADR-0007):外部 NAM 模型平台,型号经 OAuth Select 流程选择,
    // 列表为空——UI(AmpPanel 的 tone3000 分支)渲染登录/浏览/当前模型卡片
    id: 'tone3000',
    name: 'TONE3000',
    models: [],
  },
];

export function getAmpModelEntry(key: string): AmpModelEntry | null {
  for (const c of AMP_CATEGORIES) {
    const found = c.models.find((m) => m.key === key);
    if (found) return found;
  }
  return null;
}

/** 型号所属分类(如 builtin:crunch → crunch 分类) */
export function getAmpModelCategory(key: string): AmpCategory | null {
  for (const c of AMP_CATEGORIES) {
    if (c.models.some((m) => m.key === key)) return c;
  }
  return null;
}
