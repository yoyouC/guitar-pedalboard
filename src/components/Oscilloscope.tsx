import { useEffect, useRef } from 'react';

interface OscilloscopeProps {
  inputAnalyser: AnalyserNode | null;
  outputAnalyser: AnalyserNode | null;
}

const IN_COLOR = '#4a90d9';
const OUT_COLOR = '#e07020';
const WIDTH = 960;
const HEIGHT = 140;

function drawTrace(
  g2d: CanvasRenderingContext2D,
  analyser: AnalyserNode,
  color: string,
) {
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  g2d.strokeStyle = color;
  g2d.lineWidth = 1.5;
  g2d.beginPath();
  const step = data.length / WIDTH;
  for (let x = 0; x < WIDTH; x++) {
    const v = data[Math.floor(x * step)];
    const y = HEIGHT / 2 - v * (HEIGHT / 2) * 0.9;
    if (x === 0) g2d.moveTo(x, y);
    else g2d.lineTo(x, y);
  }
  g2d.stroke();
}

/** 输入/输出双通道示波器(示意性质,非精确测量) */
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
      g2d.fillStyle = '#101215';
      g2d.fillRect(0, 0, WIDTH, HEIGHT);

      // 网格
      g2d.strokeStyle = 'rgba(255,255,255,0.07)';
      g2d.lineWidth = 1;
      g2d.beginPath();
      for (let x = 0; x <= WIDTH; x += WIDTH / 8) {
        g2d.moveTo(x, 0);
        g2d.lineTo(x, HEIGHT);
      }
      for (let y = 0; y <= HEIGHT; y += HEIGHT / 4) {
        g2d.moveTo(0, y);
        g2d.lineTo(WIDTH, y);
      }
      g2d.stroke();

      // 中心线
      g2d.strokeStyle = 'rgba(255,255,255,0.16)';
      g2d.beginPath();
      g2d.moveTo(0, HEIGHT / 2);
      g2d.lineTo(WIDTH, HEIGHT / 2);
      g2d.stroke();

      if (inputAnalyser) drawTrace(g2d, inputAnalyser, IN_COLOR);
      if (outputAnalyser) drawTrace(g2d, outputAnalyser, OUT_COLOR);

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
          输出
        </span>
      </div>
      <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} />
    </div>
  );
}
