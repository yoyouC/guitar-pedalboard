import { useEffect, useRef } from 'react';

interface SpectrumViewProps {
  inputAnalyser: AnalyserNode | null;
  outputAnalyser: AnalyserNode | null;
}

const IN_COLOR = '#4a90d9';
const OUT_COLOR = '#e07020';
const WIDTH = 960;
const HEIGHT = 150;
const MIN_DB = -90;
const MAX_DB = 0;
const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const LOG_RANGE = Math.log(MAX_FREQ / MIN_FREQ);

/** 带文字标签的主频率刻度(对数轴) */
const FREQ_TICKS: { freq: number; label: string }[] = [
  { freq: 100, label: '100' },
  { freq: 1000, label: '1k' },
  { freq: 10000, label: '10k' },
];
/** 次频率刻度(仅刻度线) */
const FREQ_MINOR = [50, 200, 500, 2000, 5000];
/** dB 刻度间隔(-90~0dB) */
const DB_STEP = 15;

/** 频率(Hz)→ 画布 x(对数轴) */
function freqToX(freq: number): number {
  return (Math.log(freq / MIN_FREQ) / LOG_RANGE) * WIDTH;
}

/** dB → 画布 y(MIN_DB 在底部,0dB 在顶部) */
function dbToY(db: number): number {
  const clamped = Math.max(MIN_DB, Math.min(MAX_DB, db));
  return HEIGHT - ((clamped - MIN_DB) / (MAX_DB - MIN_DB)) * HEIGHT;
}

function drawGrid(g2d: CanvasRenderingContext2D) {
  // 竖线:对数频率刻度
  g2d.lineWidth = 1;
  g2d.strokeStyle = 'rgba(255,255,255,0.06)';
  g2d.beginPath();
  for (const f of FREQ_MINOR) {
    const x = freqToX(f);
    g2d.moveTo(x, 0);
    g2d.lineTo(x, HEIGHT);
  }
  g2d.stroke();
  g2d.strokeStyle = 'rgba(255,255,255,0.14)';
  g2d.beginPath();
  for (const t of FREQ_TICKS) {
    const x = freqToX(t.freq);
    g2d.moveTo(x, 0);
    g2d.lineTo(x, HEIGHT);
  }
  g2d.stroke();

  // 横线:dB 刻度
  g2d.strokeStyle = 'rgba(255,255,255,0.06)';
  g2d.beginPath();
  for (let db = MIN_DB; db <= MAX_DB; db += DB_STEP) {
    const y = dbToY(db);
    g2d.moveTo(0, y);
    g2d.lineTo(WIDTH, y);
  }
  g2d.stroke();

  // 刻度文字
  g2d.font = '10px monospace';
  g2d.fillStyle = 'rgba(255,255,255,0.35)';
  for (let db = MIN_DB + DB_STEP; db <= MAX_DB; db += DB_STEP) {
    g2d.fillText(String(db), 4, dbToY(db) - 2);
  }
  for (const t of FREQ_TICKS) {
    g2d.fillText(t.label, freqToX(t.freq) + 3, HEIGHT - 5);
  }
}

function drawSpectrum(
  g2d: CanvasRenderingContext2D,
  analyser: AnalyserNode,
  color: string,
) {
  const bins = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(bins);
  const binHz = analyser.context.sampleRate / analyser.fftSize;

  // 每个 x 像素取对应对数频率的 FFT bin(-Infinity 经 dbToY 自然截到底部)
  g2d.beginPath();
  g2d.moveTo(0, HEIGHT);
  for (let x = 0; x <= WIDTH; x++) {
    const freq = MIN_FREQ * Math.exp((x / WIDTH) * LOG_RANGE);
    const bin = Math.min(bins.length - 1, Math.round(freq / binHz));
    g2d.lineTo(x, dbToY(bins[bin]));
  }
  g2d.lineTo(WIDTH, HEIGHT);
  g2d.closePath();
  g2d.fillStyle = `${color}2e`;
  g2d.fill();
  g2d.strokeStyle = color;
  g2d.lineWidth = 1.5;
  g2d.stroke();
}

/** 输入/输出叠加的对数频谱(示意性质,非精确测量) */
export function SpectrumView({ inputAnalyser, outputAnalyser }: SpectrumViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!inputAnalyser && !outputAnalyser) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g2d = canvas.getContext('2d');
    if (!g2d) return;

    // 频谱需要 -90~0dB 满量程,覆盖 analyser 默认 dB 范围(仅影响频域读数)
    for (const a of [inputAnalyser, outputAnalyser]) {
      if (a) {
        a.minDecibels = MIN_DB;
        a.maxDecibels = MAX_DB;
      }
    }

    let raf = 0;
    const draw = () => {
      g2d.fillStyle = '#0d0f12';
      g2d.fillRect(0, 0, WIDTH, HEIGHT);

      drawGrid(g2d);

      if (inputAnalyser) drawSpectrum(g2d, inputAnalyser, IN_COLOR);
      if (outputAnalyser) drawSpectrum(g2d, outputAnalyser, OUT_COLOR);

      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [inputAnalyser, outputAnalyser]);

  return (
    <div className="spectrum-view">
      <div className="scope-legend">
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: IN_COLOR }} />
          输入
        </span>
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: OUT_COLOR }} />
          输出(箱头后)
        </span>
        <span className="legend-item spectrum-range">20Hz – 20kHz · -90~0dB</span>
      </div>
      <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} />
    </div>
  );
}
