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
 * 黑底上一只 3D 三棱镜(raymarch 三棱柱 SDF,绕竖直轴缓转 + 前倾),
 * 白光自左侧射入玻璃,右侧色散成彩虹光谱扇出。
 * 玻璃 = fresnel 棱线 + 关键光高光 + 微弱透光;色散强度与长面朝向耦合
 * (三长面,周期 2π/3)。光谱/光束的明暗跟随输出响度(u_amp)。
 * 屏幕空间的光束/光谱用 raymarch 命中掩码遮挡,看起来像被镜体截断/射出。
 */
const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_res;
uniform float u_time;
uniform float u_amp;   // 0..1 输出响度

// 三棱柱 SDF(IQ):xy 等边三角截面(顶点朝上),z 轴柱身
float sdTriPrism(vec3 p, vec2 h) {
  vec3 q = abs(p);
  return max(q.z - h.y, max(q.x * 0.866025 + p.y * 0.5, -p.y) - h.x * 0.5);
}

mat2 rot2(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

// 场景:前倾露出端面与长面,绕竖直轴缓转(约 25s 一圈);短身三棱体(非长柱),
// 整体靠左下(x 负向),给右侧光谱留出扇出空间
float map(vec3 p) {
  p += vec3(0.62, 0.18, 0.0);
  p.yz = rot2(-0.42) * p.yz;
  p.xz = rot2(u_time * 0.25) * p.xz;
  return sdTriPrism(p, vec2(0.42, 0.28));
}

vec3 calcNormal(vec3 p, float eps) {
  vec2 e = vec2(eps, -eps);
  return normalize(
    e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx) +
    e.yxy * map(p + e.yxy) + e.xxx * map(p + e.xxx));
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

  // 能量:静默时保留暗呼吸,发声随响度提亮
  float energy = 0.50 + 0.55 * u_amp + 0.05 * sin(u_time * 0.8);

  // 相机:固定于原点前方,看向棱镜
  vec3 ro = vec3(0.0, 0.0, 2.6);
  vec3 rd = normalize(vec3(uv, -1.9));

  // raymarch 棱镜(软命中:记录最终距离,近失像素给部分覆盖,压轮廓锯齿)
  float dist = 0.0;
  float lastD = 10.0;
  vec3 pos = ro;
  for (int i = 0; i < 80; i++) {
    pos = ro + rd * dist;
    lastD = map(pos);
    if (lastD < 0.001) break;
    dist += lastD;
    if (dist > 6.0) break;
  }
  float cover = smoothstep(0.006, 0.0005, lastD);

  // --- 光束锚定:沿光束轴线(y=beamW, z=0)求入射/出射棱镜的世界 x ---
  float beamW = -0.18;
  float xEnter = -0.15; // 未命中兜底:截在棱镜附近
  float xExit = 0.15;
  {
    float bx = -2.5;
    for (int i = 0; i < 32; i++) {
      float dd = map(vec3(bx, beamW, 0.0));
      if (dd < 0.001) { xEnter = bx; break; }
      bx += max(dd, 0.02);
      if (bx > 1.5) break;
    }
    bx = 1.5;
    for (int i = 0; i < 32; i++) {
      float dd = map(vec3(bx, beamW, 0.0));
      if (dd < 0.001) { xExit = bx; break; }
      bx -= max(dd, 0.02);
      if (bx < -2.5) break;
    }
  }

  // --- 入射光束:视线与光束线段(x ≤ xEnter)的最近距离;双向遮挡正确 ---
  vec3 w0 = vec3(0.0, beamW, 0.0) - ro;
  float bb = rd.x;
  float ee = -dot(rd, ro) + rd.y * beamW;
  float denom = 1.0 - bb * bb;
  float sLine = (bb * ee + ro.x) / denom;  // 光束轴上最近点的 x
  float tRay = (ee + bb * ro.x) / denom;   // 视线上最近点参数
  vec3 closest = w0 + vec3(sLine, 0.0, 0.0) - tRay * rd;
  float beamD2 = dot(closest, closest);
  float beamVis = (tRay > 0.0 && sLine < xEnter && tRay < dist) ? 1.0 : 0.0;
  float beam = (exp(-beamD2 / 0.00003) + 0.4 * exp(-beamD2 / 0.0009)) * beamVis;

  // --- 色散光谱(出射面 → 右缘扇出;被镜体遮挡处截断)---
  // 色散强度与长面朝向耦合:三条长面轮流正对光束,周期 2π/3
  float ang = u_time * 0.25;
  float dispers = 0.45 + 0.55 * (0.5 + 0.5 * cos(ang * 3.0));
  vec2 E = vec2(xExit, beamW) * (1.9 / 2.6); // 世界(z=0)→ 屏幕投影
  float sx = uv.x - E.x;
  float fanCenter = E.y + sx * 0.10;
  float spread = 0.20 * (0.6 + 0.4 * dispers);
  float ft = sx > 0.0 ? (uv.y - fanCenter) / (sx * spread) * 0.5 + 0.5 : -1.0;
  float inFan = smoothstep(0.0, 0.06, ft) * smoothstep(1.0, 0.94, ft);
  float fanT = (ft - 0.5) * 3.2;
  float fanGlow = 0.3 * exp(-fanT * fanT);
  float atten = 1.0 / (1.0 + sx * 0.4);
  float rightMask = smoothstep(0.0, 0.015, sx) * (1.0 - cover);
  vec3 spec = spectrum(clamp(ft, 0.0, 1.0)) * (inFan + fanGlow) * atten * rightMask * dispers;

  vec3 col = vec3(0.0);
  col += vec3(1.0) * beam * energy;
  col += spec * energy;

  // --- 棱镜本体:深色玻璃(棱线反光 + fresnel 轮廓光 + 透光)---
  if (cover > 0.0) {
    vec3 n = calcNormal(pos, 0.0015);
    vec3 L = normalize(vec3(-0.6, 0.7, 0.5));
    float fres = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 5.0);
    float dif = max(0.0, dot(n, L));
    float specHi = pow(max(0.0, dot(reflect(rd, n), L)), 48.0);
    // 几何棱检测:大 epsilon 的法线在棱附近被"磨圆",与小 epsilon 法线分离;
    // 面上两法线一致(连续信号,不会产生虚线 artifact)
    vec3 nSoft = calcNormal(pos, 0.035);
    float edge = smoothstep(0.03, 0.25, 1.0 - dot(n, nSoft));
    vec3 glass = vec3(0.008, 0.009, 0.012);
    glass += vec3(0.05, 0.055, 0.07) * dif * 0.12;
    glass += vec3(0.9, 0.95, 1.0) * specHi * 0.25;
    glass += vec3(0.55, 0.65, 0.85) * fres * 0.30;
    // 棱线反光:受光侧更亮
    glass += vec3(0.85, 0.92, 1.0) * edge * (0.25 + 0.75 * dif);
    // 白光穿入的微弱延续(入射侧,世界空间到光束轴的距离)
    float inD2 = (pos.y - beamW) * (pos.y - beamW) + pos.z * pos.z;
    glass += vec3(0.18) * exp(-inD2 / 0.0004) * step(pos.x, xEnter + 0.05);
    // 内部色散微光(出射侧)
    glass += spectrum(clamp((uv.y - beamW * (1.9 / 2.6)) / 0.35 + 0.5, 0.0, 1.0)) * 0.12 * smoothstep(E.x - 0.35, E.x, uv.x) * dispers;
    col += glass * cover * energy;
  }

  // 棱镜周围的环境微光晕
  col += vec3(0.02, 0.023, 0.03) * exp(-dot(uv, uv) * 2.0);

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
      // 0.75 分辨率渲染:raymarch 轮廓比噪声纹理更吃像素,略提清晰度
      canvas.width = Math.floor(window.innerWidth * 0.75);
      canvas.height = Math.floor(window.innerHeight * 0.75);
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
