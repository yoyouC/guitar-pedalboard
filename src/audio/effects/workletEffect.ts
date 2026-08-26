import type { EffectDefinition, EffectInstance, EffectLatency, ParamDef } from './types';

/**
 * 直通 worklet 效果的数据化工厂(issue #4)。
 *
 * 适用形状:create 时 input → AudioWorkletNode → output;update 把 UI 键
 * 映射到 worklet 参数(setTargetAtTime 平滑);构造失败兜底 input → output 直通。
 * 两个 dispose 变体由 suspendOnDispose 选择:
 * - false(默认):input → node → output 顺序断开;
 * - true:input、output 先断开,再 postMessage({type:'suspend'}) 通知处理器
 *   停止渲染(防僵尸 worklet 空转音频线程),最后断开 node。
 *
 * 行为由 tests/worklet-effect.test.ts 的 pin 测试钉死。
 * wahpedal/whammy 结构超出本形状(兜底带通链 / 双键合成),保持手写。
 */

/** UI 键 → worklet 参数的映射结果 */
export interface ParamMapping {
  /** worklet 参数名 */
  param: string;
  /** 到达参数的值(已经过映射) */
  value: number;
}

export interface WorkletEffectSpec {
  id: string;
  name: string;
  color: string;
  params: ParamDef[];
  /** 处理器注册名(原样保留,包括离群值如 'bbd-analog-delay') */
  processor: string;
  /** worklet 构造失败时的兜底 warn 文案(工厂在其后追加错误对象) */
  fallbackWarn: string;
  /** AudioWorkletNode 构造 options(如 pingpong 的立体声输出) */
  workletOptions?: AudioWorkletNodeOptions;
  /** 参数平滑时间常数(s),默认 0.03 */
  smoothing?: number;
  /** dispose 变体:true = 先发 suspend 消息再断开(见文件头注释) */
  suspendOnDispose?: boolean;
  /** 构造成功后对 worklet 参数的初始同步(setValueAtTime,如 level=1) */
  initParams?: Record<string, number>;
  /** 输出级固定增益(crybabywdf 的 0.8 响度归一化) */
  outputGain?: number;
  /** 自定义 UI 键 → (参数名, 值) 映射;缺省同名直通 */
  mapParam?: (key: string, value: number) => ParamMapping;
  /** 当前模块直接监听路径的确定性时延；缺省为零。 */
  latency?: EffectLatency | ((values: Record<string, number>, sampleRate: number) => EffectLatency);
}

/**
 * 公共 mapParam:指定 dB 域键经 toGain 转线性增益,其余键同名直通。
 * 例:withDbParam('level', levelDbToGain)、withDbParam('gain', dbToGain)。
 */
export function withDbParam(
  dbKey: string,
  toGain: (db: number) => number,
): (key: string, value: number) => ParamMapping {
  return (key, value) =>
    key === dbKey ? { param: dbKey, value: toGain(value) } : { param: key, value };
}

export function defineWorkletEffect(spec: WorkletEffectSpec): EffectDefinition {
  const smoothing = spec.smoothing ?? 0.03;
  return {
    id: spec.id,
    name: spec.name,
    color: spec.color,
    params: spec.params,
    ...(spec.latency ? { latency: spec.latency } : {}),
    create(ctx: AudioContext): EffectInstance {
      const input = ctx.createGain();
      const output = ctx.createGain();
      if (spec.outputGain !== undefined) output.gain.value = spec.outputGain;

      let node: AudioWorkletNode | null = null;
      try {
        node = new AudioWorkletNode(ctx, spec.processor, spec.workletOptions);
        input.connect(node);
        node.connect(output);
      } catch (e) {
        console.warn(spec.fallbackWarn, e);
        input.connect(output);
      }
      if (node && spec.initParams) {
        for (const [key, value] of Object.entries(spec.initParams)) {
          node.parameters.get(key)?.setValueAtTime(value, ctx.currentTime);
        }
      }

      return {
        input,
        output,
        update(key, value) {
          const m = spec.mapParam
            ? spec.mapParam(key, value)
            : { param: key, value };
          node?.parameters.get(m.param)?.setTargetAtTime(m.value, ctx.currentTime, smoothing);
        },
        dispose() {
          input.disconnect();
          if (!spec.suspendOnDispose) {
            node?.disconnect();
            output.disconnect();
            return;
          }
          output.disconnect();
          if (node) {
            // 通知处理器停止渲染(返回 false),防止僵尸 worklet 空转音频线程
            try {
              node.port.postMessage({ type: 'suspend' });
              node.port.onmessage = null;
            } catch {
              /* 端口已关闭 */
            }
            node.disconnect();
            node = null;
          }
        },
      };
    },
  };
}
