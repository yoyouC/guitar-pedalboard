import { useEffect, useRef } from 'react';

interface OscilloscopeProps {
  inputAnalyser: AnalyserNode | null;
  outputAnalyser: AnalyserNode | null;
}

const IN_COLOR = '#4a90d9';
const OUT_COLOR = '#e07020';
const WIDTH = 960;
const HEIGHT = 150;
const HALF = WIDTH / 2;

function drawTrace(
  g2d: CanvasRenderingContext2D,
  analyser: AnalyserNode,
  color: string,
  x0: number,
  w: number,
) {
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  g2d.strokeStyle = color;
  g2d.lineWidth = 1.5;
  g2d.beginPath();
  const step = data.length / w;
  for (let x = 0; x < w; x++) {
    const v = data[Math.floor(x * step)];
    const y = HEIGHT / 2 - v * (HEIGHT / 2) * 0.85;
    if (x === 0) g2d.moveTo(x0 + x, y);
    else g2d.lineTo(x0 + x, y);
  }
  g2d.stroke();
}

function drawGrid(g2d: CanvasRenderingContext2D, x0: number, w: number) {
  g2d.strokeStyle = 'rgba(255,255,255,0.06)';
  g2d.lineWidth = 1;
  g2d.beginPath();
  for (let x = 0; x <= w; x += w / 4) {
    g2d.moveTo(x0 + x, 0);
    g2d.lineTo(x0 + x, HEIGHT);
  }
  for (let y = 0; y <= HEIGHT; y += HEIGHT / 4) {
    g2d.moveTo(x0, y);
    g2d.lineTo(x0 + w, y);
  }
  g2d.stroke();

  g2d.strokeStyle = 'rgba(255,255,255,0.14)';
  g2d.beginPath();
  g2d.moveTo(x0, HEIGHT / 2);
  g2d.lineTo(x0 + w, HEIGHT / 2);
  g2d.stroke();
}

/** 输入/输出对半分区的双踪示波器(示意性质,非精确测量) */
export function Oscilloscope({ inputAnalyser, outputAnalyser }: OscilloscopeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!inputAnalyser && !outputAnalyser) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g2d = canvas.getContext('2d');
    if (!g2d) return;

    let raf = 0;
    const draw = () => {
      g2d.fillStyle = '#0d0f12';
      g2d.fillRect(0, 0, WIDTH, HEIGHT);

      drawGrid(g2d, 0, HALF);
      drawGrid(g2d, HALF, HALF);

      // 中缝分割线
      g2d.strokeStyle = 'rgba(255,255,255,0.2)';
      g2d.lineWidth = 1;
      g2d.beginPath();
      g2d.moveTo(HALF, 0);
      g2d.lineTo(HALF, HEIGHT);
      g2d.stroke();

      // 区域标签
      g2d.font = 'bold 11px monospace';
      g2d.fillStyle = IN_COLOR;
      g2d.fillText('IN', 10, 16);
      g2d.fillStyle = OUT_COLOR;
      g2d.fillText('OUT', HALF + 10, 16);

      if (inputAnalyser) drawTrace(g2d, inputAnalyser, IN_COLOR, 0, HALF);
      if (outputAnalyser) drawTrace(g2d, outputAnalyser, OUT_COLOR, HALF, HALF);

      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [inputAnalyser, outputAnalyser]);

  return (
    <div className="oscilloscope">
      <div className="scope-legend">
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: IN_COLOR }} />
          输入
        </span>
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: OUT_COLOR }} />
          输出(箱头后)
        </span>
      </div>
      <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} />
    </div>
  );
}
