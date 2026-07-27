export type LooperPhase =
  | 'empty'
  | 'recording'
  | 'playing'
  | 'overdubbing'
  | 'stopped';

export type LooperCommand =
  | 'record'
  | 'finish-record'
  | 'overdub'
  | 'finish-overdub'
  | 'toggle-play'
  | 'undo'
  | 'clear';

export const MAX_LOOP_SECONDS = 120;

export interface LooperStatus {
  available: boolean;
  phase: LooperPhase;
  lengthSeconds: number;
  positionSeconds: number;
  canUndo: boolean;
  /** 例如达到最长录制时间时，由处理器给出的短提示。 */
  message: string | null;
}

export const INITIAL_LOOPER_STATUS: LooperStatus = {
  available: false,
  phase: 'empty',
  lengthSeconds: 0,
  positionSeconds: 0,
  canUndo: false,
  message: null,
};

/** 主线程与 UI 共用的命令守卫，避免发送没有语义的状态切换。 */
export function canRunLooperCommand(
  status: LooperStatus,
  command: LooperCommand,
): boolean {
  if (!status.available) return false;
  switch (command) {
    case 'record':
      return status.phase === 'empty';
    case 'finish-record':
      return status.phase === 'recording';
    case 'overdub':
      return status.phase === 'playing' || status.phase === 'stopped';
    case 'finish-overdub':
      return status.phase === 'overdubbing';
    case 'toggle-play':
      return status.phase === 'playing' || status.phase === 'stopped';
    case 'undo':
      return status.canUndo &&
        (status.phase === 'playing' || status.phase === 'stopped');
    case 'clear':
      return status.phase !== 'empty';
  }
}

export function formatLooperTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}
