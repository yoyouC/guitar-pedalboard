/**
 * Deterministic string hash (FNV-1a, 32-bit) used to derive stable visuals
 * (backdrop gradients, avatar hues) from data such as a preset id.
 */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic hue (0–359) from a string seed. */
export function hueFromString(input: string): number {
  return hashString(input) % 360;
}
