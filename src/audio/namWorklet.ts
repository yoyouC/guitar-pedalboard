import processorSource from './namProcessor.js?raw';

let loaded = false;

/** 幂等加载 NAM LSTM worklet,使用前必须先 await */
export async function loadNamWorklet(ctx: AudioContext): Promise<void> {
  if (loaded) return;
  const url = URL.createObjectURL(
    new Blob([processorSource], { type: 'application/javascript' }),
  );
  try {
    await ctx.audioWorklet.addModule(url);
    loaded = true;
  } finally {
    URL.revokeObjectURL(url);
  }
}
