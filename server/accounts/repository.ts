import type {
  MarketplaceAccountDeletion,
  MarketplaceAccountExport,
} from '../../shared/account.ts';

export const ACCOUNT_DELETION_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export class MarketplaceAccountNotFoundError extends Error {}
export class MarketplaceAccountDeletionNotPendingError extends Error {}
export class MarketplaceAccountRecoveryExpiredError extends Error {}

export interface MarketplaceAccountRepository {
  exportByAuthUserId(authUserId: string, now: Date): Promise<MarketplaceAccountExport | null>;
  findDeletion(authUserId: string): Promise<MarketplaceAccountDeletion | null>;
  requestDeletion(authUserId: string, now: Date): Promise<MarketplaceAccountDeletion>;
  recoverDeletion(authUserId: string, now: Date): Promise<void>;
  purgeDue(now: Date): Promise<string[]>;
}
