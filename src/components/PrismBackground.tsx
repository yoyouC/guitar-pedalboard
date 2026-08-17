import { useEffect, useRef } from 'react';

interface PrismBackgroundProps {
  /** 输出侧 analyser;null 时以静默状态呼吸 */
  analyser: AnalyserNode | null;
}

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

/**
 * Pink Floyd《The Dark Side of the Moon》主题:
 * 黑底上一只缓转的三棱镜,白光自左侧射入,右侧色散成彩虹光谱扇出。
 * 光谱/光束的明暗跟随输出响度(u_amp);色散角与出射点随转动轻微呼吸,
 * 暗示色散与棱镜朝向的耦合(非物理精确,视觉上成立即可)。
 */
const FRAG = `
precision mediump float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_amp;   // 0..1 输出响度

const float SQRT3 = 1.7320508;

// 等边三角形 SDF(IQ)
float sdTriangle(vec2 p, float r) {
  p.x = abs(p.x) - r;
  p.y = p.y + r / SQRT3;
  if (p.x + SQRT3 * p.y > 0.0) p = vec2(p.x - SQRT3 * p.y, -SQRT3 * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}

mat2 rot2(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

// 红→紫六色光谱
vec3 spectrum(float t) {
  vec3 col = mix(vec3(0.90, 0.06, 0.10), vec3(0.95, 0.50, 0.05), smoothstep(0.00, 0.20, t));
  col = mix(col, vec3(0.95, 0.85, 0.15), smoothstep(0.20, 0.40, t));
  col = mix(col, vec3(0.15, 0.75, 0.25), smoothstep(0.40, 0.60, t));
  col = mix(col, vec3(0.10, 0.40, 0.90), smoothstep(0.60, 0.80, t));
  col = mix(col, vec3(0.55, 0.20, 0.80), smoothstep(0.80, 1.00, t));
  return col;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;

  // 棱镜:缓转等边三角形(约 42s 一圈);构图放大,让光束/光谱探出 UI 遮挡
  vec2 C = vec2(-0.18, -0.06);
  float R = 0.42;
  float ang = u_time * 0.15;
  float d = sdTriangle(rot2(ang) * (uv - C), R);

  // 能量:静默时保留暗呼吸,发声随响度提亮
  float energy = 0.50 + 0.55 * u_amp + 0.05 * sin(u_time * 0.8);

  // 棱镜外掩码(光束/光谱都不穿入镜面)
  float outside = smoothstep(0.004, 0.03, d);

  // --- 入射光束(左缘 → 棱镜,水平)---
  float beamY = C.y + 0.03;
  float beamDy = (uv.y - beamY) / 0.005;
  float beamCore = exp(-beamDy * beamDy);
  float glowDy = (uv.y - beamY) / 0.03;
  float beamGlow = 0.4 * exp(-glowDy * glowDy);
  float beam = (beamCore + beamGlow) * outside * step(uv.x, C.x);

  // --- 色散光谱(棱镜右侧 → 右缘,扇形展开,微上仰)---
  vec2 E = C + vec2(R * 0.6, 0.01);
  float sx = uv.x - E.x;
  float fanCenter = E.y + sx * 0.10 + 0.02 * sin(ang * 2.0);
  float spread = 0.20 * (1.0 + 0.12 * sin(ang));
  float t = sx > 0.0 ? (uv.y - fanCenter) / (sx * spread) * 0.5 + 0.5 : -1.0;
  float inFan = smoothstep(0.0, 0.06, t) * smoothstep(1.0, 0.94, t);
  float fanT = (t - 0.5) * 3.2;
  float fanGlow = 0.3 * exp(-fanT * fanT);
  float atten = 1.0 / (1.0 + sx * 0.4);
  float rightMask = smoothstep(0.0, 0.015, sx) * smoothstep(0.002, 0.02, d);
  vec3 specCol = spectrum(clamp(t, 0.0, 1.0));
  vec3 spec = specCol * (inFan + fanGlow) * atten * rightMask;

  // --- 棱镜本体:近黑玻璃 + 白色描边 + 内部微光 ---
  float inside = smoothstep(0.0, -0.03, d);
  float edge = smoothstep(0.010, 0.0, abs(d));
  float innerDy = (uv.y - beamY) / 0.015;
  vec3 prismCol = vec3(0.03, 0.033, 0.04) * inside;
  // 白光穿入的微弱延续
  prismCol += vec3(0.16) * inside * exp(-innerDy * innerDy) * step(uv.x, C.x);
  // 内部色散微光
  prismCol += spectrum(clamp((uv.y - C.y) / (R * 1.2) + 0.5, 0.0, 1.0)) * inside * 0.10 * step(C.x, uv.x);

  // 合成:镜体压掉背后的光,再叠加镜前光束/光谱
  vec3 col = vec3(0.0);
  col += vec3(1.0) * beam * energy;
  col += spec * energy;
  col = mix(col, prismCol * energy, inside);
  col += vec3(0.9, 0.95, 1.0) * edge * (0.7 + 0.3 * sin(u_time * 0.8)) * energy;
  // 棱镜周围的环境微光晕
  vec2 haloDv = uv - C;
  col += vec3(0.02, 0.023, 0.03) * exp(-dot(haloDv, haloDv) * 2.0);

  gl_FragColor = vec4(col, 1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('棱镜背景 shader 编译失败:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/** Pink Floyd 主题背景:旋转三棱镜 + 色散光谱,明暗跟随输出波形 */
export function PrismBackground({ analyser }: PrismBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
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
      console.warn('棱镜背景 program 链接失败:', gl.getProgramInfoLog(prog));
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
    const start = performance.now();
    let data: Float32Array<ArrayBuffer> | null = null;

    const frame = () => {
      const an = analyserRef.current;
      let targetAmp = 0;
      if (an) {
        if (!data || data.length !== an.fftSize) data = new Float32Array(an.fftSize);
        an.getFloatTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        targetAmp = Math.min(1, Math.sqrt(sum / data.length) * 3.0);
      }
      // 快攻慢释
      amp += (targetAmp - amp) * (targetAmp > amp ? 0.25 : 0.04);

      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, (performance.now() - start) / 1000);
      gl.uniform1f(uAmp, amp);
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

  return <canvas ref={canvasRef} className="fluid-bg" aria-hidden="true" />;
}
