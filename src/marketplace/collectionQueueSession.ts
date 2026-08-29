import { createCollectionQueueSession } from './collectionQueue';
import { marketplaceClient } from './client';
import { toneSession } from './toneSession';

function browserSessionStorage(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage; } catch { return undefined; }
}

export const collectionQueue = createCollectionQueueSession(
  marketplaceClient,
  toneSession,
  browserSessionStorage(),
);
