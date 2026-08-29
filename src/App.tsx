import { useCallback, useEffect, useState } from 'react';
import { audioEngine } from './audio/AudioEngine';
import { looperPrimaryCommand } from './audio/looperState';
import type { InputSourceType } from './audio/AudioEngine';
import { rigToShareState } from './state/rigStore';
import { encodeShareState, writeShareToLocation } from './state/share';
import { rigStore, useRig } from './state/useRig';
import { useMidi } from './midi/useMidi';
import { createBindingTranslator, resolveKeyAction } from './midi/rigAction';
import { createRigDispatcher } from './midi/rigDispatcher';
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
import { TopBar } from './components/TopBar';
import { Tuner } from './components/Tuner';
import { ChainView } from './components/ChainView';
import { PresetBar } from './components/PresetBar';
import { SnapshotSwitches } from './components/SnapshotSwitches';
import { AmpPanel } from './components/AmpPanel';
import { CabPanel } from './components/CabPanel';
import { PreAmpEqPanel } from './components/PreAmpEqPanel';
import { Oscilloscope } from './components/Oscilloscope';
import { FluidBackground } from './components/FluidBackground';
import { PrismBackground } from './components/PrismBackground';
import { MeddleBackground } from './components/MeddleBackground';
import { YouTubeBackground } from './components/YouTubeBackground';
import { RigFooter } from './components/RigFooter';
import { Tone3000RedirectSelection } from './components/Tone3000RedirectSelection';
import { Analytics } from '@vercel/analytics/react';
import type { AudioDiagnosticsSnapshot } from './audio/audioDiagnostics';
import { resolveAppRoute } from './app/route.ts';
import { ApplicationHeader } from './components/ApplicationHeader.tsx';
import { ApplicationRoute } from './components/ApplicationRoute.tsx';
import {
  BACKGROUND_THEMES,
  loadAppPreferences,
  saveAppPreferences,
  type BackgroundTheme,
} from './app/preferences.ts';
import { memberSession } from './members/session.ts';

const outputSelectSupported = 'setSinkId' in AudioContext.prototype;

/** 背景主题:Meddle(水下之耳,默认)/ 棱镜(Pink Floyd)/ 流体,点击循环切换 */
const BG_THEME_LABEL: Record<BackgroundTheme, string> = {
  meddle: 'Meddle(水下之耳)',
  prism: '棱镜(Pink Floyd)',
  fluid: '流体',
};
const BG_THEME_ICON: Record<BackgroundTheme, string> = { meddle: '👂', prism: '🔺', fluid: '🌊' };

/**
 * 统一 RigAction 分发器(ADR-0004):MIDI 默认映射 / MIDI Learn / 键盘
 * 三路触发源翻译出的 action 都经它落在 rigStore verb 上。模块级创建一次。
 */
const dispatchRigAction = createRigDispatcher({
  store: rigStore,
  looper: {
    primary: () => looperPrimaryCommand(audioEngine),
    togglePlay: () => audioEngine.toggleLoopPlayback(),
    clear: () => audioEngine.clearLoop(),
  },
});

/** Learn 绑定翻译器:持有 per-binding 的 CC 沿检测状态(原 midiEdgeRef 的职责) */
const translateMidiBinding = createBindingTranslator();

/**
 * App 是 shell:Rig 状态的单一事实源在 rigStore(见 ADR-0002),
 * 组件经 useRig 直接订阅;App 只保留输入源/设备枚举/纯 UI 开关/MIDI Learn 状态,
 * 以及两个投影:URL hash 同步(防抖订阅)与 Learn 绑定翻译(翻译 + dispatch)。
 */
export default function App() {
  const [pathname, setPathname] = useState(window.location.pathname);
  const [search, setSearch] = useState(window.location.search);
  const route = resolveAppRoute(pathname);
  const isPedalboard = route.kind === 'pedalboard';
  const [inputType, setInputType] = useState<InputSourceType | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const [showMeters, setShowMeters] = useState(true);
  const [showTuner, setShowTuner] = useState(false);
  const [ytBgActive, setYtBgActive] = useState(false);
  const [preferences, setPreferences] = useState(loadAppPreferences);
  const bgTheme = preferences.background;
  const reduceVisualLoad = preferences.reduceVisualLoad;
  const [diagnostics, setDiagnostics] = useState<AudioDiagnosticsSnapshot>(audioEngine.currentDiagnostics);
  const effectiveShowMeters = showMeters && !reduceVisualLoad;
  const effectiveShowTuner = showTuner && !reduceVisualLoad;

  useEffect(() => {
    const syncPathname = () => {
      setPathname(window.location.pathname);
      setSearch(window.location.search);
    };
    window.addEventListener('popstate', syncPathname);
    return () => window.removeEventListener('popstate', syncPathname);
  }, []);

  const navigate = useCallback((nextPathname: string) => {
    const next = new URL(nextPathname, window.location.origin);
    const returnPathAlreadyCarriesSession = next.pathname === '/login'
      && next.searchParams.has('return');
    if (!nextPathname.includes('#') && !returnPathAlreadyCarriesSession) {
      next.hash = window.location.hash;
    }
    window.history.pushState(null, '', `${next.pathname}${next.search}${next.hash}`);
    setPathname(next.pathname);
    setSearch(next.search);
  }, []);

  useEffect(() => {
    saveAppPreferences(preferences);
    document.documentElement.lang = preferences.locale;
    document.documentElement.classList.toggle('reduced-motion', preferences.reducedMotion);
  }, [preferences]);

  useEffect(() => { void memberSession.load(); }, []);

  useEffect(() => audioEngine.subscribeDiagnostics(setDiagnostics), []);

  // 图谱重建后 bump:让 render 时读取引擎侧节点引用(preAmpAnalyser)的组件拿到新实例,
  // 同时驱动 Learn 模式的 armed 高亮重扫(data-midi-target 只随结构变化)
  const graphVersion = useRig((s) => s.graphVersion);

  // ---------- MIDI Learn(用户自定义映射,优先于默认映射) ----------
  const [midiBindings, setMidiBindings] = useState<MidiBinding[]>(loadMidiBindings);
  const [learnMode, setLearnMode] = useState(false);
  const [armedTarget, setArmedTarget] = useState<MidiTarget | null>(null);

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

  // 数字键 1~9:按板上显示顺序(前置区 → FX Loop 区,即平铺数组顺序)切换单块开关;
  // Q/W/E/R:快照 A..D;空格:全局 Bypass。翻译 + dispatch,与 MIDI 同一词汇表
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // 输入控件聚焦时不触发
      const el = e.target as HTMLElement | null;
      const editing = !!(
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      );
      const action = resolveKeyAction({
        code: e.code,
        key: e.key,
        repeat: e.repeat,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        editing,
      });
      if (!action) return;
      if (e.code === 'Space') e.preventDefault(); // 阻止页面滚动与焦点按钮的空格激活
      dispatchRigAction(action);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // ---------- MIDI(Synido TempoKEY K25,映射表见 src/midi/midiMapping.ts) ----------

  // 回调每次渲染都新建,useMidi 内部用 ref 持有最新版本,MIDI 监听只挂一次
  const midi = useMidi({
    dispatch: dispatchRigAction,
    // MIDI Learn:学习绑定 / 用户绑定优先于默认映射;命中绑定经翻译层 → RigAction → 统一 dispatch
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
      if (!b) return false;
      const action = translateMidiBinding(b, msg, rigStore.getState().chain);
      if (action) dispatchRigAction(action);
      return true;
    },
  });

  // ---------- 渲染 ----------

  return (
    <div className={`app ${isPedalboard ? 'app--pedalboard' : 'app--content'}`}>
      <Analytics />

      {isPedalboard && !reduceVisualLoad && !preferences.reducedMotion && !ytBgActive &&
        (bgTheme === 'prism' ? (
          <PrismBackground analyser={engineReady ? (audioEngine.preAmpAnalyser ?? audioEngine.outputAnalyser) : null} />
        ) : bgTheme === 'fluid' ? (
          <FluidBackground analyser={engineReady ? (audioEngine.preAmpAnalyser ?? audioEngine.outputAnalyser) : null} />
        ) : (
          <MeddleBackground analyser={engineReady ? (audioEngine.preAmpAnalyser ?? audioEngine.outputAnalyser) : null} />
        ))}
      {isPedalboard && (
        <YouTubeBackground
          disabled={reduceVisualLoad || preferences.reducedMotion}
          onActiveChange={setYtBgActive}
        />
      )}

      {isPedalboard && !reduceVisualLoad && !preferences.reducedMotion && (
        <button
          className="bg-theme-toggle"
          title={`切换背景:${BG_THEME_LABEL[BACKGROUND_THEMES[(BACKGROUND_THEMES.indexOf(bgTheme) + 1) % BACKGROUND_THEMES.length]]}`}
          onClick={() =>
            setPreferences((current) => ({
              ...current,
              background: BACKGROUND_THEMES[(BACKGROUND_THEMES.indexOf(current.background) + 1) % BACKGROUND_THEMES.length],
            }))
          }
        >
          {BG_THEME_ICON[bgTheme]}
        </button>
      )}

      <ApplicationHeader
        section={route.section}
        locale={preferences.locale}
        engineReady={engineReady}
        inputType={inputType}
        onNavigate={navigate}
        onStopInput={handleStopInput}
      />

      {isPedalboard ? (
        <>
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
            showMeters={effectiveShowMeters}
            onToggleMeters={() => setShowMeters((m) => !m)}
            showTuner={effectiveShowTuner}
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
            diagnostics={diagnostics}
            reduceVisualLoad={reduceVisualLoad}
            onReduceVisualLoadChange={(enabled) => setPreferences((current) => ({
              ...current,
              reduceVisualLoad: enabled,
            }))}
          />

          {effectiveShowTuner && (
            <Tuner analyser={engineReady ? audioEngine.inputAnalyser : null} />
          )}

          <PresetBar onNavigate={navigate} />

          <main className="board">
            <SnapshotSwitches />
            <ChainView showMeters={effectiveShowMeters} />
          </main>

          <PreAmpEqPanel />
          <AmpPanel showMeters={effectiveShowMeters} engineReady={engineReady} />
          <CabPanel showMeters={effectiveShowMeters} engineReady={engineReady} />

          {!reduceVisualLoad && !preferences.reducedMotion && (
            <Oscilloscope
              inputAnalyser={engineReady ? audioEngine.inputAnalyser : null}
              outputAnalyser={engineReady ? audioEngine.outputAnalyser : null}
              showMeters={effectiveShowMeters}
            />
          )}

          <RigFooter inputType={inputType} />
        </>
      ) : (
        <main className="app-route" data-route={route.kind}>
          <ApplicationRoute
            route={route}
            pathname={pathname}
            search={search}
            onNavigate={navigate}
            preferences={preferences}
            onPreferencesChange={setPreferences}
            diagnostics={diagnostics}
            engineReady={engineReady}
            midi={midi}
            midiBindings={midiBindings}
            onClearMidiBindings={() => setMidiBindings([])}
          />
        </main>
      )}

      <Tone3000RedirectSelection />
    </div>
  );
}
