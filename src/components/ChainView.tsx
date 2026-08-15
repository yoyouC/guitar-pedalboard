import { useState } from 'react';
import type { ChainItem } from '../state/store';
import { getEffectDef } from '../audio/effects';
import { audioEngine } from '../audio/AudioEngine';
import { rigStore, useRig } from '../state/useRig';
import { PedalCard } from './PedalCard';
import { AddEffectMenu } from './AddEffectMenu';

/** 横向 pedalboard:前置(箱头前)与 FX Loop(箱头后、箱体前)分区,拖拽排序/跨区 */
export function ChainView({ showMeters }: { showMeters: boolean }) {
  const items = useRig((s) => s.chain);
  // 图谱重建后重读引擎侧模块电平表节点引用
  useRig((s) => s.graphVersion);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [overDivider, setOverDivider] = useState(false);

  const preItems = items.filter((i) => !i.post);
  const postItems = items.filter((i) => i.post);

  const renderSlot = (item: ChainItem, idx: number, isLast: boolean) => (
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
        if (dragIndex !== null && dragIndex !== idx) rigStore.movePedal(dragIndex, idx);
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
        index={idx}
        analyser={audioEngine.getModuleAnalyser(item.uid)}
        showMeters={showMeters}
        onToggle={rigStore.togglePedal}
        onRemove={rigStore.removePedal}
        onParam={rigStore.setPedalParam}
        onToggleSlot={rigStore.setPedalPost}
      />
      {!isLast && <div className="patch-cable" />}
    </div>
  );

  return (
    <div className="chain-view">
      {preItems.map((item) => renderSlot(item, items.indexOf(item), false))}

      <div
        className={`fxloop-divider ${overDivider ? 'drag-over' : ''}`}
        title="FX Loop:箱头之后、箱体之前(拖到此处移入)"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setOverDivider(true);
        }}
        onDragLeave={() => setOverDivider(false)}
        onDrop={(e) => {
          e.preventDefault();
          if (dragIndex !== null) {
            const item = items[dragIndex];
            if (!item.post) rigStore.setPedalPost(item.uid);
          }
          setDragIndex(null);
          setOverIndex(null);
          setOverDivider(false);
        }}
      >
        <span className="fxloop-label">
          箱头
          <br />↓
          <br />
          FX LOOP
        </span>
      </div>

      {postItems.map((item) => renderSlot(item, items.indexOf(item), false))}
      <AddEffectMenu onAdd={rigStore.addPedal} />
    </div>
  );
}
