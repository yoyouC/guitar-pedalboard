/**
 * 电平管理公共约定与工具。
 *
 * 全链统一:
 * - 各级 Level/Master 旋钮使用 dB 域(听觉线性),0dB = unity(不增不减)。
 * - 标称参考电平:吉他 DI 峰值 -18 ~ -12dBFS(≈ 模拟设备的 0VU),
 *   失真/箱头等非线性级的"甜点"按此校准(见 INPUT_TARGET_DB)。
 * - 各效果器 Level 默认值经离线校准,使默认参数下接通 ≈ 旁通响度
 *   (scripts/calibrate-levels.mjs 用内置 guitar-riff.wav 标定)。
 */

/** dB → 线性增益 */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** 效果器 Level / 箱头 Master 旋钮的 dB 行程 */
export const LEVEL_DB_MIN = -30;
export const LEVEL_DB_MAX = 6;

/** 音量踏板专属的更深行程下限(需要大衰减做音量踏板 swells) */
export const VOLUME_DB_MIN = -60;

/**
 * Level 旋钮值(dB)→ 输出增益,钳制在旋钮行程内。
 * 钳制同时保证旧预设遗留的越界值(如 0~100 百分比域)不会映射成危险增益。
 */
export function levelDbToGain(db: number, min = LEVEL_DB_MIN, max = LEVEL_DB_MAX): number {
  return dbToGain(Math.min(max, Math.max(min, db)));
}

/** 输入电平校准目标区(dBFS 峰值),输入电平表据此绘制目标带 */
export const INPUT_TARGET_DB: readonly [number, number] = [-18, -12];
