import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type {
  CreateMemberInput,
  HandleResolution,
  MemberRecord,
  MemberRepository,
  UpdateMemberProfileInput,
} from './repository.js';
import { assertCommunityWriteAllowed } from './standing.js';
import { normalizeSearchText } from '../search/text.js';
import { markMarketplaceTextSearchProjectionWrite } from '../search/postgresTextProjection.js';
import {
  HANDLE_CHANGE_INTERVAL_MS,
  HandleChangeTooSoonError,
  HandleUnavailableError,
  MemberUpdateConflictError,
} from './repository.js';

interface MemberRow extends QueryResultRow {
  id: string;
  auth_user_id: string | null;
  handle: string;
  display_name: string;
  bio: string;
  avatar_url: string | null;
  handle_changed_at: Date | string | null;
  terms_accepted_version: string | null;
  public_profile_completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  community_status: 'active' | 'banned';
  account_status: 'active' | 'pending_deletion' | 'tombstoned';
}

function date(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function record(row: MemberRow): MemberRecord {
  return {
    id: row.id,
    authUserId: row.auth_user_id,
    handle: row.handle,
    displayName: row.display_name,
    bio: row.bio,
    avatarUrl: row.avatar_url,
    handleChangedAt: row.handle_changed_at ? date(row.handle_changed_at) : null,
    termsAcceptedVersion: row.terms_accepted_version,
    publicProfileCompletedAt: row.public_profile_completed_at
      ? date(row.public_profile_completed_at)
      : null,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
    communityStatus: row.community_status,
    accountStatus: row.account_status,
  };
}

function isUniqueViolation(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === '23505';
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
}

const MEMBER_SELECT = `SELECT
  member.id,
  identity.auth_user_id,
  member.handle,
  member.display_name,
  member.bio,
  member.avatar_url,
  member.handle_changed_at,
  member.terms_accepted_version,
  member.public_profile_completed_at,
  member.created_at,
  member.updated_at,
  member.community_status,
  member.account_status
FROM marketplace_members AS member
LEFT JOIN marketplace_member_auth_identities AS identity ON identity.member_id = member.id`;

export function createPostgresMemberRepository(pool: Pool): MemberRepository {
  return {
    async findById(memberId) {
      const result = await pool.query<MemberRow>(
        `${MEMBER_SELECT} WHERE member.id = $1 AND member.account_status <> 'tombstoned' LIMIT 1`,
        [memberId],
      );
      return result.rows[0] ? record(result.rows[0]) : null;
    },

    async findOrCreateForIdentity(input: CreateMemberInput) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const existing = await client.query<MemberRow>(
          `${MEMBER_SELECT} WHERE identity.auth_user_id = $1 FOR UPDATE OF member`,
          [input.identity.authUserId],
        );
        if (existing.rows[0]) {
          await client.query('COMMIT');
          return record(existing.rows[0]);
        }

        await client.query(
          `INSERT INTO marketplace_members
            (id, handle, display_name, bio, avatar_url, search_text, created_at, updated_at)
           VALUES ($1, $2, $3, '', $4, $5, $6, $6)`,
          [input.id, input.handle, input.identity.displayName, input.identity.avatarUrl,
            normalizeSearchText(`${input.handle} ${input.identity.displayName}`), input.now],
        );
        await client.query(
          `INSERT INTO marketplace_member_handle_claims (handle, member_id, claimed_at)
           VALUES ($1, $2, $3)`,
          [input.handle, input.id, input.now],
        );
        await client.query(
          `INSERT INTO marketplace_member_auth_identities (auth_user_id, member_id, linked_at)
           VALUES ($1, $2, $3)`,
          [input.identity.authUserId, input.id, input.now],
        );
        await client.query('COMMIT');
        return {
          id: input.id,
          authUserId: input.identity.authUserId,
          handle: input.handle,
          displayName: input.identity.displayName,
          bio: '',
          avatarUrl: input.identity.avatarUrl,
          handleChangedAt: null,
          termsAcceptedVersion: null,
          publicProfileCompletedAt: null,
          createdAt: input.now,
          updatedAt: input.now,
          communityStatus: 'active',
          accountStatus: 'active',
        };
      } catch (cause) {
        await rollback(client);
        if (isUniqueViolation(cause)) {
          const concurrent = await client.query<MemberRow>(
            `${MEMBER_SELECT} WHERE identity.auth_user_id = $1 LIMIT 1`,
            [input.identity.authUserId],
          );
          if (concurrent.rows[0]) return record(concurrent.rows[0]);
          throw new HandleUnavailableError();
        }
        throw cause;
      } finally {
        client.release();
      }
    },

    async resolveHandle(handle): Promise<HandleResolution> {
      const result = await pool.query<MemberRow>(
        `${MEMBER_SELECT}
         JOIN marketplace_member_handle_claims AS claim ON claim.member_id = member.id
         WHERE claim.handle = $1 AND member.account_status <> 'tombstoned'
         LIMIT 1`,
        [handle],
      );
      if (!result.rows[0]) return { kind: 'missing' };
      const member = record(result.rows[0]);
      return { kind: member.handle === handle ? 'current' : 'redirect', member };
    },

    async updateProfile(memberId, update: UpdateMemberProfileInput, now) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const selected = await client.query<MemberRow>(
          `${MEMBER_SELECT} WHERE member.id = $1 FOR UPDATE OF member`,
          [memberId],
        );
        const current = selected.rows[0] ? record(selected.rows[0]) : null;
        if (!current) throw new Error('Member not found');
        assertCommunityWriteAllowed(current);
        if (current.updatedAt.getTime() !== update.expectedUpdatedAt.getTime()) {
          throw new MemberUpdateConflictError();
        }

        const changesHandle = update.handle !== undefined && update.handle !== current.handle;
        if (changesHandle) {
          if (current.handleChangedAt) {
            const nextChangeAt = new Date(
              current.handleChangedAt.getTime() + HANDLE_CHANGE_INTERVAL_MS,
            );
            if (now < nextChangeAt) throw new HandleChangeTooSoonError(nextChangeAt);
          }
          await client.query(
            `INSERT INTO marketplace_member_handle_claims (handle, member_id, claimed_at)
             VALUES ($1, $2, $3)`,
            [update.handle, memberId, now],
          );
        }

        await markMarketplaceTextSearchProjectionWrite(client);
        const result = await client.query<MemberRow>(
          `UPDATE marketplace_members AS member SET
             handle = $2,
             display_name = $3,
             bio = $4,
             handle_changed_at = $5,
             terms_accepted_version = $6,
             public_profile_completed_at = $7,
             search_text = $8,
             updated_at = $9
           FROM marketplace_member_auth_identities AS identity
           WHERE member.id = $1 AND identity.member_id = member.id
           RETURNING member.id, identity.auth_user_id, member.handle, member.display_name,
             member.bio, member.avatar_url, member.handle_changed_at,
             member.terms_accepted_version, member.public_profile_completed_at,
             member.created_at, member.updated_at, member.community_status,
             member.account_status`,
          [
            memberId,
            changesHandle ? update.handle : current.handle,
            update.displayName ?? current.displayName,
            update.bio ?? current.bio,
            changesHandle ? now : current.handleChangedAt,
            update.termsAcceptedVersion ?? current.termsAcceptedVersion,
            update.termsAcceptedVersion ? now : current.publicProfileCompletedAt,
            normalizeSearchText(`${
              changesHandle ? update.handle : current.handle
            } ${update.displayName ?? current.displayName}`),
            now,
          ],
        );
        await client.query('COMMIT');
        return record(result.rows[0]);
      } catch (cause) {
        await rollback(client);
        if (isUniqueViolation(cause)) throw new HandleUnavailableError();
        throw cause;
      } finally {
        client.release();
      }
    },
  };
}
