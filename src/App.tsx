import { useCallback, useEffect, useMemo, useState } from 'react';
import { audioEngine } from './audio/AudioEngine';
import type { InputSourceType } from './audio/AudioEngine';
import { getEffectDef } from './audio/effects';
import { getAmpDef } from './audio/amps';
import { getCabDef } from './audio/cabs';
import type { ChainItem, Preset } from './state/store';
import {
  createChainItem,
  chainToPreset,
  presetToChain,
  loadPresets,
  savePresets,
} from './state/store';
import { TopBar } from './components/TopBar';
import { ChainView } from './components/ChainView';
import { PresetBar } from './components/PresetBar';
import { AmpPanel } from './components/AmpPanel';
import { CabPanel } from './components/CabPanel';
import { Oscilloscope } from './components/Oscilloscope';
import { FluidBackground } from './components/FluidBackground';

const outputSelectSupported = 'setSinkId' in AudioContext.prototype;

function defaultChain(): ChainItem[] {
  return ['noiseGate', 'overdrive', 'delay', 'reverb', 'volume'].map((id) =>
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

  const [ampId, setAmpId] = useState('crunch');
  const [ampEnabled, setAmpEnabled] = useState(true);
  const [ampValues, setAmpValues] = useState<Record<string, number>>(() =>
    defaultAmpValues('crunch'),
  );

  const [cabId, setCabId] = useState('gb4x12');
  const [cabEnabled, setCabEnabled] = useState(true);
  const [cabValues, setCabValues] = useState<Record<string, number>>(() =>
    defaultCabValues('gb4x12'),
  );

  const [inputType, setInputType] = useState<InputSourceType | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const [inputGain, setInputGain] = useState(1);
  const [masterVolume, setMasterVolume] = useState(0.5);
  const [globalBypass, setGlobalBypass] = useState(false);

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

  // 仅在结构(增删/排序/开关/bypass/换箱头箱体)变化时重建音频图;参数连续调整走 updateParam
  const structureKey = useMemo(
    () =>
      chain.map((i) => `${i.uid}:${i.effectId}:${i.enabled}`).join('|') +
      `|bypass:${globalBypass}|amp:${ampId}:${ampEnabled}|cab:${cabId}:${cabEnabled}`,
    [chain, globalBypass, ampId, ampEnabled, cabId, cabEnabled],
  );

  useEffect(() => {
    audioEngine.setGlobalBypass(globalBypass);
    audioEngine.setChain(
      chain.map((item) => ({
        uid: item.uid,
        def: getEffectDef(item.effectId),
        enabled: item.enabled,
        values: item.values,
      })),
    );
    audioEngine.setAmp({
      def: getAmpDef(ampId),
      enabled: ampEnabled,
      values: ampValues,
    });
    audioEngine.setCab({
      def: getCabDef(cabId),
      enabled: cabEnabled,
      values: cabValues,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey]);

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
    setChain((cur) => [...cur, createChainItem(getEffectDef(effectId))]);
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
      next.splice(to, 0, moved);
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

  // ---------- 箱头 ----------

  const handleAmpSelect = useCallback((id: string) => {
    setAmpId(id);
    setAmpValues(defaultAmpValues(id));
  }, []);

  const handleAmpToggle = useCallback(() => {
    setAmpEnabled((e) => !e);
  }, []);

  const handleAmpParam = useCallback((key: string, value: number) => {
    setAmpValues((cur) => ({ ...cur, [key]: value }));
    audioEngine.updateAmpParam(key, value);
  }, []);

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
        const next = [...cur.filter((p) => p.name !== name), chainToPreset(name, chain)];
        savePresets(next);
        return next;
      });
    },
    [chain],
  );

  const handleLoadPreset = useCallback((name: string) => {
    setPresets((cur) => {
      const preset = cur.find((p) => p.name === name);
      if (preset) setChain(presetToChain(preset));
      return cur;
    });
  }, []);

  const handleDeletePreset = useCallback((name: string) => {
    setPresets((cur) => {
      const next = cur.filter((p) => p.name !== name);
      savePresets(next);
      return next;
    });
  }, []);

  // ---------- 渲染 ----------

  return (
    <div className="app">
      <FluidBackground analyser={engineReady ? audioEngine.outputAnalyser : null} />

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
        inputAnalyser={engineReady ? audioEngine.inputAnalyser : null}
        outputAnalyser={engineReady ? audioEngine.outputAnalyser : null}
      />

      <PresetBar
        presets={presets}
        onSave={handleSavePreset}
        onLoad={handleLoadPreset}
        onDelete={handleDeletePreset}
      />

      <main className="board">
        <ChainView
          items={chain}
          onReorder={handleReorder}
          onToggle={handleToggle}
          onRemove={handleRemove}
          onParam={handleParam}
          onAdd={handleAdd}
        />
      </main>

      <AmpPanel
        ampId={ampId}
        enabled={ampEnabled}
        values={ampValues}
        onSelect={handleAmpSelect}
        onToggle={handleAmpToggle}
        onParam={handleAmpParam}
      />

      <CabPanel
        cabId={cabId}
        enabled={cabEnabled}
        values={cabValues}
        onSelect={handleCabSelect}
        onToggle={handleCabToggle}
        onParam={handleCabParam}
      />

      <Oscilloscope
        inputAnalyser={engineReady ? audioEngine.inputAnalyser : null}
        outputAnalyser={engineReady ? audioEngine.outputAnalyser : null}
      />

      <footer className="app-footer">
        信号流向:输入 → {chain.map((i) => getEffectDef(i.effectId).name).join(' → ')}
        {ampEnabled && ` → ${getAmpDef(ampId).name}`}
        {cabEnabled && ` → ${getCabDef(cabId).name}`} → 输出
        {globalBypass && '(全局 Bypass 中)'}
        {!inputType && <span className="hint"> — 请在上方选择一个输入源开始</span>}
      </footer>
    </div>
  );
}
