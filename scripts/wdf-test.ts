/**
 * WDF 数值验证(Node 直接运行:npm run wdf:test)
 * 1) 单级:无 NaN、输出有界、大信号不对称削波
 * 2) 全链(级1→级2→6V6→输出变压器):与 worklet 同构,链稳定、有界
 */
import { TriodeStage, KOREN_6V6_APPROX, KOREN_EL34_APPROX } from '../src/audio/wdf/triode.ts';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from '../src/audio/wdf/resample.ts';

const FS = 48000 * 4; // 4x 过采样等效速率
const T = 1 / FS;

/** 单极点 HP(与 worklet 一致) */
function makeHp(fc: number) {
  let x1 = 0, y1 = 0;
  const rc = 1 / (2 * Math.PI * fc);
  const a = rc / (rc + T);
  return (x: number) => {
    const y = a * (y1 + x - x1);
    x1 = x;
    y1 = y;
    return y;
  };
}

/** 单极点滤波器(与 worklet 输出变压器一致) */
function makeXformer(hpFc = 80, lpFc = 6500) {
  let hpX1 = 0, hpY1 = 0, lpY1 = 0;
  const rcHp = 1 / (2 * Math.PI * hpFc);
  const aHp = rcHp / (rcHp + T);
  const rcLp = 1 / (2 * Math.PI * lpFc);
  const aLp = T / (rcLp + T);
  return (x: number) => {
    const yHp = aHp * (hpY1 + x - hpX1);
    hpX1 = x;
    hpY1 = yHp;
    lpY1 = lpY1 + aLp * (yHp - lpY1);
    return lpY1;
  };
}

interface Stats { nan: number; min: number; max: number; mean: number; rms: number }

function stats(label: string, gen: (n: number) => number, total: number): Stats {
  let nan = 0, max = -Infinity, min = Infinity, sum = 0, sumSq = 0, count = 0;
  for (let n = 0; n < total; n++) {
    const out = gen(n);
    if (!Number.isFinite(out)) nan++;
    if (n > total * 0.8) {
      max = Math.max(max, out);
      min = Math.min(min, out);
      sum += out;
      sumSq += out * out;
      count++;
    }
  }
  const mean = sum / count;
  const rms = Math.sqrt(sumSq / count);
  console.log(
    `${label}: NaN=${nan} min=${min.toFixed(2)} max=${max.toFixed(2)} ` +
      `mean=${mean.toFixed(3)} rms=${rms.toFixed(2)} 不对称度=${((max + min) / (max - min)).toFixed(3)}`,
  );
  if (nan > 0) throw new Error(`${label}: 出现 NaN!`);
  return { nan, min, max, mean, rms };
}

console.log('== 1) 单级(12AX7, B+=300V, Rp=100k, Rk=1.5k, Ck=22uF)==');
for (const [amp, label] of [[0.05, '0.05V'], [0.5, '0.5V'], [2.0, '2.0V']] as const) {
  const st = new TriodeStage({ fs: FS });
  const s = stats(
    `vg=${label}`,
    (n) => st.process(amp * Math.sin((2 * Math.PI * 1000 * n) / FS)),
    FS / 10,
  );
  if (Math.abs(s.max) > 300 || Math.abs(s.min) > 300) throw new Error('单级输出越界');
}

console.log('== 2) 全链(级1 → 级2 → 6V6 → 变压器),与 worklet 同参数 ==');
for (const [gain, label] of [[1, 'GAIN=1(最低)'], [15, 'GAIN=15(中)'], [30, 'GAIN=30(满)']] as const) {
  const st1 = new TriodeStage({ fs: FS, Rk: 820, Ck: 0, Rs: 68e3 });
  const st2 = new TriodeStage({ fs: FS, Rs: 100e3 });
  const pw = new TriodeStage({
    fs: FS, koren: KOREN_6V6_APPROX, Bplus: 285, Rp: 5e3, Rk: 250, Ck: 0,
    Co: 1e-3, Rload: 1e6, Rs: 220e3,
  });
  const xf = makeXformer();
  const s = stats(
    `drive=${label}`,
    (n) => {
      const x = 0.3 * Math.sin((2 * Math.PI * 1000 * n) / FS);
      return xf(pw.process(st2.process(st1.process(x * gain) * 0.08) * 0.25)) / 250;
    },
    FS / 10,
  );
  if (Math.abs(s.max) > 1.5 || Math.abs(s.min) > 1.5) {
    throw new Error(`全链输出越界(±1.5): ${label}`);
  }
}

console.log('== 3) Bogner 链(级1 部分旁路 → 级2 冷偏置 → 级3 全旁路 → EL34 → 变压器)==');
for (const [gain, label] of [[1, 'GAIN=1'], [20, 'GAIN=20(中)'], [40, 'GAIN=40(满)']] as const) {
  const st1 = new TriodeStage({ fs: FS, Rk: 2.7e3, Ck: 0.68e-6, Rs: 34e3 });
  const st2 = new TriodeStage({ fs: FS, Rk: 10e3, Ck: 0, Rs: 100e3 });
  const st3 = new TriodeStage({ fs: FS, Rk: 820, Ck: 22e-6, Rs: 100e3 });
  const pw = new TriodeStage({
    fs: FS, koren: KOREN_EL34_APPROX, Bplus: 350, Rp: 4e3, Rk: 250, Ck: 0,
    Co: 1e-3, Rload: 1e6, Rs: 220e3,
  });
  const hpIn = makeHp(130);
  const xf = makeXformer(90, 6000);
  const s = stats(
    `drive=${label}`,
    (n) => {
      const x = hpIn(0.3 * Math.sin((2 * Math.PI * 1000 * n) / FS));
      const s1 = st1.process(x * gain);
      const s2 = st2.process(s1 * 0.06);
      const s3 = st3.process(s2 * 0.1);
      return xf(pw.process(s3 * 0.22)) / 250;
    },
    FS / 10,
  );
  if (Math.abs(s.max) > 1.5 || Math.abs(s.min) > 1.5) {
    throw new Error(`Bogner 链输出越界(±1.5): ${label}`);
  }
}

console.log('== 4) 混叠对比:线性插值 vs 多相 FIR(Champ 链,GAIN=15)==');
{
  const BASE = 48000;
  const DRIVE = 15;
  const N = 8192;
  // 频率取采样窗整数倍,消除 DFT 泄漏:bin = 171 → 1001.95Hz
  const HARM_BIN = 171;
  const FREQ = (BASE * HARM_BIN) / N;

  function makeChampOsChain() {
    const st1 = new TriodeStage({ fs: FS, Rk: 820, Ck: 0, Rs: 68e3 });
    const st2 = new TriodeStage({ fs: FS, Rs: 100e3 });
    const pw = new TriodeStage({
      fs: FS, koren: KOREN_6V6_APPROX, Bplus: 285, Rp: 5e3, Rk: 250, Ck: 0,
      Co: 1e-3, Rload: 1e6, Rs: 220e3,
    });
    const xf = makeXformer();
    return (xOs: number) => xf(pw.process(st2.process(st1.process(xOs * DRIVE) * 0.08) * 0.25)) / 250;
  }

  /** 用指定重采样方案跑 0.5s 建立 + N 样本,返回基率输出 */
  function render(mode: 'linear' | 'poly'): Float64Array {
    const chain = makeChampOsChain();
    const fir = makeAntiAliasFIR();
    const up = new Upsampler4x(fir);
    const down = new Decimator4x(fir);
    const total = BASE / 2 + N;
    const out = new Float64Array(N);
    const osBuf = new Float32Array(OS_FACTOR);
    let x0 = 0;
    const osOut = [0, 0, 0, 0];
    for (let n = 0; n < total; n++) {
      const x = 0.3 * Math.sin((2 * Math.PI * FREQ * n) / BASE);
      if (mode === 'linear') {
        for (let k = 1; k <= OS_FACTOR; k++) {
          osOut[k - 1] = chain(x0 + ((x - x0) * k) / OS_FACTOR);
        }
        if (n >= BASE / 2) out[n - BASE / 2] = (osOut[0] + osOut[1] + osOut[2] + osOut[3]) / OS_FACTOR;
      } else {
        up.process(osBuf, x);
        for (let k = 0; k < OS_FACTOR; k++) osOut[k] = chain(osBuf[k]);
        // 降采样器必须每样本都走(否则 FIR 历史为空,建立期污染测量)
        const y = down.process(osOut[0], osOut[1], osOut[2], osOut[3]);
        if (n >= BASE / 2) out[n - BASE / 2] = y;
      }
      x0 = x;
    }
    return out;
  }

  /** 朴素 DFT 计算非谐波(镜像)能量占比 dB(精确周期,无泄漏) */
  function imageDb(y: Float64Array): number {
    const N2 = y.length;
    const harmBins = new Set<number>();
    for (let h = 0; h * HARM_BIN < N2 / 2; h++) {
      for (let d = -1; d <= 1; d++) harmBins.add(h * HARM_BIN + d);
    }
    let eTotal = 0, eHarm = 0;
    for (let k = 1; k < N2 / 2; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < N2; n++) {
        const a = (-2 * Math.PI * k * n) / N2;
        re += y[n] * Math.cos(a);
        im += y[n] * Math.sin(a);
      }
      const e = re * re + im * im;
      eTotal += e;
      if (harmBins.has(k)) eHarm += e;
    }
    return 10 * Math.log10(Math.max(1e-20, (eTotal - eHarm) / eTotal));
  }

  const dbLinear = imageDb(render('linear'));
  const dbPoly = imageDb(render('poly'));
  console.log(`线性插值镜像能量比: ${dbLinear.toFixed(1)} dB`);
  console.log(`多相 FIR 镜像能量比: ${dbPoly.toFixed(1)} dB`);
}

console.log('全部通过 ✓');
