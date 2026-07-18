import { useState } from 'react';
import type { Preset } from '../state/store';

interface PresetBarProps {
  presets: Preset[];
  onSave: (name: string) => void;
  onLoad: (name: string) => void;
  onDelete: (name: string) => void;
}

/** 链条预设:保存/读取/删除(localStorage) */
export function PresetBar({ presets, onSave, onLoad, onDelete }: PresetBarProps) {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState('');

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
    </div>
  );
}
