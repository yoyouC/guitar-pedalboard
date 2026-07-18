import { useCallback, useRef } from 'react';

interface KnobProps {
  value: number;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  label: string;
  unit?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}

const START_ANGLE = -135;
const END_ANGLE = 135;
/** 垂直拖动多少像素走完全量程 */
const DRAG_PIXELS = 150;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function snap(v: number, step: number, min: number): number {
  return min + Math.round((v - min) / step) * step;
}

function formatValue(v: number, unit?: string): string {
  const s = Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
  return unit ? `${s}${unit}` : s;
}

/** 拟物旋转旋钮:垂直拖动调值,滚轮微调,双击回默认 */
export function Knob({
  value,
  min,
  max,
  step,
  defaultValue,
  label,
  unit,
  disabled,
  onChange,
}: KnobProps) {
  const dragState = useRef<{ startY: number; startValue: number } | null>(null);

  const emit = useCallback(
    (raw: number) => {
      const next = clamp(snap(raw, step, min), min, max);
      if (next !== value) onChange(Number(next.toFixed(6)));
    },
    [min, max, step, value, onChange],
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
      const dy = drag.startY - e.clientY;
      emit(drag.startValue + (dy / DRAG_PIXELS) * (max - min));
    },
    [emit, min, max],
  );

  const onPointerUp = useCallback(() => {
    dragState.current = null;
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (disabled) return;
      const dir = e.deltaY < 0 ? 1 : -1;
      emit(value + dir * step * (e.shiftKey ? 10 : 1));
    },
    [disabled, emit, value, step],
  );

  const onDoubleClick = useCallback(() => {
    if (!disabled) onChange(defaultValue);
  }, [disabled, defaultValue, onChange]);

  const ratio = (value - min) / (max - min);
  const angle = START_ANGLE + ratio * (END_ANGLE - START_ANGLE);

  // 刻度点
  const ticks = [];
  for (let i = 0; i <= 10; i++) {
    const a = START_ANGLE + (i / 10) * (END_ANGLE - START_ANGLE);
    ticks.push(
      <span
        key={i}
        className={`knob-tick ${i / 10 <= ratio ? 'tick-active' : ''}`}
        style={{ transform: `rotate(${a}deg) translateY(-34px)` }}
      />,
    );
  }

  return (
    <div className={`knob-unit ${disabled ? 'knob-disabled' : ''}`}>
      <div
        className="knob-dial"
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        tabIndex={disabled ? -1 : 0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') emit(value + step);
          if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') emit(value - step);
        }}
      >
        {ticks}
        <div
          className="knob-body"
          style={{ transform: `translate(-50%, -50%) rotate(${angle}deg)` }}
        >
          <div className="knob-indicator" />
        </div>
      </div>
      <div className="knob-label">{label}</div>
      <div className="knob-value">{formatValue(value, unit)}</div>
    </div>
  );
}
