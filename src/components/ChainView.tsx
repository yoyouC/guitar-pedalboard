import { useState } from 'react';
import type { ChainItem } from '../state/store';
import { getEffectDef } from '../audio/effects';
import { PedalCard } from './PedalCard';
import { AddEffectMenu } from './AddEffectMenu';

interface ChainViewProps {
  items: ChainItem[];
  onReorder: (from: number, to: number) => void;
  onToggle: (uid: string) => void;
  onRemove: (uid: string) => void;
  onParam: (uid: string, key: string, value: number) => void;
  onAdd: (effectId: string) => void;
}

/** 横向 pedalboard:按信号流向排列单块,支持 HTML5 拖拽排序 */
export function ChainView({
  items,
  onReorder,
  onToggle,
  onRemove,
  onParam,
  onAdd,
}: ChainViewProps) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  return (
    <div className="chain-view">
      {items.map((item, idx) => (
        <div
          key={item.uid}
          className={`pedal-slot ${overIndex === idx && dragIndex !== idx ? 'drag-over' : ''} ${
            dragIndex === idx ? 'dragging' : ''
          }`}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            setDragIndex(idx);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setOverIndex(idx);
          }}
          onDragLeave={() => setOverIndex((cur) => (cur === idx ? null : cur))}
          onDrop={(e) => {
            e.preventDefault();
            if (dragIndex !== null && dragIndex !== idx) onReorder(dragIndex, idx);
            setDragIndex(null);
            setOverIndex(null);
          }}
          onDragEnd={() => {
            setDragIndex(null);
            setOverIndex(null);
          }}
        >
          <PedalCard
            item={item}
            def={getEffectDef(item.effectId)}
            onToggle={onToggle}
            onRemove={onRemove}
            onParam={onParam}
          />
          {idx < items.length - 1 && <div className="patch-cable" />}
        </div>
      ))}
      <AddEffectMenu onAdd={onAdd} />
    </div>
  );
}
