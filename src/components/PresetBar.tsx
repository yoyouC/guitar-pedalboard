import { useRef, useState } from 'react';
import { rigToShareState } from '../state/rigStore';
import { rigToPresetState } from '../state/rigStore';
import { writeShareToLocation } from '../state/share';
import { rigStore, useRig } from '../state/useRig';
import { createPublishDraft } from '../marketplace/publishDraft.ts';

interface PresetBarProps {
  onNavigate(pathname: string): void;
}

/** 完整 Rig 预设:localStorage 持久化、JSON 导入导出、URL 分享与显式广场发布。 */
export function PresetBar({ onNavigate }: PresetBarProps) {
  const presets = useRig((s) => s.presets);
  const importRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState('');
  const [shared, setShared] = useState(false);
  const [transferStatus, setTransferStatus] = useState('');

  const handleLoad = async (presetName: string) => {
    const result = await rigStore.loadPreset(presetName);
    if (!result.ok && result.message) alert(result.message);
  };

  /** 生成当前配置的分享 URL(同步 hash 并返回) */
  const handleShare = async () => {
    const url = writeShareToLocation(rigToShareState(rigStore.getState()));
    let copied = false;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch {
      // 剪贴板不可用(权限/非安全上下文):退化为 prompt 供手动复制
      window.prompt('复制以下链接:', url);
      copied = true;
    }
    if (copied) {
      setShared(true);
      window.setTimeout(() => setShared(false), 2000);
    }
  };

  const handleImport = async (file: File) => {
    try {
      const count = rigStore.importPresets(await file.text());
      setTransferStatus(`✓ 已导入 ${count} 个`);
    } catch (error) {
      setTransferStatus(
        `导入失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const handleExport = () => {
    const blob = new Blob([rigStore.exportPresets()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `guitar-pedalboard-presets-${stamp}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setTransferStatus(`✓ 已导出 ${presets.length} 个`);
  };

  return (
    <div className="preset-bar">
      <span className="section-title">Rig 预设</span>
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
      >
        <option value="" disabled>
          选择预设…
        </option>
        {presets.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name}
          </option>
        ))}
      </select>
      <button disabled={!selected} onClick={() => void handleLoad(selected)}>
        加载
      </button>
      <button disabled={!selected} onClick={() => { rigStore.deletePreset(selected); setSelected(''); }}>
        删除
      </button>
      <span className="preset-divider" />
      <input
        type="text"
        placeholder="新预设名称"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button
        disabled={!name.trim()}
        onClick={() => {
          const presetName = name.trim();
          rigStore.savePreset(presetName);
          setSelected(presetName);
          setName('');
        }}
      >
        保存整套 Rig
      </button>
      <span className="preset-divider" />
      <button onClick={() => importRef.current?.click()}>
        导入 JSON
      </button>
      <input
        ref={importRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleImport(file);
          event.target.value = '';
        }}
      />
      <button disabled={presets.length === 0} onClick={handleExport}>
        导出全部
      </button>
      {transferStatus && (
        <span
          className={transferStatus.startsWith('导入失败') ? 'preset-status error' : 'preset-status'}
          role="status"
        >
          {transferStatus}
        </span>
      )}
      <span className="preset-divider" />
      <button className={shared ? 'active' : ''} title="复制当前配置(链条+箱头+箱体)的分享链接" onClick={handleShare}>
        {shared ? '✓ 已复制' : '🔗 分享'}
      </button>
      <button onClick={() => {
        const state = rigStore.getState();
        createPublishDraft(rigToPresetState(state), state.provenance);
        onNavigate('/publish');
      }}>发布当前 Rig</button>
      <button onClick={() => void rigStore.startFromFactoryRig()}>从出厂 Rig 开始</button>
      <button onClick={() => void rigStore.startFromBlankRig()}>从空白 Rig 开始</button>
    </div>
  );
}
