import type { Snapshot } from '../state/store';

interface SnapshotSwitchesProps {
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

/** 板载快照切换器:4 个金属踩钉 + LED(空=存入,亮=恢复;Shift+点=覆盖,Alt+点=清空) */
export function SnapshotSwitches({
  snapshots,
  activeSlot,
  activeDirty,
  onRecall,
  onStore,
  onClear,
}: SnapshotSwitchesProps) {
  return (
    <div className="snapshot-rail">
      <span className="screw screw-tl" />
      <span className="screw screw-tr" />
      <div className="snapshot-switches">
        {snapshots.map((snap, i) => {
          const filled = snap !== null;
          const active = i === activeSlot;
          const ledClass = active
            ? activeDirty
              ? 'led-dirty'
              : 'led-active'
            : filled
              ? 'led-filled'
              : '';
          return (
            <div className="snapshot-switch" key={i}>
              <span className={`snapshot-led ${ledClass}`} />
              <button
                className={`footswitch snapshot-fs ${active ? 'fs-on' : ''}`}
                title={
                  filled
                    ? `${SLOT_NAMES[i]}:踩下恢复 · Shift+点击覆盖 · Alt+点击清空(${SLOT_KEYS[i]} 快捷)`
                    : `${SLOT_NAMES[i]}:空槽,踩下存入当前状态`
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
                <span className="footswitch-cap" />
              </button>
              <span className="snapshot-letter">{SLOT_NAMES[i]}</span>
            </div>
          );
        })}
      </div>
      <span className="snapshot-plate">SNAPSHOT · Q/W/E/R</span>
    </div>
  );
}
