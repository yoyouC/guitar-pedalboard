import { useState } from 'react';
import type { ChainItem } from '../state/store';
import { getEffectDef } from '../audio/effects';
import { audioEngine } from '../audio/AudioEngine';
import { rigStore, useRig } from '../state/useRig';
import { PedalCard } from './PedalCard';
import { AddEffectMenu } from './AddEffectMenu';
import { TONE3000_PEDAL_EFFECT_ID } from '../audio/effects/namPedal';
import { Tone3000Selector } from './Tone3000Selector';
import { tone3000Rig, useTone3000Rig } from '../tone3000/useTone3000Rig';
import { getCachedToneInfo } from '../tone3000/toneInfoCache';

/** 横向 pedalboard:前置(箱头前)与 FX Loop(箱头后、箱体前)分区,拖拽排序/跨区 */
export function ChainView({ showMeters }: { showMeters: boolean }) {
  const items = useRig((s) => s.chain);
  // 图谱重建后重读引擎侧模块电平表节点引用
  useRig((s) => s.graphVersion);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [overDivider, setOverDivider] = useState(false);
  const [selector, setSelector] = useState<
    | { kind: 'add' }
    | { kind: 'replace'; uid: string; repair?: boolean }
    | { kind: 'sample'; uid: string }
    | null
  >(null);
  const toneTargets = useTone3000Rig((state) => state.targets);

  const preItems = items.filter((i) => !i.post);
  const postItems = items.filter((i) => i.post);

  const renderSlot = (item: ChainItem, idx: number, isLast: boolean) => {
    const runtime = toneTargets[`pedal:${item.uid}`];
    const cachedInfo = item.modelRef?.startsWith('tone3000:')
      ? getCachedToneInfo(item.modelRef.slice('tone3000:'.length), window.localStorage)
      : null;
    const tone3000State = runtime
      ? runtime.info || !cachedInfo
        ? runtime
        : { ...runtime, info: cachedInfo }
      : undefined;
    return (
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
        tone3000State={tone3000State}
        onReplaceTone3000={(uid) => setSelector({ kind: 'replace', uid })}
        onSwitchTone3000Sample={(uid) => {
          void tone3000Rig.preparePedalSampleSwitch(uid).then((result) => {
            if (!result.ok) {
              window.alert(`TONE3000 采样列表加载失败：${result.message}`);
            } else if (result.status === 'choose') {
              setSelector({ kind: 'sample', uid });
            }
          });
        }}
        onRepairTone3000={(uid) => {
          const target = tone3000Rig.getState().targets[`pedal:${uid}`];
          if (target?.reason === 'tone-unavailable') {
            setSelector({ kind: 'replace', uid, repair: true });
          } else if (target?.reason === 'not-authenticated') {
            void tone3000Rig.login();
          } else {
            void tone3000Rig.retryAll();
          }
        }}
      />
      {!isLast && <div className="patch-cable" />}
    </div>
    );
  };

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
      <AddEffectMenu
        onAdd={(effectId) => {
          if (effectId === TONE3000_PEDAL_EFFECT_ID) setSelector({ kind: 'add' });
          else rigStore.addPedal(effectId);
        }}
      />
      {selector && (
        <Tone3000Selector
          intent={
            selector.kind === 'add'
              ? { kind: 'add-pedal' }
              : { kind: 'replace-pedal', uid: selector.uid }
          }
          currentToneId={
            selector.kind !== 'add'
              ? rigStore.getState().chain.find((item) => item.uid === selector.uid)?.modelRef?.slice('tone3000:'.length)
              : null
          }
          loadToneId={
            selector.kind === 'replace' && selector.repair
              ? rigStore.getState().chain.find((item) => item.uid === selector.uid)?.modelRef?.slice('tone3000:'.length)
              : undefined
          }
          onClose={() => setSelector(null)}
        />
      )}
    </div>
  );
}
