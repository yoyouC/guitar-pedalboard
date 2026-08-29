const DEFAULT_POST_EFFECT_IDS = new Set([
  'delay',
  'reverb',
  'springreverb',
  'plate',
  'shimmer',
  'analogdelay',
  'tapedelay',
  'pingpong',
]);

/** Canonical default placement used when a pedal has no saved `post` value. */
export function isDefaultPostEffect(effectId: string): boolean {
  return DEFAULT_POST_EFFECT_IDS.has(effectId);
}
