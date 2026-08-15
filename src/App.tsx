import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { audioEngine } from './audio/AudioEngine';
import { looperPrimaryCommand } from './audio/looperState';
import type { InputSourceType } from './audio/AudioEngine';
import { getEffectDef } from './audio/effects';
import { getAmpDef } from './audio/amps';
import { getCabDef } from './audio/cabs';
import {
  BUNDLED_WAVENET_MODELS,
  NAM_SWEEP_PACKS,
  loadNamWasmModelFromFile,
  setNamWasmModelSource,
  setNamWasmPack,
} from './audio/namWasm';
import { AMP_CATEGORIES, getAmpModelEntry } from './audio/ampCategories';
import { DEFAULT_RIG_ENCODED, decodeShareState, readShareFromLocation, writeShareToLocation } from './state/share';
import type { ChainItem, Preset, Snapshot } from './state/store';
import {
  createChainItem,
  currentRigToPreset,
  presetToRig,
  exportPresetsJson,
  importPresetsJson,
  loadPresets,
  savePresets,
  loadSnapshots,
  saveSnapshots,
} from './state/store';
import { useMidi } from './midi/useMidi';
import {
  bindingMatches,
  classifySource,
  loadMidiBindings,
  parseTarget,
  saveMidiBindings,
  upsertBinding,
  type MidiBinding,
  type MidiTarget,
} from './midi/midiLearn';
import type { ParsedMidiMessage } from './midi/midiMessage';
import { AMP_MASTER_RANGE, AMP_TONE_RANGE, type AmpParamKey } from './midi/midiMapping';
import { TopBar } from './components/TopBar';
import { Tuner } from './components/Tuner';
import { ChainView } from './components/ChainView';
import { PresetBar } from './components/PresetBar';
import { SnapshotSwitches } from './components/SnapshotSwitches';
import { AmpPanel } from './components/AmpPanel';
import { CabPanel } from './components/CabPanel';
import { Oscilloscope } from './components/Oscilloscope';
import { FluidBackground } from './components/FluidBackground';
import { YouTubeBackground } from './components/YouTubeBackground';
import { Analytics } from '@vercel/analytics/react';

const outputSelectSupported = 'setSinkId' in AudioContext.prototype;

/** 表情踏板可驱动的摇杆类踏板(position 语义统一:0=跟位,100=顶位) */
const EXPRESSION_TREADLE_IDS = new Set(['whammy', 'wahpedal', 'crybabywdf']);

function defaultChain(): ChainItem[] {
  return ['noiseGate', 'overdrive', 'volume', 'delay', 'reverb'].map((id) =>
    createChainItem(getEffectDef(id)),
  );
}

function defaultAmpValues(ampId: string): Record<string, number> {
  const values: Record<string, number> = {};
  for (const p of getAmpDef(ampId).params) values[p.key] = p.defaultValue;
  return values;
}

function defaultCabValues(cabId: string): Record<string, number> {
  const values: Record<string, number> = {};
  for (const p of getCabDef(cabId).params) values[p.key] = p.defaultValue;
  return values;
}

export default function App() {
  const [chain, setChain] = useState<ChainItem[]>(defaultChain);
  const [presets, setPresets] = useState<Preset[]>(loadPresets);

  // 快照(A/B/C/D 四槽,localStorage 持久化;activeSlot=-1 表示无激活槽)
  const [snapshots, setSnapshots] = useState<(Snapshot | null)[]>(loadSnapshots);
  const [activeSlot, setActiveSlot] = useState(-1);

  const [ampId, setAmpId] = useState('nam-wasm');
  const [ampEnabled, setAmpEnabled] = useState(true);
  const [ampValues, setAmpValues] = useState<Record<string, number>>(() =>
    defaultAmpValues('nam-wasm'),
  );

  const [cabId, setCabId] = useState('gb4x12');
  const [cabEnabled, setCabEnabled] = useState(true);
  const [cabValues, setCabValues] = useState<Record<string, number>>(() =>
    defaultCabValues('gb4x12'),
  );

  // 箱头分类(4 类)与每类记住的型号(key = `${kind}:${ref}`,见 ampCategories.ts)
  const [ampCategoryId, setAmpCategoryId] = useState('clean');
  const [ampModelKeys, setAmpModelKeys] = useState<Record<string, string>>({
    clean: 'nam-wasm:fender-twinverb',
    chime: 'nam-wasm:vox-ac15',
    crunch: 'nam-wasm:jcm2000-crunch',
    recto: 'nam-wasm:jcm900-g12',
  });

  // NAM 箱头:当前模型源 id(自定义文件时为 'custom')与模型版本(换模型 = 结构变化,重建音频图)
  const [namCustomName, setNamCustomName] = useState<string | null>(null);
  const [namVersion, setNamVersion] = useState(0);

  const [inputType, setInputType] = useState<InputSourceType | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  /** 音频图重建后 bump 一次,让 render 时读取引擎侧节点引用
   *  (preAmpAnalyser / ampAnalyser / moduleAnalysers)的组件拿到新实例 */
  const [, setGraphVersion] = useState(0);
  const [inputGain, setInputGain] = useState(1);
  const [masterVolume, setMasterVolume] = useState(0.5);
  const [globalBypass, setGlobalBypass] = useState(false);
  const [showMeters, setShowMeters] = useState(true);
  const [showTuner, setShowTuner] = useState(false);
  const [ytBgActive, setYtBgActive] = useState(false);

  // ---------- MIDI Learn(用户自定义映射,优先于默认映射) ----------
  const [midiBindings, setMidiBindings] = useState<MidiBinding[]>(loadMidiBindings);
  const [learnMode, setLearnMode] = useState(false);
  const [armedTarget, setArmedTarget] = useState<MidiTarget | null>(null);
  /** 开关型绑定从 CC 触发时的上升沿记忆(签名 → 上次值) */
  const midiEdgeRef = useRef(new Map<string, number>());

  useEffect(() => {
    saveMidiBindings(midiBindings);
  }, [midiBindings]);

  // Learn 模式:点击捕获(data-midi-target)→ armed;同时高亮可学控件
  useEffect(() => {
    document.body.classList.toggle('midi-learn-mode', learnMode);
    if (!learnMode) return;
    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-midi-target]');
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      const t = parseTarget(el.dataset.midiTarget ?? '');
      if (t) setArmedTarget(t);
    };
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.body.classList.remove('midi-learn-mode');
    };
  }, [learnMode]);

  // armed 控件高亮(链变化/目标变化时重扫)
  useEffect(() => {
    if (!learnMode) return;
    const sig = armedTarget ? JSON.stringify(armedTarget) : null;
    document.querySelectorAll<HTMLElement>('[data-midi-target]').forEach((el) => {
      const t = parseTarget(el.dataset.midiTarget ?? '');
      el.classList.toggle('midi-armed', sig !== null && JSON.stringify(t) === sig);
    });
  }, [learnMode, armedTarget, chain]);

  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState('');
  const [outputId, setOutputId] = useState('default');

  // ---------- 设备枚举 ----------

  const refreshDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setMicDevices(devices.filter((d) => d.kind === 'audioinput'));
      setOutputDevices(devices.filter((d) => d.kind === 'audiooutput'));
    } catch (e) {
      console.warn('枚举设备失败:', e);
    }
  }, []);

  useEffect(() => {
    refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () =>
      navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
  }, [refreshDevices]);

  // ---------- 链条 → 音频图同步 ----------

  // 仅在结构(增删/排序/开关/bypass/换箱头箱体/前后置)变化时重建音频图;参数连续调整走 updateParam
  const structureKey = useMemo(
    () =>
      chain.map((i) => `${i.uid}:${i.effectId}:${i.enabled}:${i.post}`).join('|') +
      `|bypass:${globalBypass}|amp:${ampId}:${ampEnabled}|cab:${cabId}:${cabEnabled}|namv:${namVersion}`,
    [chain, globalBypass, ampId, ampEnabled, cabId, cabEnabled, namVersion],
  );

  useEffect(() => {
    audioEngine.setGlobalBypass(globalBypass);
    audioEngine.setChain(
      chain.map((item) => ({
        uid: item.uid,
        def: getEffectDef(item.effectId),
        enabled: item.enabled,
        values: item.values,
        post: item.post,
      })),
    );
    audioEngine.setAmp({
      def: getAmpDef(ampId),
      enabled: ampEnabled,
      values: ampValues,
      // def+key 相同则重建复用箱头实例(避免 NAM 模型随单块变动重复加载)
      key: `${ampId}:${namVersion}`,
    });
    audioEngine.setCab({
      def: getCabDef(cabId),
      enabled: cabEnabled,
      values: cabValues,
    });
    // 引擎已重建,刷新依赖引擎侧节点引用的组件(背景/电平表)
    setGraphVersion((v) => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey]);

  // ---------- URL 分享(读 hash 还原 + 变更时同步) ----------

  // 启动时:若 URL 带 #p= 分享参数,还原配置(仅一次);
  // 无分享参数则用出厂初始预设(DEFAULT_RIG_ENCODED)
  const [initialShare] = useState(
    () => readShareFromLocation() ?? decodeShareState(DEFAULT_RIG_ENCODED),
  );
  useEffect(() => {
    if (!initialShare) return;
    setChain(initialShare.chain);
    setAmpCategoryId(initialShare.ampCategoryId);
    setAmpModelKeys((cur) => ({ ...cur, [initialShare.ampCategoryId]: initialShare.ampModelKey }));
    applyAmpModel(initialShare.ampModelKey);
    setAmpValues(initialShare.ampValues);
    setAmpEnabled(initialShare.ampEnabled);
    setCabId(initialShare.cabId);
    setCabValues(initialShare.cabValues);
    setCabEnabled(initialShare.cabEnabled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 配置变化 → 防抖同步到 URL hash(replaceState,不产生历史记录)
  useEffect(() => {
    const t = window.setTimeout(() => {
      writeShareToLocation({
        chain,
        ampCategoryId,
        ampModelKey: ampModelKeys[ampCategoryId],
        ampEnabled,
        ampValues,
        cabId,
        cabEnabled,
        cabValues,
      });
    }, 400);
    return () => window.clearTimeout(t);
  }, [chain, ampCategoryId, ampModelKeys, ampEnabled, ampValues, cabId, cabEnabled, cabValues]);

  /** 生成当前配置的分享 URL(同步 hash 并返回) */
  const handleShare = useCallback((): string => {
    return writeShareToLocation({
      chain,
      ampCategoryId,
      ampModelKey: ampModelKeys[ampCategoryId],
      ampEnabled,
      ampValues,
      cabId,
      cabEnabled,
      cabValues,
    });
  }, [chain, ampCategoryId, ampModelKeys, ampEnabled, ampValues, cabId, cabEnabled, cabValues]);

  // ---------- 输入源 ----------

  const afterEngineInit = useCallback(async () => {
    setEngineReady(true);
    audioEngine.setInputGain(inputGain);
    audioEngine.setMasterVolume(masterVolume);
    await refreshDevices();
  }, [inputGain, masterVolume, refreshDevices]);

  const handleSelectMic = useCallback(async () => {
    try {
      await audioEngine.useMic(micId || undefined);
      setInputType('mic');
      await afterEngineInit();
    } catch (e) {
      alert(`无法打开麦克风: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [micId, afterEngineInit]);

  const handleSelectFile = useCallback(
    async (file: File) => {
      try {
        await audioEngine.useFile(file);
        setInputType('file');
        await afterEngineInit();
      } catch (e) {
        alert(`无法解码音频文件: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [afterEngineInit],
  );

  const handleSelectTest = useCallback(async () => {
    await audioEngine.useTestTone();
    setInputType('test');
    await afterEngineInit();
  }, [afterEngineInit]);

  const handleStopInput = useCallback(() => {
    audioEngine.stopInput();
    setInputType(null);
  }, []);

  const handleMicChange = useCallback(
    (id: string) => {
      setMicId(id);
      if (inputType === 'mic') {
        audioEngine.useMic(id).catch((e) => console.warn('切换输入设备失败:', e));
      }
    },
    [inputType],
  );

  const handleOutputChange = useCallback(async (id: string) => {
    setOutputId(id);
    const ok = await audioEngine.setOutputDevice(id);
    if (!ok) console.warn('当前浏览器不支持选择输出设备');
  }, []);

  // ---------- 链条操作 ----------

  const handleAdd = useCallback((effectId: string) => {
    setChain((cur) => {
      const item = createChainItem(getEffectDef(effectId));
      // 保持平铺数组前置在前、后置在后:前置类插入分区边界,后置类追加到尾
      if (item.post) return [...cur, item];
      const boundary = cur.findIndex((i) => i.post);
      const next = [...cur];
      next.splice(boundary < 0 ? next.length : boundary, 0, item);
      return next;
    });
  }, []);

  const handleRemove = useCallback((uid: string) => {
    setChain((cur) => cur.filter((i) => i.uid !== uid));
  }, []);

  const handleToggle = useCallback((uid: string) => {
    setChain((cur) =>
      cur.map((i) => (i.uid === uid ? { ...i, enabled: !i.enabled } : i)),
    );
  }, []);

  const handleReorder = useCallback((from: number, to: number) => {
    setChain((cur) => {
      const next = [...cur];
      const [moved] = next.splice(from, 1);
      // 跨区拖动(目标位置属于另一分区)→ 同时翻转 post 归属
      const target = next[to] ?? next[to - 1];
      const moved2 = target && target.post !== moved.post ? { ...moved, post: target.post } : moved;
      next.splice(to, 0, moved2);
      return next;
    });
  }, []);

  /** 翻转前置/后置(FX Loop),并把该项移到目标分区末尾(保持平铺数组前置在前、后置在后) */
  const handleToggleSlot = useCallback((uid: string) => {
    setChain((cur) => {
      const idx = cur.findIndex((i) => i.uid === uid);
      if (idx < 0) return cur;
      const item = { ...cur[idx], post: !cur[idx].post };
      const next = cur.filter((i) => i.uid !== uid);
      const boundary = next.findIndex((i) => i.post);
      next.splice(boundary < 0 ? next.length : boundary, 0, item);
      return next;
    });
  }, []);

  const handleParam = useCallback((uid: string, key: string, value: number) => {
    setChain((cur) =>
      cur.map((i) =>
        i.uid === uid ? { ...i, values: { ...i.values, [key]: value } } : i,
      ),
    );
    audioEngine.updateParam(uid, key, value);
  }, []);

  // ---------- 快捷键 ----------

  /** 当前整机状态 → 快照对象 */
  const captureSnapshot = useCallback((): Snapshot => ({
    chain: chain.map(({ effectId, enabled, values, post }) => ({
      effectId,
      enabled,
      values: { ...values },
      post,
    })),
    ampId,
    ampEnabled,
    ampValues: { ...ampValues },
    cabId,
    cabEnabled,
    cabValues: { ...cabValues },
  }), [chain, ampId, ampEnabled, ampValues, cabId, cabEnabled, cabValues]);

  /** 存入指定槽位 */
  const storeSnapshot = useCallback((slot: number) => {
    setSnapshots((cur) => {
      const next = [...cur];
      next[slot] = captureSnapshot();
      saveSnapshots(next);
      return next;
    });
    setActiveSlot(slot);
  }, [captureSnapshot]);

  /** 从槽位恢复 */
  const recallSnapshot = useCallback((slot: number) => {
    const snap = snapshots[slot];
    if (!snap) return;
    setChain(
      snap.chain.map((item) => ({
        uid: crypto.randomUUID(),
        effectId: item.effectId,
        enabled: item.enabled,
        values: { ...item.values },
        post: item.post,
      })),
    );
    setAmpId(snap.ampId);
    setAmpEnabled(snap.ampEnabled);
    setAmpValues({ ...snap.ampValues });
    setCabId(snap.cabId);
    setCabEnabled(snap.cabEnabled);
    setCabValues({ ...snap.cabValues });
    setActiveSlot(slot);
  }, [snapshots]);

  /** 清空槽位 */
  const clearSnapshot = useCallback((slot: number) => {
    setSnapshots((cur) => {
      const next = [...cur];
      next[slot] = null;
      saveSnapshots(next);
      return next;
    });
    setActiveSlot((cur) => (cur === slot ? -1 : cur));
  }, []);

  /** 当前状态与激活槽是否一致(不一致显示"已修改"点) */
  const activeDirty = useMemo(() => {
    if (activeSlot < 0 || !snapshots[activeSlot]) return false;
    return JSON.stringify(captureSnapshot()) !== JSON.stringify(snapshots[activeSlot]);
  }, [activeSlot, snapshots, captureSnapshot]);

  // 数字键 1~9:按板上显示顺序(前置区 → FX Loop 区,即平铺数组顺序)切换单块开关;空格:全局 Bypass
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      // 输入控件聚焦时不触发
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      )
        return;
      if (e.code === 'Space') {
        e.preventDefault(); // 阻止页面滚动与焦点按钮的空格激活
        setGlobalBypass((b) => !b);
        return;
      }
      // Q/W/E/R → 恢复快照 A/B/C/D
      const slotKeys = ['KeyQ', 'KeyW', 'KeyE', 'KeyR'];
      const slotIdx = slotKeys.indexOf(e.code);
      if (slotIdx >= 0) {
        recallSnapshot(slotIdx);
        return;
      }
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= 9) {
        const item = chain[n - 1];
        if (item) handleToggle(item.uid);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [chain, handleToggle, recallSnapshot]);

  // ---------- 箱头 ----------

  // 应用一个箱头型号(key = `${kind}:${ref}`,见 ampCategories.ts;ref 为 'custom' 时源已由文件加载设置)
  const applyAmpModel = useCallback((key: string) => {
    const sep = key.indexOf(':');
    const kind = key.slice(0, sep);
    const ref = key.slice(sep + 1);
    if (kind === 'nam-wasm-pack') {
      const pack = NAM_SWEEP_PACKS[ref];
      if (pack) setNamWasmPack(pack);
      setAmpId('nam-wasm');
      setAmpValues(defaultAmpValues('nam-wasm'));
      setNamVersion((v) => v + 1);
    } else {
      const m = BUNDLED_WAVENET_MODELS.find((x) => x.id === ref);
      if (m) setNamWasmModelSource(m.url);
      setAmpId('nam-wasm');
      setAmpValues(defaultAmpValues('nam-wasm'));
      setNamVersion((v) => v + 1);
    }
  }, []);

  // 切分类 tab:恢复该类记住的型号
  const handleCategorySelect = useCallback(
    (categoryId: string) => {
      setAmpCategoryId(categoryId);
      applyAmpModel(ampModelKeys[categoryId] ?? AMP_CATEGORIES.find((c) => c.id === categoryId)!.models[0].key);
    },
    [ampModelKeys, applyAmpModel],
  );

  // 类内选型号:记住并应用
  const handleModelSelect = useCallback(
    (key: string) => {
      setAmpModelKeys((cur) => ({ ...cur, [ampCategoryId]: key }));
      applyAmpModel(key);
    },
    [ampCategoryId, applyAmpModel],
  );

  const handleAmpToggle = useCallback(() => {
    setAmpEnabled((e) => !e);
  }, []);

  const handleAmpParam = useCallback((key: string, value: number) => {
    setAmpValues((cur) => ({ ...cur, [key]: value }));
    audioEngine.updateAmpParam(key, value);
  }, []);

  // ---------- MIDI(Synido TempoKEY K25,映射表见 src/midi/midiMapping.ts) ----------

  /** 执行一条用户绑定(midiLearn):开关型用上升沿,连续型按 0..127 线性映射 */
  const executeMidiBinding = (b: MidiBinding, msg: ParsedMidiMessage): void => {
    const t = b.target;
    const sig = `${b.source}:${b.msgType}:${b.number}`;
    const edge = midiEdgeRef.current;
    const toggleFire = (): boolean => {
      if (msg.type === 'note') return msg.on;
      const last = edge.get(sig) ?? 0;
      edge.set(sig, msg.value);
      return msg.value > 63 && last <= 63;
    };
    const v01 = Math.max(0, Math.min(127, msg.value)) / 127;
    switch (t.kind) {
      case 'pedal-toggle': {
        if (!toggleFire()) return;
        const item = chain[t.index];
        if (item) handleToggle(item.uid);
        return;
      }
      case 'snapshot':
        if (toggleFire()) recallSnapshot(t.slot);
        return;
      case 'bypass':
        if (toggleFire()) setGlobalBypass((x) => !x);
        return;
      case 'looper-record':
        if (!toggleFire()) return;
        // 与 UI 主按钮同一状态机:初录→完成→叠录→完成叠录
        looperPrimaryCommand(audioEngine);
        return;
      case 'looper-play':
        if (toggleFire()) audioEngine.toggleLoopPlayback();
        return;
      case 'looper-clear':
        if (toggleFire()) audioEngine.clearLoop();
        return;
      case 'master-volume':
        setMasterVolume(v01);
        audioEngine.setMasterVolume(v01);
        return;
      case 'amp-param': {
        const range = t.key === 'master' ? AMP_MASTER_RANGE : AMP_TONE_RANGE;
        handleAmpParam(t.key as AmpParamKey, range.min + v01 * (range.max - range.min));
        return;
      }
      case 'pedal-treadle': {
        const item = chain[t.index];
        if (item) handleParam(item.uid, 'position', v01 * 100);
        return;
      }
      case 'pedal-param': {
        const item = chain[t.index];
        if (!item) return;
        const p = getEffectDef(item.effectId).params.find((x) => x.key === t.key);
        if (!p) return;
        handleParam(item.uid, t.key, p.min + v01 * (p.max - p.min));
        return;
      }
    }
  };

  // 回调每次渲染都新建,useMidi 内部用 ref 持有最新版本,MIDI 监听只挂一次
  const midi = useMidi({
    // MIDI Learn:学习绑定 / 用户绑定优先于默认映射
    beforeDefault: (msg, sourceName) => {
      const src = classifySource(sourceName);
      if (learnMode) {
        // learn 模式吞掉所有消息(防误触);有 armed 目标则生成绑定
        if (armedTarget && !(msg.type === 'note' && !msg.on)) {
          setMidiBindings((cur) =>
            upsertBinding(cur, {
              msgType: msg.type,
              number: msg.number,
              source: src,
              target: armedTarget,
            }),
          );
          setArmedTarget(null);
        }
        return true;
      }
      const b = midiBindings.find((x) => bindingMatches(x, msg, src));
      if (b) {
        executeMidiBinding(b, msg);
        return true;
      }
      return false;
    },
    togglePedal: (index) => {
      const item = chain[index];
      if (item) handleToggle(item.uid);
    },
    recallSnapshot,
    toggleBypass: () => setGlobalBypass((b) => !b),
    looperRecord: () => looperPrimaryCommand(audioEngine),
    looperTogglePlay: () => {
      audioEngine.toggleLoopPlayback();
    },
    looperClear: () => {
      audioEngine.clearLoop();
    },
    setMasterVolume: (v) => {
      setMasterVolume(v);
      audioEngine.setMasterVolume(v);
    },
    setAmpParam: (key, value) => handleAmpParam(key, value),
    // motion_midi 踩钉:按板上顺序绝对设置第 N 块单块开关(Toggle 状态在发送方维护)
    setPedalEnabled: (index, enabled) => {
      setChain((cur) => cur.map((item, i) => (i === index ? { ...item, enabled } : item)));
    },
    // motion_midi 表情踏板:CC11 → 第 1 块、CC12 → 第 2 块摇杆类踏板
    // (whammy/wahpedal/crybabywdf 的 position)。不做音量/Master 兜底:
    // 表情踏板静止=0,兜底到音量类参数会把输出拉到最底(嘴闭=静音)
    setExpression: (index, t) => {
      const treadles = chain.filter((item) => EXPRESSION_TREADLE_IDS.has(item.effectId));
      const target = treadles[index];
      if (target) handleParam(target.uid, 'position', t * 100);
    },
  });

  // NAM:加载本地 .nam 模型(WASM Core 支持全架构),成功后置为当前类的型号
  const handleNamModelFile = useCallback(
    async (file: File) => {
      try {
        const model = await loadNamWasmModelFromFile(file);
        setNamCustomName(model.displayName);
        setAmpModelKeys((cur) => ({ ...cur, [ampCategoryId]: `nam-wasm:custom` }));
        setNamVersion((v) => v + 1);
      } catch (e) {
        alert(`加载 .nam 模型失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [ampCategoryId],
  );

  // ---------- 箱体 ----------

  const handleCabSelect = useCallback((id: string) => {
    setCabId(id);
    setCabValues(defaultCabValues(id));
  }, []);

  const handleCabToggle = useCallback(() => {
    setCabEnabled((e) => !e);
  }, []);

  const handleCabParam = useCallback((key: string, value: number) => {
    setCabValues((cur) => ({ ...cur, [key]: value }));
    audioEngine.updateCabParam(key, value);
  }, []);

  // ---------- 预设 ----------

  const handleSavePreset = useCallback(
    (name: string) => {
      setPresets((cur) => {
        const preset = currentRigToPreset(name, {
          chain,
          amp: {
            categoryId: ampCategoryId,
            modelKey: ampModelKeys[ampCategoryId],
            enabled: ampEnabled,
            values: ampValues,
            customName: ampModelKeys[ampCategoryId] === 'nam-wasm:custom'
              ? namCustomName
              : null,
          },
          cab: {
            id: cabId,
            enabled: cabEnabled,
            values: cabValues,
          },
          globals: {
            inputGain,
            masterVolume,
            bypass: globalBypass,
          },
        });
        const next = [...cur.filter((p) => p.name !== name), preset];
        savePresets(next);
        return next;
      });
    },
    [
      chain,
      ampCategoryId,
      ampModelKeys,
      ampEnabled,
      ampValues,
      namCustomName,
      cabId,
      cabEnabled,
      cabValues,
      inputGain,
      masterVolume,
      globalBypass,
    ],
  );

  const handleLoadPreset = useCallback(
    (name: string) => {
      const preset = presets.find((candidate) => candidate.name === name);
      if (!preset) return;
      const rig = presetToRig(preset);
      if (
        rig.amp.modelKey === 'nam-wasm:custom' &&
        (!rig.amp.customName || rig.amp.customName !== namCustomName)
      ) {
        alert(
          `预设需要自定义 NAM 模型“${rig.amp.customName ?? '未知模型'}”。` +
          '请先在箱头区域重新载入对应的 .nam 文件。',
        );
        return;
      }

      setChain(rig.chain);
      setAmpCategoryId(rig.amp.categoryId);
      setAmpModelKeys((cur) => ({
        ...cur,
        [rig.amp.categoryId]: rig.amp.modelKey,
      }));
      applyAmpModel(rig.amp.modelKey);
      setAmpValues(rig.amp.values);
      setAmpEnabled(rig.amp.enabled);
      setCabId(rig.cab.id);
      setCabValues(rig.cab.values);
      setCabEnabled(rig.cab.enabled);
      setInputGain(rig.globals.inputGain);
      setMasterVolume(rig.globals.masterVolume);
      setGlobalBypass(rig.globals.bypass);
      for (const [key, value] of Object.entries(rig.amp.values)) {
        audioEngine.updateAmpParam(key, value);
      }
      for (const [key, value] of Object.entries(rig.cab.values)) {
        audioEngine.updateCabParam(key, value);
      }
      audioEngine.setInputGain(rig.globals.inputGain);
      audioEngine.setMasterVolume(rig.globals.masterVolume);
    },
    [presets, namCustomName, applyAmpModel],
  );

  const handleDeletePreset = useCallback((name: string) => {
    setPresets((cur) => {
      const next = cur.filter((p) => p.name !== name);
      savePresets(next);
      return next;
    });
  }, []);

  const handleImportPresets = useCallback((text: string): number => {
    const imported = importPresetsJson(text);
    setPresets((current) => {
      // 同名项以导入文件为准，其余本地预设保留。
      const merged = new Map(current.map((preset) => [preset.name, preset]));
      for (const preset of imported) merged.set(preset.name, preset);
      const next = [...merged.values()];
      savePresets(next);
      return next;
    });
    return imported.length;
  }, []);

  const handleExportPresets = useCallback(
    () => exportPresetsJson(presets),
    [presets],
  );

  // ---------- 渲染 ----------

  return (
    <div className="app">
      {!ytBgActive && (
        <FluidBackground analyser={engineReady ? (audioEngine.preAmpAnalyser ?? audioEngine.outputAnalyser) : null} />
      )}
      <YouTubeBackground onActiveChange={setYtBgActive} />
      <Analytics />

      <header className="app-header">
        <h1>🎸 Guitar Pedalboard</h1>
      </header>

      <TopBar
        inputType={inputType}
        onSelectMic={handleSelectMic}
        onSelectFile={handleSelectFile}
        onSelectTest={handleSelectTest}
        onStopInput={handleStopInput}
        micDevices={micDevices}
        micId={micId}
        onMicChange={handleMicChange}
        outputDevices={outputDevices}
        outputId={outputId}
        onOutputChange={handleOutputChange}
        outputSelectSupported={outputSelectSupported}
        inputGain={inputGain}
        onInputGain={(v) => {
          setInputGain(v);
          audioEngine.setInputGain(v);
        }}
        masterVolume={masterVolume}
        onMasterVolume={(v) => {
          setMasterVolume(v);
          audioEngine.setMasterVolume(v);
        }}
        globalBypass={globalBypass}
        onToggleBypass={() => setGlobalBypass((b) => !b)}
        showMeters={showMeters}
        onToggleMeters={() => setShowMeters((m) => !m)}
        showTuner={showTuner}
        onToggleTuner={() => setShowTuner((t) => !t)}
        midi={midi}
        midiLearn={{
          learnMode,
          armedTarget,
          bindings: midiBindings,
          onToggleLearn: () => {
            setLearnMode((m) => !m);
            setArmedTarget(null);
          },
          onDisarm: () => setArmedTarget(null),
          onDeleteBinding: (i) => setMidiBindings((cur) => cur.filter((_, j) => j !== i)),
          onClearBindings: () => setMidiBindings([]),
        }}
        inputAnalyser={engineReady ? audioEngine.inputAnalyser : null}
        outputAnalyser={engineReady ? audioEngine.outputAnalyser : null}
        engineReady={engineReady}
      />

      {/* 调音表:下拉面板,不占效果链位置 */}
      {showTuner && <Tuner analyser={engineReady ? audioEngine.inputAnalyser : null} />}

      <PresetBar
        presets={presets}
        onSave={handleSavePreset}
        onLoad={handleLoadPreset}
        onDelete={handleDeletePreset}
        onImport={handleImportPresets}
        onExport={handleExportPresets}
        onShare={handleShare}
      />

      <main className="board">
        <SnapshotSwitches
          snapshots={snapshots}
          activeSlot={activeSlot}
          activeDirty={activeDirty}
          onRecall={recallSnapshot}
          onStore={storeSnapshot}
          onClear={clearSnapshot}
        />
        <ChainView
          items={chain}
          showMeters={showMeters}
          onReorder={handleReorder}
          onToggle={handleToggle}
          onRemove={handleRemove}
          onParam={handleParam}
          onAdd={handleAdd}
          onToggleSlot={handleToggleSlot}
        />
      </main>

      <AmpPanel
        categoryId={ampCategoryId}
        modelKey={ampModelKeys[ampCategoryId]}
        enabled={ampEnabled}
        values={ampValues}
        analyser={engineReady ? audioEngine.ampAnalyser : null}
        showMeters={showMeters}
        onCategorySelect={handleCategorySelect}
        onModelSelect={handleModelSelect}
        onToggle={handleAmpToggle}
        onParam={handleAmpParam}
        namCustomName={namCustomName}
        onNamModelFile={handleNamModelFile}
      />

      <CabPanel
        cabId={cabId}
        enabled={cabEnabled}
        values={cabValues}
        analyser={engineReady ? audioEngine.cabAnalyser : null}
        showMeters={showMeters}
        onSelect={handleCabSelect}
        onToggle={handleCabToggle}
        onParam={handleCabParam}
      />

      <Oscilloscope
        inputAnalyser={engineReady ? audioEngine.inputAnalyser : null}
        outputAnalyser={engineReady ? audioEngine.outputAnalyser : null}
        showMeters={showMeters}
      />

      <footer className="app-footer">
        信号流向:输入 → {chain
          .filter((i) => !i.post)
          .map((i) => getEffectDef(i.effectId).name)
          .join(' → ')}
        {ampEnabled &&
          ` → ${getAmpModelEntry(ampModelKeys[ampCategoryId])?.name ?? getAmpDef(ampId).name}`}
        {chain.filter((i) => i.post).length > 0 &&
          ` → [FX Loop] ${chain
            .filter((i) => i.post)
            .map((i) => getEffectDef(i.effectId).name)
            .join(' → ')}`}
        {cabEnabled && ` → ${getCabDef(cabId).name}`} → 输出
        {globalBypass && '(全局 Bypass 中)'}
        {!inputType && <span className="hint"> — 请在上方选择一个输入源开始</span>}
        {' · '}
        <a href="models/ATTRIBUTION.md" target="_blank" rel="noreferrer">
          模型许可
        </a>
      </footer>
    </div>
  );
}
