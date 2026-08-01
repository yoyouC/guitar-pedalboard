import { useCallback, useRef } from 'react';

interface WahTreadleProps {
  /** 0(跟位/低沉)~ 100(顶位/明亮) */
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}

const MIN = 0;
const MAX = 100;
/** 垂直拖动多少像素走完全行程 */
const DRAG_PIXELS = 110;
/** 摇杆倾斜角:跟位后仰,顶位前倾 */
const HEEL_ANGLE = 16;
const TOE_ANGLE = -14;

function clamp(v: number): number {
  return Math.min(MAX, Math.max(MIN, v));
}

/** 哇音踏板摇杆:垂直拖动模拟脚踩,滚轮微调,双击回中位 */
export function WahTreadle({ value, disabled, onChange }: WahTreadleProps) {
  const dragState = useRef<{ startY: number; startValue: number } | null>(null);

  const emit = useCallback(
    (raw: number) => {
      const next = clamp(Math.round(raw));
      if (next !== value) onChange(next);
    },
    [value, onChange],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragState.current = { startY: e.clientY, startValue: value };
    },
    [disabled, value],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragState.current;
      if (!drag) return;
      // 向下拖 = 踩下去 = 值变大
      const dy = e.clientY - drag.startY;
      emit(drag.startValue + (dy / DRAG_PIXELS) * (MAX - MIN));
    },
    [emit],
  );

  const onPointerUp = useCallback(() => {
    dragState.current = null;
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (disabled) return;
      const dir = e.deltaY > 0 ? 1 : -1;
      emit(value + dir * (e.shiftKey ? 10 : 2));
    },
    [disabled, emit, value],
  );

  const ratio = (value - MIN) / (MAX - MIN);
  const angle = HEEL_ANGLE + ratio * (TOE_ANGLE - HEEL_ANGLE);

  return (
    <div className={`wah-treadle ${disabled ? 'wah-disabled' : ''}`}>
      <div
        className="wah-rocker-area"
        role="slider"
        aria-label="Wah 踏板位置"
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        aria-valuenow={value}
        tabIndex={disabled ? -1 : 0}
        title="拖动模拟踩踏板(向下=踩亮),双击回中位"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onDoubleClick={() => !disabled && onChange(50)}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === 'ArrowUp') emit(value - 2);
          if (e.key === 'ArrowDown') emit(value + 2);
        }}
      >
        <div className="wah-rocker" style={{ transform: `rotateX(${angle}deg)` }}>
          <div className="wah-grip" />
          <div className="wah-badge">WAH</div>
        </div>
      </div>
      <div className="wah-value">{Math.round(value)}%</div>
    </div>
  );
}
