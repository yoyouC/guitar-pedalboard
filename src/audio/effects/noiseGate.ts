import type { EffectDefinition, EffectInstance } from './types';

/**
 * Noise Gate —— 基于 AudioWorklet('noise-gate')的噪声门。
 * 门限以下信号被衰减;attack/release 控制开门/关门速度。
 * 若 worklet 处理器未加载(构造抛错),兜底为直通。
 */
export const noiseGateEffect: EffectDefinition = {
  id: 'noiseGate',
  name: 'Noise Gate',
  color: '#8a8f98',
  params: [
    {
      key: 'threshold',
      label: 'Threshold',
      min: -90,
      max: 0,
      step: 1,
      defaultValue: -50,
      unit: 'dB',
    },
    {
      key: 'attack',
      label: 'Attack',
      min: 0.001,
      max: 0.05,
      step: 0.001,
      defaultValue: 0.005,
      unit: 's',
    },
    {
      key: 'release',
      label: 'Release',
      min: 0.01,
      max: 0.5,
      step: 0.01,
      defaultValue: 0.08,
      unit: 's',
    },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();

    let gateNode: AudioWorkletNode | null = null;
    try {
      gateNode = new AudioWorkletNode(ctx, 'noise-gate');
      input.connect(gateNode);
      gateNode.connect(output);
    } catch {
      // worklet 处理器未加载,兜底为直通
      console.warn('[noiseGate] AudioWorklet "noise-gate" 不可用,回退为直通');
      input.connect(output);
    }

    const update = (key: string, value: number): void => {
      if (!gateNode) return;
      const param = gateNode.parameters.get(key);
      if (param) {
        param.setTargetAtTime(value, ctx.currentTime, 0.02);
      }
    };

    const dispose = (): void => {
      input.disconnect();
      output.disconnect();
      if (gateNode) {
        // 通知处理器停止渲染(返回 false),防止僵尸 worklet 空转音频线程
        try {
          gateNode.port.postMessage({ type: 'suspend' });
          gateNode.port.onmessage = null;
        } catch {
          /* 端口已关闭 */
        }
        gateNode.disconnect();
        gateNode = null;
      }
    };

    return { input, output, update, dispose };
  },
};
