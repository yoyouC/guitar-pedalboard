/**
 * 程序生成立体声指数衰减噪声脉冲响应,供 ConvolverNode 混响使用。
 * @param seconds 混响尾长(秒)
 * @param decay   衰减指数,越大衰减越快(常用 2~4)
 */
export function makeImpulseResponse(
  ctx: AudioContext,
  seconds: number,
  decay: number,
): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buffer = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buffer;
}
