import { useCallback, useEffect, useRef, useState } from 'react';
import { audioEngine } from './audio/AudioEngine';
import { looperPrimaryCommand } from './audio/looperState';
import type { InputSourceType } from './audio/AudioEngine';
import { getEffectDef } from './audio/effects';
import { rigToShareState } from './state/rigStore';
import { encodeShareState, writeShareToLocation } from './state/share';
import { rigStore, useRig } from './state/useRig';
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
import { RigFooter } from './components/RigFooter';
import { Analytics } from '@vercel/analytics/react';

const outputSelectSupported = 'setSinkId' in AudioContext.prototype;

/** 表情踏板可驱动的摇杆类踏板(position 语义统一:0=跟位,100=顶位) */
const EXPRESSION_TREADLE_IDS = new Set(['whammy', 'wahpedal', 'crybabywdf']);

/**
 * App 是 shell:Rig 状态的单一事实源在 rigStore(见 ADR-0002),
 * 组件经 useRig 直接订阅;App 只保留输入源/设备枚举/纯 UI 开关/MIDI Learn 状态,
 * 以及两个投影:URL hash 同步(防抖订阅)与 MIDI 绑定执行(调 rigStore verb)。
 */
export default function App() {
  const [inputType, setInputType] = useState<InputSourceType | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const [showMeters, setShowMeters] = useState(true);
  const [showTuner, setShowTuner] = useState(false);
  const [ytBgActive, setYtBgActive] = useState(false);

  // 图谱重建后 bump:让 render 时读取引擎侧节点引用(preAmpAnalyser)的组件拿到新实例,
  // 同时驱动 Learn 模式的 armed 高亮重扫(data-midi-target 只随结构变化)
  const graphVersion = useRig((s) => s.graphVersion);

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

  // armed 控件高亮(链结构变化/目标变化时重扫)
  useEffect(() => {
    if (!learnMode) return;
    const sig = armedTarget ? JSON.stringify(armedTarget) : null;
    document.querySelectorAll<HTMLElement>('[data-midi-target]').forEach((el) => {
      const t = parseTarget(el.dataset.midiTarget ?? '');
      el.classList.toggle('midi-armed', sig !== null && JSON.stringify(t) === sig);
    });
  }, [learnMode, armedTarget, graphVersion]);

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

  // ---------- URL 分享:rigStore 的防抖订阅投影 ----------

  // 配置变化 → 400ms 防抖同步到 URL hash(replaceState,不产生历史记录);
  // 只跟随分享字段(链条/箱头/箱体),增益/音量/快照等变化不触发
  useEffect(() => {
    let timer: number | null = null;
    let lastEncoded = encodeShareState(rigToShareState(rigStore.getState()));
    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        writeShareToLocation(rigToShareState(rigStore.getState()));
      }, 400);
    };
    schedule(); // 挂载时同步一次(语义同旧 effect 首跑)
    const unsubscribe = rigStore.subscribe(() => {
      const encoded = encodeShareState(rigToShareState(rigStore.getState()));
      if (encoded === lastEncoded) return;
      lastEncoded = encoded;
      schedule();
    });
    return () => {
      unsubscribe();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  // ---------- 输入源 ----------

  const afterEngineInit = useCallback(async () => {
    setEngineReady(true);
    // 引擎 init 前的 verb 调用被引擎层容忍(丢弃),init 后补写一次全局参数
    const s = rigStore.getState();
    audioEngine.setInputGain(s.inputGain);
    audioEngine.setMasterVolume(s.masterVolume);
    await refreshDevices();
  }, [refreshDevices]);

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

  // ---------- 快捷键 ----------

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
        rigStore.setGlobalBypass(!rigStore.getState().globalBypass);
        return;
      }
      // Q/W/E/R → 恢复快照 A/B/C/D
      const slotKeys = ['KeyQ', 'KeyW', 'KeyE', 'KeyR'];
      const slotIdx = slotKeys.indexOf(e.code);
      if (slotIdx >= 0) {
        rigStore.recallSnapshot(slotIdx);
        return;
      }
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= 9) {
        const item = rigStore.getState().chain[n - 1];
        if (item) rigStore.togglePedal(item.uid);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // ---------- MIDI(Synido TempoKEY K25,映射表见 src/midi/midiMapping.ts) ----------

  /** 执行一条用户绑定(midiLearn):开关型用上升沿,连续型按 0..127 线性映射;rig 修改走 rigStore verb */
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
    const { chain } = rigStore.getState();
    switch (t.kind) {
      case 'pedal-toggle': {
        if (!toggleFire()) return;
        const item = chain[t.index];
        if (item) rigStore.togglePedal(item.uid);
        return;
      }
      case 'snapshot':
        if (toggleFire()) rigStore.recallSnapshot(t.slot);
        return;
      case 'bypass':
        if (toggleFire()) rigStore.setGlobalBypass(!rigStore.getState().globalBypass);
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
        rigStore.setMasterVolume(v01);
        return;
      case 'amp-param': {
        const range = t.key === 'master' ? AMP_MASTER_RANGE : AMP_TONE_RANGE;
        rigStore.setAmpParam(t.key as AmpParamKey, range.min + v01 * (range.max - range.min));
        return;
      }
      case 'pedal-treadle': {
        const item = chain[t.index];
        if (item) rigStore.setPedalParam(item.uid, 'position', v01 * 100);
        return;
      }
      case 'pedal-param': {
        const item = chain[t.index];
        if (!item) return;
        const p = getEffectDef(item.effectId).params.find((x) => x.key === t.key);
        if (!p) return;
        rigStore.setPedalParam(item.uid, t.key, p.min + v01 * (p.max - p.min));
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
      const item = rigStore.getState().chain[index];
      if (item) rigStore.togglePedal(item.uid);
    },
    recallSnapshot: (slot) => rigStore.recallSnapshot(slot),
    toggleBypass: () => rigStore.setGlobalBypass(!rigStore.getState().globalBypass),
    looperRecord: () => looperPrimaryCommand(audioEngine),
    looperTogglePlay: () => {
      audioEngine.toggleLoopPlayback();
    },
    looperClear: () => {
      audioEngine.clearLoop();
    },
    setMasterVolume: (v) => rigStore.setMasterVolume(v),
    setAmpParam: (key, value) => rigStore.setAmpParam(key, value),
    // motion_midi 踩钉:按板上顺序绝对设置第 N 块单块开关(Toggle 状态在发送方维护)
    setPedalEnabled: (index, enabled) => {
      const item = rigStore.getState().chain[index];
      if (item) rigStore.setPedalEnabled(item.uid, enabled);
    },
    // motion_midi 表情踏板:CC11 → 第 1 块、CC12 → 第 2 块摇杆类踏板
    // (whammy/wahpedal/crybabywdf 的 position)。不做音量/Master 兜底:
    // 表情踏板静止=0,兜底到音量类参数会把输出拉到最底(嘴闭=静音)
    setExpression: (index, t) => {
      const treadles = rigStore
        .getState()
        .chain.filter((item) => EXPRESSION_TREADLE_IDS.has(item.effectId));
      const target = treadles[index];
      if (target) rigStore.setPedalParam(target.uid, 'position', t * 100);
    },
  });

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

      <PresetBar />

      <main className="board">
        <SnapshotSwitches />
        <ChainView showMeters={showMeters} />
      </main>

      <AmpPanel showMeters={showMeters} engineReady={engineReady} />

      <CabPanel showMeters={showMeters} engineReady={engineReady} />

      <Oscilloscope
        inputAnalyser={engineReady ? audioEngine.inputAnalyser : null}
        outputAnalyser={engineReady ? audioEngine.outputAnalyser : null}
        showMeters={showMeters}
      />

      <RigFooter inputType={inputType} />
    </div>
  );
}
