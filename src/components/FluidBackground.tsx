import { useEffect, useRef } from 'react';

interface FluidBackgroundProps {
  /** 输出侧 analyser;null 时以静默状态呼吸 */
  analyser: AnalyserNode | null;
  /** 显示实时检测数值的调试浮层 */
  debug?: boolean;
}

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG = `
precision mediump float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_amp;   // 0..1 输出响度
uniform float u_clip;  // 0..1 削波程度

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(11.3, -7.9);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float t = u_time * 0.08; // 恒定流速,与响度无关

  // 双重 domain warp,模拟流体
  vec2 q = vec2(fbm(uv * 1.4 + t), fbm(uv * 1.4 + vec2(5.2, 1.3) - t));
  vec2 r = vec2(
    fbm(uv * 1.4 + 2.2 * q + vec2(1.7, 9.2) + 0.35 * t),
    fbm(uv * 1.4 + 2.2 * q + vec2(8.3, 2.8) - 0.28 * t)
  );
  float f = fbm(uv * 1.4 + 2.6 * r);
  // 提升对比 + 条带化,让纹理有清晰脊线而非雾气
  f = pow(f, 1.6) * 1.9;
  float bands = 0.5 + 0.5 * sin(f * 9.0 + r.x * 6.0);
  f = mix(f, bands * f, 0.45);

  // 暗绿 ↔ 黑(干净信号);图案不随响度变化
  vec3 green = mix(vec3(0.0), vec3(0.06, 0.40, 0.17), f);
  green += vec3(0.06, 0.32, 0.13) * f;

  // 橙~红 ↔ 黑(削波)
  vec3 fire = mix(vec3(0.0), vec3(0.48, 0.12, 0.01), f);
  fire += vec3(0.62, 0.22, 0.03) * f;

  vec3 col = mix(green, fire, clamp(u_clip, 0.0, 1.0));

  // 响度只影响整体明暗;静音时也保留清晰可见的暗绿底色
  col *= 0.75 + 0.55 * u_amp;
  col += vec3(0.05, 0.14, 0.06) * (0.35 + 0.65 * f) * (1.0 - 0.7 * clamp(u_clip, 0.0, 1.0));

  // 暗角
  col *= 1.0 - 0.55 * dot(uv * 0.85, uv * 0.85);

  gl_FragColor = vec4(col, 1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('流体背景 shader 编译失败:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/** 沉浸式流体背景:颜色/明暗跟随输出波形(暗绿=干净,橙红=削波) */
export function FluidBackground({ analyser, debug }: FluidBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const debugRef = useRef<HTMLDivElement>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  analyserRef.current = analyser;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false });
    if (!gl) return; // 不支持 WebGL 时保持 body 底色

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;
    const prog = gl.createProgram();
    if (!prog) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('流体背景 program 链接失败:', gl.getProgramInfoLog(prog));
      return;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(prog, 'u_res');
    const uTime = gl.getUniformLocation(prog, 'u_time');
    const uAmp = gl.getUniformLocation(prog, 'u_amp');
    const uClip = gl.getUniformLocation(prog, 'u_clip');

    const resize = () => {
      // 半分辨率渲染,背景无需精细,省性能
      canvas.width = Math.floor(window.innerWidth * 0.5);
      canvas.height = Math.floor(window.innerHeight * 0.5);
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    resize();
    window.addEventListener('resize', resize);

    let raf = 0;
    let amp = 0;
    let clip = 0;
    const start = performance.now();
    let data: Float32Array<ArrayBuffer> | null = null;
    let scratch: number[] = [];
    let lastDebugUpdate = 0;
    const debugEl = debugRef.current;

    const frame = () => {
      const an = analyserRef.current;
      if (an) {
        if (!data || data.length !== an.fftSize) data = new Float32Array(an.fftSize);
        an.getFloatTimeDomainData(data);
        let sum = 0;
        let peak = 0;
        let m4 = 0;
        if (scratch.length !== data.length) scratch = new Array(data.length);
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i]);
          sum += v * v;
          m4 += v * v * v * v;
          if (v > peak) peak = v;
          scratch[i] = v;
        }
        const rms = Math.sqrt(sum / data.length);
        const targetAmp = Math.min(1, rms * 3.0);

        // 削波检测:rms / p99 峰值比(阈值按实测标定:
        // 清音吉他 ≈ 0.4,失真/Fuzz ≈ 0.65~0.75,方波极限 1)
        let targetClip = 0;
        let ratio = 0;
        let frac = 0;
        let kurt = 0;
        if (rms > 0.01 && peak > 0.02) {
          scratch.sort((a, b) => b - a);
          const p99 = scratch[Math.floor(data.length * 0.01)] || peak;
          ratio = rms / p99;
          targetClip = Math.min(1, Math.max(0, (ratio - 0.55) / 0.15));

          // 调试用辅助指标
          const thresh = peak * 0.85;
          let flat = 0;
          for (let i = 0; i < data.length; i++) if (scratch[i] >= thresh) flat++;
          frac = flat / data.length;
          const m2 = sum / data.length;
          kurt = m4 / data.length / (m2 * m2);
        }

        // 调试浮层(约 4Hz 刷新)
        if (debugEl) {
          const now = performance.now();
          if (now - lastDebugUpdate > 250) {
            lastDebugUpdate = now;
            debugEl.textContent =
              `rms=${rms.toFixed(3)} peak=${peak.toFixed(3)} | ` +
              `ratio=${ratio.toFixed(3)} frac=${frac.toFixed(3)} kurt=${kurt.toFixed(2)} | ` +
              `amp=${amp.toFixed(2)} clip=${clip.toFixed(2)}`;
          }
        }

        // 快攻慢释
        amp += (targetAmp - amp) * (targetAmp > amp ? 0.25 : 0.04);
        clip += (targetClip - clip) * 0.12;
      } else {
        amp += (0 - amp) * 0.04;
        clip += (0 - clip) * 0.12;
      }

      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, (performance.now() - start) / 1000);
      gl.uniform1f(uAmp, amp);
      gl.uniform1f(uClip, clip);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      raf = requestAnimationFrame(frame);
    };
    frame();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
    };
  }, []);

  return (
    <>
      <canvas ref={canvasRef} className="fluid-bg" aria-hidden="true" />
      {debug && <div ref={debugRef} className="fluid-debug" />}
    </>
  );
}
