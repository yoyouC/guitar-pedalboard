import type { SessionVerifier } from '../auth/session.ts';
import { emailVerificationRequired } from '../members/communityWriteApi.ts';
import type { MarketplaceAccountRepository } from './repository.ts';
import {
  MarketplaceAccountDeletionNotPendingError,
  MarketplaceAccountNotFoundError,
  MarketplaceAccountRecoveryExpiredError,
} from './repository.ts';

const EXPORT_PATH = '/api/marketplace/me/export';
const DELETION_PATH = '/api/marketplace/me/deletion';
const PURGE_PATH = '/api/internal/marketplace/purge-deleted-accounts';
export const RECENT_ACCOUNT_AUTHENTICATION_MS = 10 * 60 * 1000;

export interface MarketplaceAccountApi {
  fetch(request: Request): Promise<Response>;
}

export function createMarketplaceAccountApi(input: {
  repository: MarketplaceAccountRepository;
  sessions: SessionVerifier;
  now(): Date;
  cronSecret?: string;
}): MarketplaceAccountApi {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      try {
        if (request.method === 'GET' && url.pathname === PURGE_PATH) {
          if (!input.cronSecret || request.headers.get('authorization') !== `Bearer ${input.cronSecret}`) {
            return error(401, 'scheduler_authentication_required', 'Scheduler authentication required');
          }
          const purgedMemberIds = await input.repository.purgeDue(input.now());
          return Response.json({ purgedMemberIds });
        }

        if (
          !(
            (request.method === 'GET' && url.pathname === EXPORT_PATH)
            || (request.method === 'GET' && url.pathname === DELETION_PATH)
            || (request.method === 'POST' && url.pathname === DELETION_PATH)
            || (request.method === 'DELETE' && url.pathname === DELETION_PATH)
          )
        ) return new Response(null, { status: 404 });

        const identity = await input.sessions.verify(request);
        if (!identity) return error(401, 'authentication_required', 'Authentication required');

        if (request.method === 'GET' && url.pathname === EXPORT_PATH) {
          const exported = await input.repository.exportByAuthUserId(identity.authUserId, input.now());
          if (!exported) throw new MarketplaceAccountNotFoundError();
          const date = input.now().toISOString().slice(0, 10);
          return Response.json(exported, {
            headers: {
              'content-disposition': `attachment; filename="guitar-pedalboard-export-${date}.json"`,
              'cache-control': 'private, no-store',
            },
          });
        }

        if (request.method === 'GET') {
          return Response.json({ deletion: await input.repository.findDeletion(identity.authUserId) });
        }

        if ((await request.text()).trim()) {
          return error(400, 'invalid_account_request', 'Account lifecycle requests do not accept a body');
        }
        const now = input.now();
        if (identity.authenticatedAt) {
          const age = now.getTime() - identity.authenticatedAt.getTime();
          if (!Number.isFinite(age) || age < -60_000 || age > RECENT_ACCOUNT_AUTHENTICATION_MS) {
            return Response.json({ error: {
              code: 'recent_authentication_required',
              message: 'Recent authentication is required for account lifecycle changes',
              verificationUrl: `/login?return=${encodeURIComponent('/settings?section=account')}`,
            } }, { status: 403 });
          }
        }
        if (request.method === 'POST') {
          const deletion = await input.repository.requestDeletion(identity.authUserId, now);
          return Response.json({ deletion }, { status: 202 });
        }
        if (identity.emailVerified !== true) return emailVerificationRequired('/');
        await input.repository.recoverDeletion(identity.authUserId, now);
        return Response.json({ recovered: true });
      } catch (cause) {
        if (cause instanceof MarketplaceAccountNotFoundError) {
          return error(404, 'marketplace_account_not_found', 'Marketplace account not found');
        }
        if (cause instanceof MarketplaceAccountDeletionNotPendingError) {
          return error(409, 'account_deletion_not_pending', 'Account deletion is not pending');
        }
        if (cause instanceof MarketplaceAccountRecoveryExpiredError) {
          return error(410, 'account_recovery_expired', 'Account recovery period has expired');
        }
        return error(503, 'marketplace_unavailable', 'Marketplace is temporarily unavailable');
      }
    },
  };
}

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}
