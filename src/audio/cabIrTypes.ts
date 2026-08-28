export const BUILTIN_CAB_IDS = ['open1x12', 'blue2x12', 'gb4x12', 'v304x12'] as const;

export type BuiltinCabId = (typeof BUILTIN_CAB_IDS)[number];

/** Canonical、可序列化的箱体 IR 身份；不包含文件、Blob 或 AudioBuffer。 */
export type CabIrRef =
  | { kind: 'builtin'; id: BuiltinCabId }
  | { kind: 'custom'; hash: string };

export function isBuiltinCabId(value: unknown): value is BuiltinCabId {
  return typeof value === 'string' && BUILTIN_CAB_IDS.includes(value as BuiltinCabId);
}

export function cabIdFromRef(ref: CabIrRef): BuiltinCabId | 'customIr' {
  return ref.kind === 'builtin' ? ref.id : 'customIr';
}

export function cabIrRefKey(ref: CabIrRef): string {
  return ref.kind === 'builtin' ? `builtin:${ref.id}` : `custom:${ref.hash}`;
}

export function defaultCabIrRef(): CabIrRef {
  return { kind: 'builtin', id: 'gb4x12' };
}
