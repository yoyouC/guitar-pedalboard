/**
 * 节拍器:lookahead 调度(Web Audio 标准做法),重拍强调。
 * 音频输出接 metronomeBus(引擎挂到主音量链上)。
 */
export type BeatCallback = (beat: number, when: number) => void;

export class Metronome {
  playing = false;
  bpm = 100;
  beatsPerBar = 4;

  private ctx: AudioContext;
  private bus: GainNode;
  private onBeat: BeatCallback;
  private timer: number | null = null;
  private nextBeatTime = 0;
  private beatIndex = 0;

  constructor(ctx: AudioContext, bus: GainNode, onBeat: BeatCallback) {
    this.ctx = ctx;
    this.bus = bus;
    this.onBeat = onBeat;
  }

  start(): void {
    if (this.playing) return;
    this.playing = true;
    this.beatIndex = 0;
    this.nextBeatTime = this.ctx.currentTime + 0.06;
    this.timer = window.setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  stop(): void {
    this.playing = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** lookahead 调度:每 25ms 把未来 120ms 内的拍点排进去 */
  private schedule(): void {
    const spb = 60 / this.bpm;
    while (this.nextBeatTime < this.ctx.currentTime + 0.12) {
      this.click(this.nextBeatTime, this.beatIndex === 0);
      const idx = this.beatIndex;
      const t = this.nextBeatTime;
      // 视觉闪灯与实际发声对齐
      const delay = Math.max(0, (t - this.ctx.currentTime) * 1000);
      window.setTimeout(() => this.onBeat(idx, t), delay);
      this.beatIndex = (this.beatIndex + 1) % this.beatsPerBar;
      this.nextBeatTime += spb;
    }
  }

  /** 单拍:重拍 2kHz,普通拍 1.4kHz,30ms 指数衰减 */
  private click(when: number, accent: boolean): void {
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = accent ? 2000 : 1400;
    const g = this.ctx.createGain();
    const peak = accent ? 0.5 : 0.3;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(peak, when + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.03);
    osc.connect(g);
    g.connect(this.bus);
    osc.start(when);
    osc.stop(when + 0.035);
  }
}
