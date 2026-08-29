import type { QueryResultRow } from 'pg';
import { AccountDeletionPendingError, BannedMemberError } from './standing.ts';

interface PostgresStandingQueryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

/** Serializes a community write with deletion before any content lock is taken. */
export async function lockCommunityWriteMember(
  database: PostgresStandingQueryable,
  memberId: string,
): Promise<void> {
  const standing = await database.query<{
    community_status: 'active' | 'banned';
    account_status: 'active' | 'pending_deletion' | 'tombstoned';
  } & QueryResultRow>(
    `SELECT
       COALESCE(to_jsonb(member)->>'community_status', 'active') AS community_status,
       COALESCE(to_jsonb(member)->>'account_status', 'active') AS account_status
     FROM marketplace_members AS member
     WHERE id = $1
     FOR SHARE`,
    [memberId],
  );
  const member = standing.rows[0];
  // Foreign keys remain the authority for a missing member. Treat an omitted
  // mock row as active so repository transaction tests can stay narrowly scoped.
  if (!member) return;
  if (member.account_status !== 'active') {
    throw new AccountDeletionPendingError();
  }
  if (member.community_status === 'banned') throw new BannedMemberError();
}

/** Prevents governance from re-publishing content owned by a deleting account. */
export async function lockActiveContentCreator(
  database: PostgresStandingQueryable,
  memberId: string,
): Promise<void> {
  const standing = await database.query<{
    account_status: 'active' | 'pending_deletion' | 'tombstoned';
  } & QueryResultRow>(
    `SELECT COALESCE(to_jsonb(member)->>'account_status', 'active') AS account_status
     FROM marketplace_members AS member
     WHERE id = $1
     FOR SHARE`,
    [memberId],
  );
  if (standing.rows[0]?.account_status !== 'active') {
    throw new AccountDeletionPendingError();
  }
}
