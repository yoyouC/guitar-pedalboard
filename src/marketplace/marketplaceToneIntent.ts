const STORAGE_KEY = 'guitar-pedalboard:marketplace-tone3000-apply:v1';

export interface MarketplaceToneApplyIntent {
  presetId: string;
  revisionId: string;
  returnPath: string;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function parse(value: string | null): MarketplaceToneApplyIntent | null {
  if (!value) return null;
  try {
    const intent = JSON.parse(value) as Partial<MarketplaceToneApplyIntent>;
    if (typeof intent.presetId !== 'string' || !intent.presetId
      || typeof intent.revisionId !== 'string' || !intent.revisionId
      || typeof intent.returnPath !== 'string'
      || !/^\/marketplace\/tones\/[^/]+(?:\/revisions\/[^/]+)?$/.test(intent.returnPath)) return null;
    return intent as MarketplaceToneApplyIntent;
  } catch {
    return null;
  }
}

export function stashMarketplaceToneApplyIntent(
  intent: MarketplaceToneApplyIntent,
  storage: StorageLike,
): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(intent));
}

export function peekMarketplaceToneApplyIntent(storage: StorageLike): MarketplaceToneApplyIntent | null {
  const intent = parse(storage.getItem(STORAGE_KEY));
  if (!intent) storage.removeItem(STORAGE_KEY);
  return intent;
}

export function popMarketplaceToneApplyIntent(storage: StorageLike): MarketplaceToneApplyIntent | null {
  const intent = peekMarketplaceToneApplyIntent(storage);
  storage.removeItem(STORAGE_KEY);
  return intent;
}
