import { useEffect, useRef } from 'react';

interface MeddleBackgroundProps {
  /** 输出侧 analyser;null 时以静默状态呼吸 */
  analyser: AnalyserNode | null;
  /** 显示实时检测数值的调试浮层 */
  debug?: boolean;
}

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

// 灵感:Pink Floyd《Meddle》(1971)封面 —— Hipgnosis 的"水下的耳朵"。
// 深青水体与灰粉紫(耳廓肉色)交织,同心涟漪扩散呼应 "Echoes" 开头的声呐 ping。
// 配色取自封面实拍取样:teal #169fb1 / cyan 高光 / mauve #76504f / 深青黑。
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

// 单个涟漪源:波前周围的多圈同心环,随相位 ph(0..1)扩散并衰减
float ripple(vec2 w, vec2 c, float ph, float speed) {
  float d = length(w - c);
  float r = ph * speed;
  float train = 0.5 + 0.5 * sin((d - r) * 70.0);
  float env = exp(-abs(d - r) * 9.0);
  return train * env * (1.0 - ph) * smoothstep(0.0, 0.06, ph);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float t = u_time;

  // 缓慢的水面扰动(封面上被水面折射扭曲的质感)
  vec2 q = vec2(fbm(uv * 3.2 + t * 0.05), fbm(uv * 3.2 + vec2(5.2, 1.3) - t * 0.04));
  vec2 w = uv + 0.18 * q;

  // 同心涟漪:三个声源不同周期错相扩散,响度推高潮幅
  float rip = 0.0;
  rip += ripple(w, vec2(-0.55, -0.30), fract(t * 0.140 + 0.13), 1.6);
  rip += ripple(w, vec2( 0.55,  0.25), fract(t * 0.110 + 0.55), 1.7);
  rip += ripple(w, vec2( 0.05, -0.05), fract(t * 0.080 + 0.82), 1.9);
  rip *= 0.55 + 0.90 * u_amp;

  // Meddle 配色
  vec3 deep  = vec3(0.016, 0.133, 0.169); // 深青黑水体
  vec3 teal  = vec3(0.086, 0.520, 0.580); // 绿松石水域(#169fb1 压暗)
  vec3 cyan  = vec3(0.310, 0.860, 0.895); // 涟漪脊线高光
  vec3 mauveD = vec3(0.290, 0.170, 0.195); // 暗紫灰(肉色阴影)
  vec3 mauve = vec3(0.510, 0.300, 0.310);  // 灰粉紫(#76504f 耳廓,提饱和)
  vec3 rose  = vec3(0.710, 0.470, 0.440);  // 肉色亮部

  // 水域:深青 ↔ 绿松石,高频纹理 + 条带化脊线(提对比,让亮青水域成块出现)
  float wt = fbm(w * 3.2 + vec2(0.0, t * 0.03));
  float wtex = smoothstep(0.25, 0.85, wt);
  float bands = 0.5 + 0.5 * sin(wt * 28.0 + q.x * 10.0);
  wtex = mix(wtex, bands * wtex, 0.4);
  vec3 waterCol = mix(deep, teal, wtex);
  waterCol += cyan * rip * 0.55;

  // 肉色雾团:大尺度漂移,模拟封面中央被水浸没的耳廓
  vec2 m = uv + vec2(0.08 * sin(t * 0.05), 0.05 * cos(t * 0.04));
  float ftex = fbm(m * 4.2 - vec2(t * 0.02, 0.0) + q * 0.8);
  ftex = smoothstep(0.2, 0.8, ftex); // 提对比,肉色雾内部也有清晰纹路
  vec3 fleshCol = mix(mauveD, mix(mauve, rose, ftex), ftex);

  // 水域 ↔ 肉色雾 的大尺度交织(肉色区占大头,贴近封面的红紫主体)
  float zone = fbm(uv * 1.4 + 0.6 * q + vec2(0.0, t * 0.018) + vec2(3.1, 7.7));
  zone = smoothstep(0.36, 0.50, zone);
  vec3 col = mix(waterCol, fleshCol * 0.95, zone * 0.9);

  // 响度只影响整体明暗;静音时保留深青底色
  col *= 0.85 + 0.50 * u_amp;
  col += deep * 0.35 * (1.0 - 0.5 * clamp(u_clip, 0.0, 1.0));

  // 削波:整体推向封面的暗红褐阴影侧
  col = mix(col, col * vec3(1.45, 0.55, 0.50) + vec3(0.10, 0.005, 0.0), clamp(u_clip, 0.0, 1.0));

  // 胶片颗粒(封面照片的粗颗粒质感)
  col += (hash(gl_FragCoord.xy + fract(t) * 100.0) - 0.5) * 0.028;

  // 暗角
  col *= 1.0 - 0.45 * dot(uv * 0.85, uv * 0.85);

  gl_FragColor = vec4(col, 1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('Meddle 背景 shader 编译失败:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/** Meddle 背景:水下之耳。深青水体 + 灰粉紫肉色雾 + 声呐涟漪,削波时转暗红 */
export function MeddleBackground({ analyser, debug }: MeddleBackgroundProps) {
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
      console.warn('Meddle 背景 program 链接失败:', gl.getProgramInfoLog(prog));
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
      // 降分辨率渲染省性能(0.6×:涟漪环频率高,再低会糊)
      canvas.width = Math.floor(window.innerWidth * 0.6);
      canvas.height = Math.floor(window.innerHeight * 0.6);
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

        // 削波检测:rms / p99 峰值比(与流体背景同一套标定)
        let targetClip = 0;
        let ratio = 0;
        let frac = 0;
        let kurt = 0;
        if (rms > 0.01 && peak > 0.02) {
          scratch.sort((a, b) => b - a);
          const p99 = scratch[Math.floor(data.length * 0.01)] || peak;
          ratio = rms / p99;
          targetClip = Math.min(1, Math.max(0, (ratio - 0.47) / 0.21));

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
        clip += (targetClip - clip) * (targetClip > clip ? 0.25 : 0.06);
      } else {
        amp += (0 - amp) * 0.04;
        clip += (0 - clip) * 0.06;
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
