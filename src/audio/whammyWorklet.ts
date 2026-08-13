/**
 * Whammy 风格移调踏板的 AudioWorklet 处理器,以 Blob 形式内联加载。
 *
 * 算法:调制延迟线移调(Doppler 原理,Puckette/STK/Faust 同款经典方案)。
 * 输出 y(t) = x(t - D(t)),音高比 r = 1 - D'(t):延迟线性减小→升调,
 * 线性增大→降调。单读头在锯齿回绕点会咔哒,故用两个相位差 180° 的
 * 读头 + sin² 余弦窗交叉淡化(两窗增益恒和为 1)。
 *   窗长 A = 12ms(伪影与延迟的折中),基础延迟 1ms,平均延迟 ~7ms。
 * 分数延迟用 4 点 Catmull-Rom 立方插值(线性插值会糊高频并引入调制噪声)。
 * r=1(无移调)时退化为单读头固定 7ms 延迟:响应平直、无双读头梳状染色,
 * 且与移调状态延迟一致,接入/退出无跳变。
 * 参数 semitones 为 a-rate,逐样本改变锯齿频率即可连续滑音(摇杆/MIDI)。
 * 两个工程化修正:
 * 1) r=1 附近时相位缓向 0.5 —— 此时读头1满增益、读头2零增益,退化为
 *    单读头固定 7ms 延迟:静止状态平直透明(无双读头梳状染色),且
 *    接入/退出移调时延迟连续、无咔哒。
 * 2) 移调分支加 ×1.3 补偿增益:两读头相位不相干,交叉淡化区平均损失
 *    ~2.3dB(随 |dev| 从 0 渐变进入,静止时严格 unity)。
 * 固有特性:小音程下移调质量良好,但存在经典 whammy 式颤音伪影
 * (交叉淡化区两读头相位差导致 ±fSaw 边带),与真机 Digitech Whammy
 * 单音版本的 warble 特性一致。
 */
import { createWorkletLoader } from './workletLoader';

const processorSource = `(() => {
  const BUF_LEN = 4096;        // 2 的幂,绕回用位与
  const BASE_DELAY = 48;       // 1ms @48k
  const WINDOW_SEC = 0.012;    // 交叉淡化窗长 12ms

  class WhammyChannel {
    constructor(fs) {
      this.buf = new Float32Array(BUF_LEN);
      this.A = WINDOW_SEC * fs; // 窗长(采样)
    }
    // 4 点 Catmull-Rom 立方插值读分数延迟,pos 相对写指针(可为负,绕回)
    read(pos) {
      const i = Math.floor(pos);
      const f = pos - i;
      const m = BUF_LEN - 1;
      const y0 = this.buf[(i - 1) & m];
      const y1 = this.buf[i & m];
      const y2 = this.buf[(i + 1) & m];
      const y3 = this.buf[(i + 2) & m];
      return y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0)));
    }
  }

  class WhammyProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [
        { name: 'semitones', defaultValue: 0, minValue: -12, maxValue: 12, automationRate: 'a-rate' },
        { name: 'level', defaultValue: 1, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
      ];
    }

    constructor() {
      super();
      this.chans = [];
      this.wp = 0;
      this.phase = 0; // 共享锯齿相位 0..1(立体声声像稳定)
      this.suspended = false;
      this.port.onmessage = (e) => {
        if (e.data && e.data.type === 'suspend') this.suspended = true;
      };
    }

    process(inputs, outputs, params) {
      if (this.suspended) return false;
      const input = inputs[0];
      const output = outputs[0];
      if (!input || !input.length) return true;
      while (this.chans.length < input.length) this.chans.push(new WhammyChannel(sampleRate));

      const semiArr = params.semitones;
      const level = params.level[0];
      const n = input[0].length;

      for (let i = 0; i < n; i++) {
        const st = semiArr.length > 1 ? semiArr[i] : semiArr[0];
        const r = Math.pow(2, st / 12);
        const dev = r - 1;
        const A = this.chans[0].A;

        let phaseRate = 0;
        let makeup = 1;
        if (Math.abs(dev) < 1e-5) {
          // 静止:相位缓向 0.5(单读头全增益),消除静止染色与接入咔哒
          const dp = 0.5 - this.phase;
          const step = 0.0005;
          if (Math.abs(dp) <= step) this.phase = 0.5;
          else this.phase += Math.sign(dp) * step;
        } else {
          // 带符号相位速率:延迟始终 D = BASE + A·phase,方向由速率符号
          // 决定(负=延迟减小=升调),换向时相位/延迟连续,无咔哒
          phaseRate = -dev / A;
          // 交叉淡化非相干损耗补偿:随 |dev| 渐变进入(约 0.5 半音处到满)
          makeup = 1 + 0.3 * Math.min(1, Math.abs(dev) / 0.03);
        }

        for (let ch = 0; ch < input.length; ch++) {
          const c = this.chans[ch];
          c.buf[this.wp] = input[ch][i];
          let y = 0;
          for (let t = 0; t < 2; t++) {
            const ph = (this.phase + t * 0.5) % 1;
            const d = BASE_DELAY + A * ph;
            const s = Math.sin(Math.PI * ph);
            y += s * s * c.read(this.wp - d);
          }
          output[ch][i] = y * makeup * level;
        }
        this.phase = (((this.phase + phaseRate) % 1) + 1) % 1;
        this.wp = (this.wp + 1) & (BUF_LEN - 1);
      }
      return true;
    }
  }

  registerProcessor('whammy-shift', WhammyProcessor);
})();`;

/** 幂等加载(按 AudioContext 注册),使用前必须先 await */
export const loadWhammyWorklet = createWorkletLoader(processorSource);
