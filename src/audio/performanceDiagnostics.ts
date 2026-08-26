export interface MainThreadSnapshot {
  supported: boolean;
  longTaskCount: number;
  longTaskDurationMs: number;
}

/** Long Tasks 只是主线程代理指标，绝不推算为音频 underrun。 */
export class LongTaskTracker {
  private observer: PerformanceObserver | null = null;
  private count = 0;
  private durationMs = 0;

  start(): void {
    if (this.observer || typeof PerformanceObserver === 'undefined') return;
    if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;
    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        this.count++;
        this.durationMs += entry.duration;
      }
    });
    this.observer.observe({ entryTypes: ['longtask'] });
  }

  snapshot(): MainThreadSnapshot {
    return {
      supported: this.observer !== null,
      longTaskCount: this.count,
      longTaskDurationMs: this.durationMs,
    };
  }

  disconnect(): void {
    this.observer?.disconnect();
    this.observer = null;
  }
}

export interface StabilityObservation {
  measuredAt: string;
  durationMs: number;
  longTaskCount: number | null;
  longTaskDurationMs: number | null;
  underrunEvents: number | null;
  underrunDurationMs: number | null;
}
