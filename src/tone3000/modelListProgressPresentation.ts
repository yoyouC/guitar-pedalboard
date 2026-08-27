import type { Tone3000ModelListProgress } from './client';

export function tone3000ModelListProgressText(
  progress: Tone3000ModelListProgress,
): string {
  if (progress.completedPages === 0) return '正在准备采样列表…';
  return progress.totalPages === undefined
    ? `正在组装采样列表：已加载 ${progress.completedPages} 页…`
    : `正在组装采样列表：${progress.completedPages} / ${progress.totalPages} 页`;
}
