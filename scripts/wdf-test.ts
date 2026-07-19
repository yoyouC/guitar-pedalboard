/**
 * WDF 数值验证(Node 直接运行:npm run wdf:test)
 * 1) 单级:无 NaN、输出有界、大信号不对称削波
 * 2) 全链(级1→级2→6V6→输出变压器):与 worklet 同构,链稳定、有界
 */
import { TriodeStage, KOREN_6V6_APPROX, KOREN_EL34_APPROX } from '../src/audio/wdf/triode.ts';

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

console.log('全部通过 ✓');
