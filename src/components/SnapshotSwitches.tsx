import { useRef, useState } from 'react';
import { isSnapshotDirty } from '../state/rigStore';
import { rigStore, useRig } from '../state/useRig';

const SLOT_NAMES = ['A', 'B', 'C', 'D'];
const SLOT_KEYS = ['Q', 'W', 'E', 'R'];
/** 长按清空阈值(ms) */
const LONG_PRESS_MS = 650;

/** 板载快照切换器:4 个金属踩钉 + LED(空=存入,亮=恢复;Shift+点=覆盖,长按=清空) */
export function SnapshotSwitches() {
  const snapshots = useRig((s) => s.snapshots);
  const activeSlot = useRig((s) => s.activeSlot);
  const activeDirty = useRig((s) => isSnapshotDirty(s, s.activeSlot));
  const timers = useRef<(ReturnType<typeof setTimeout> | null)[]>([null, null, null, null]);
  const longFired = useRef([false, false, false, false]);
  const [holding, setHolding] = useState<number | null>(null);

  const startHold = (i: number, filled: boolean) => () => {
    if (!filled) return;
    longFired.current[i] = false;
    setHolding(i);
    timers.current[i] = setTimeout(() => {
      timers.current[i] = null;
      longFired.current[i] = true;
      setHolding(null);
      rigStore.clearSnapshot(i);
    }, LONG_PRESS_MS);
  };

  const cancelHold = (i: number) => () => {
    if (timers.current[i] !== null) {
      clearTimeout(timers.current[i]!);
      timers.current[i] = null;
    }
    setHolding((h) => (h === i ? null : h));
  };

  return (
    <div className="snapshot-rail">
      <span className="screw screw-tl" />
      <span className="screw screw-tr" />
      <div className="snapshot-switches">
        {snapshots.map((snap, i) => {
          const filled = snap !== null;
          const active = i === activeSlot;
          const ledClass =
            holding === i
              ? 'led-holding'
              : active
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
                data-midi-target={`snapshot:${i}`}
                title={
                  filled
                    ? `${SLOT_NAMES[i]}:踩下恢复 · Shift+点击覆盖 · 长按清空(${SLOT_KEYS[i]} 快捷)`
                    : `${SLOT_NAMES[i]}:空槽,踩下存入当前状态`
                }
                onPointerDown={startHold(i, filled)}
                onPointerUp={cancelHold(i)}
                onPointerLeave={cancelHold(i)}
                onContextMenu={(e) => e.preventDefault()}
                onClick={(e) => {
                  if (longFired.current[i]) {
                    longFired.current[i] = false;
                    return;
                  }
                  if (e.shiftKey) {
                    rigStore.captureSnapshot(i);
                    return;
                  }
                  if (filled) void rigStore.recallSnapshot(i);
                  else rigStore.captureSnapshot(i);
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
