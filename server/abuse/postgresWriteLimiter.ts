import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { AccountDeletionPendingError } from '../members/standing.js';
import type { MarketplaceWriteLimiter, MarketplaceWritePolicies, TokenBucketPolicy } from './writeLimiter.js';

interface BucketRow extends QueryResultRow {
  scope: 'member' | 'network';
  subject_hash: string;
  tokens: number;
  updated_at: Date | string;
}

export async function marketplaceWriteSubjectHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function deleteMarketplaceWriteBucketsForMember(
  client: Pick<PoolClient, 'query'>,
  memberId: string,
): Promise<void> {
  await client.query(
    `DELETE FROM marketplace_write_rate_buckets
     WHERE scope = 'member' AND subject_hash = $1`,
    [await marketplaceWriteSubjectHash(memberId)],
  );
}

function idleTtlMs(policy: { member: TokenBucketPolicy; network: TokenBucketPolicy }): number {
  return Math.ceil(Math.max(
    policy.member.burst / policy.member.refillPerMinute,
    policy.network.burst / policy.network.refillPerMinute,
  ) * 60_000);
}

function refill(row: BucketRow | undefined, policy: TokenBucketPolicy, now: number): number {
  if (!row) return policy.burst;
  const updatedAt = new Date(row.updated_at).getTime();
  return Math.min(policy.burst, Number(row.tokens) + Math.max(0, now - updatedAt) * policy.refillPerMinute / 60_000);
}

export function createPostgresMarketplaceWriteLimiter(
  pool: Pool,
  policies: MarketplaceWritePolicies,
): MarketplaceWriteLimiter {
  return {
    async consume(input) {
      const policy = policies[input.operation];
      if (!policy) return { allowed: true };
      const subjects = {
        member: await marketplaceWriteSubjectHash(input.memberId),
        network: await marketplaceWriteSubjectHash(input.networkSource),
      };
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const member = await client.query<{ account_status: string } & QueryResultRow>(
          `SELECT account_status FROM marketplace_members WHERE id = $1 FOR UPDATE`,
          [input.memberId],
        );
        if (member.rows[0]?.account_status !== 'active') throw new AccountDeletionPendingError();
        await client.query(
          `DELETE FROM marketplace_write_rate_buckets
           WHERE operation = $1 AND updated_at <= $2`,
          [input.operation, new Date(input.now.getTime() - idleTtlMs(policy))],
        );
        for (const scope of ['member', 'network'] as const) {
          await client.query(
            `INSERT INTO marketplace_write_rate_buckets
               (operation, scope, subject_hash, tokens, updated_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (operation, scope, subject_hash) DO NOTHING`,
            [input.operation, scope, subjects[scope], policy[scope].burst, input.now],
          );
        }
        const result = await client.query<BucketRow>(
          `SELECT scope, subject_hash, tokens, updated_at
           FROM marketplace_write_rate_buckets
           WHERE operation = $1
             AND ((scope = 'member' AND subject_hash = $2)
               OR (scope = 'network' AND subject_hash = $3))
           ORDER BY scope FOR UPDATE`,
          [input.operation, subjects.member, subjects.network],
        );
        const now = input.now.getTime();
        const candidates = (['member', 'network'] as const).map((scope) => ({
          scope, subjectHash: subjects[scope], policy: policy[scope],
          tokens: refill(result.rows.find((row) => row.scope === scope), policy[scope], now),
        }));
        const denied = candidates.filter((item) => item.tokens < 1);
        const allowed = denied.length === 0;
        for (const item of candidates) {
          await client.query(
            `UPDATE marketplace_write_rate_buckets
             SET tokens = $4, updated_at = $5
             WHERE operation = $1 AND scope = $2 AND subject_hash = $3`,
            [input.operation, item.scope, item.subjectHash, allowed ? item.tokens - 1 : item.tokens, input.now],
          );
        }
        await client.query('COMMIT');
        if (allowed) return { allowed: true };
        return {
          allowed: false,
          retryAt: new Date(Math.ceil(Math.max(...denied.map((item) => (
            now + (1 - item.tokens) * 60_000 / item.policy.refillPerMinute
          ))))),
        };
      } catch (cause) {
        try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
        throw cause;
      } finally {
        client.release();
      }
    },
    async purgeMember(memberId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM marketplace_members WHERE id = $1 FOR UPDATE', [memberId]);
        await deleteMarketplaceWriteBucketsForMember(client, memberId);
        await client.query('COMMIT');
      } catch (cause) {
        try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
        throw cause;
      } finally {
        client.release();
      }
    },
  };
}
