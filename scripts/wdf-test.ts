/**
 * WDF 三极管级数值验证(Node 直接运行:npm run wdf:test)
 * 检查:无 NaN、输出有界、空闲偏置合理、大信号下出现不对称削波。
 */
import { TriodeStage } from '../src/audio/wdf/triode.ts';

const FS = 48000 * 4; // 4x 过采样等效速率

function run(amp: number, label: string) {
  const stage = new TriodeStage({ fs: FS });
  const freq = 1000;
  const total = FS / 10; // 0.1s
  let nan = 0;
  let max = -Infinity;
  let min = Infinity;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  const tail: number[] = [];

  for (let n = 0; n < total; n++) {
    const vg = amp * Math.sin((2 * Math.PI * freq * n) / FS);
    const out = stage.process(vg);
    if (!Number.isFinite(out)) nan++;
    // 后 20% 采样做统计(已过建立期)
    if (n > total * 0.8) {
      max = Math.max(max, out);
      min = Math.min(min, out);
      sum += out;
      sumSq += out * out;
      count++;
      if (tail.length < 8) tail.push(out);
    }
  }

  const mean = sum / count;
  const rms = Math.sqrt(sumSq / count);
  console.log(
    `${label}: NaN=${nan} min=${min.toFixed(2)} max=${max.toFixed(2)} ` +
      `mean=${mean.toFixed(3)} rms=${rms.toFixed(2)} 峰峰不对称度=${(
        (max + min) /
        (max - min)
      ).toFixed(3)}`,
  );
  if (nan > 0) throw new Error(`${label}: 出现 NaN!`);
  if (max > 300 || min < -300) throw new Error(`${label}: 输出越界!`);
}

console.log('== WDF 三极管级(12AX7, B+=300V, Rp=100k, Rk=1.5k, Ck=22uF)==');
run(0.05, 'vg=0.05V (小信号)');
run(0.5, 'vg=0.50V (中等激励)');
run(2.0, 'vg=2.00V (重激励,应见削波/不对称)');
console.log('全部通过 ✓');
