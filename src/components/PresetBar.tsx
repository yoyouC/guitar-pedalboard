import { useState } from 'react';
import type { Preset } from '../state/store';

interface PresetBarProps {
  presets: Preset[];
  onSave: (name: string) => void;
  onLoad: (name: string) => void;
  onDelete: (name: string) => void;
  /** 生成当前配置的分享 URL */
  onShare: () => string;
}

/** 链条预设:保存/读取/删除(localStorage)+ URL 分享 */
export function PresetBar({ presets, onSave, onLoad, onDelete, onShare }: PresetBarProps) {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState('');
  const [shared, setShared] = useState(false);

  const handleShare = async () => {
    const url = onShare();
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

  return (
    <div className="preset-bar">
      <span className="section-title">预设</span>
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
      <button disabled={!selected} onClick={() => onLoad(selected)}>
        加载
      </button>
      <button disabled={!selected} onClick={() => { onDelete(selected); setSelected(''); }}>
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
          onSave(name.trim());
          setName('');
        }}
      >
        保存当前链
      </button>
      <span className="preset-divider" />
      <button className={shared ? 'active' : ''} title="复制当前配置(链条+箱头+箱体)的分享链接" onClick={handleShare}>
        {shared ? '✓ 已复制' : '🔗 分享'}
      </button>
    </div>
  );
}
