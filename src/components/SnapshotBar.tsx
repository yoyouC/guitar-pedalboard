import type { Snapshot } from '../state/store';

interface SnapshotBarProps {
  snapshots: (Snapshot | null)[];
  activeSlot: number;
  /** 当前状态与激活槽不一致(已修改) */
  activeDirty: boolean;
  onRecall: (slot: number) => void;
  onStore: (slot: number) => void;
  onClear: (slot: number) => void;
}

const SLOT_NAMES = ['A', 'B', 'C', 'D'];
const SLOT_KEYS = ['Q', 'W', 'E', 'R'];

/** 快照槽位条:4 槽(空=存入,有=恢复;Shift+点=覆盖,Alt+点=清空) */
export function SnapshotBar({
  snapshots,
  activeSlot,
  activeDirty,
  onRecall,
  onStore,
  onClear,
}: SnapshotBarProps) {
  return (
    <div className="snapshot-bar">
      <span className="section-title">快照</span>
      {snapshots.map((snap, i) => {
        const filled = snap !== null;
        const active = i === activeSlot;
        return (
          <button
            key={i}
            className={`snapshot-slot ${active ? 'active' : ''} ${filled ? 'filled' : 'empty'}`}
            title={
              filled
                ? `${SLOT_NAMES[i]}:点击恢复 · Shift+点击覆盖当前 · Alt+点击清空(${SLOT_KEYS[i]} 快捷恢复)`
                : `${SLOT_NAMES[i]}:空槽,点击存入当前状态`
            }
            onClick={(e) => {
              if (e.altKey) {
                onClear(i);
                return;
              }
              if (e.shiftKey) {
                onStore(i);
                return;
              }
              if (filled) onRecall(i);
              else onStore(i);
            }}
          >
            <span className="snapshot-name">{SLOT_NAMES[i]}</span>
            {filled && <span className="snapshot-dot" />}
            {active && activeDirty && <span className="snapshot-dirty" title="已修改(与快照不一致)">●</span>}
          </button>
        );
      })}
      <span className="snapshot-hint" title="Q/W/E/R 恢复快照;Shift+点覆盖;Alt+点清空">
        Q/W/E/R 切换
      </span>
    </div>
  );
}
