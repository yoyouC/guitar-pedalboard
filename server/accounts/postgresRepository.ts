import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { MarketplaceAccountExport } from '../../shared/account.ts';
import { deleteMarketplaceWriteBucketsForMember } from '../abuse/postgresWriteLimiter.ts';
import { rebuildMarketplaceLikeCountsInTransaction } from '../likes/postgresRepository.ts';
import { MARKETPLACE_LIKE_WRITE_LOCK } from '../likes/postgresLock.ts';
import {
  DEFAULT_MARKETPLACE_TRENDING_POLICY,
  type MarketplaceTrendingPolicy,
} from '../trending/policy.ts';
import { rebuildMarketplaceTrendingInTransaction } from '../trending/postgresRepository.ts';
import {
  ACCOUNT_DELETION_GRACE_MS,
  MarketplaceAccountDeletionNotPendingError,
  MarketplaceAccountNotFoundError,
  MarketplaceAccountRecoveryExpiredError,
  type MarketplaceAccountRepository,
} from './repository.ts';

interface MemberExportRow extends QueryResultRow {
  id: string;
  handle: string;
  display_name: string;
  bio: string;
  avatar_url: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  email: string;
  account_status: 'active' | 'pending_deletion' | 'tombstoned';
}

interface DeletionRow extends QueryResultRow {
  member_id: string;
  requested_at: Date | string;
  purge_after: Date | string;
  account_status: 'active' | 'pending_deletion' | 'tombstoned';
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
}

async function memberByAuthUserId(
  client: PoolClient,
  authUserId: string,
  lock = false,
): Promise<MemberExportRow | null> {
  const result = await client.query<MemberExportRow>(
    `SELECT member.id, member.handle, member.display_name, member.bio, member.avatar_url,
            member.created_at, member.updated_at, auth_user.email, member.account_status
     FROM marketplace_member_auth_identities AS identity
     JOIN marketplace_members AS member ON member.id = identity.member_id
     JOIN marketplace_auth_users AS auth_user ON auth_user.id = identity.auth_user_id
     WHERE identity.auth_user_id = $1
     LIMIT 1${lock ? ' FOR UPDATE OF member' : ''}`,
    [authUserId],
  );
  return result.rows[0] ?? null;
}

export function createPostgresMarketplaceAccountRepository(
  pool: Pool,
  trendingPolicy: MarketplaceTrendingPolicy = DEFAULT_MARKETPLACE_TRENDING_POLICY,
): MarketplaceAccountRepository {
  return {
    async exportByAuthUserId(authUserId, now) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const member = await memberByAuthUserId(client, authUserId);
        if (!member || member.account_status === 'tombstoned') {
          await client.query('COMMIT');
          return null;
        }

        const presets = await client.query<{
          id: string; title: string; description: string; visibility: string;
          source_preset_id: string | null; source_revision_id: string | null;
          created_at: Date | string; updated_at: Date | string;
          tag_ids: string[];
        } & QueryResultRow>(
          `SELECT preset.id, preset.title, preset.description, preset.visibility,
                  preset.source_preset_id, preset.source_revision_id,
                  preset.created_at, preset.updated_at,
                  COALESCE(array_agg(tag.tag_id ORDER BY tag.tag_id)
                    FILTER (WHERE tag.tag_id IS NOT NULL), '{}'::text[]) AS tag_ids
           FROM marketplace_published_presets AS preset
           LEFT JOIN marketplace_published_preset_tags AS tag ON tag.preset_id = preset.id
           WHERE preset.creator_id = $1
           GROUP BY preset.id
           ORDER BY preset.created_at, preset.id`,
          [member.id],
        );
        const presetExports: MarketplaceAccountExport['presets'] = [];
        for (const preset of presets.rows) {
          const revisions = await client.query<{
            id: string; schema_version: number; resource_dependencies: unknown;
            derived_attributes: unknown; rig: unknown; created_at: Date | string;
          } & QueryResultRow>(
            `SELECT id, schema_version, resource_dependencies, derived_attributes, rig, created_at
             FROM marketplace_published_preset_revisions
             WHERE preset_id = $1
             ORDER BY created_at, id`,
            [preset.id],
          );
          presetExports.push({
            id: preset.id,
            title: preset.title,
            description: preset.description,
            visibility: preset.visibility,
            tagIds: preset.tag_ids,
            source: preset.source_preset_id && preset.source_revision_id
              ? { presetId: preset.source_preset_id, revisionId: preset.source_revision_id }
              : null,
            revisions: revisions.rows.map((revision) => ({
              id: revision.id,
              schemaVersion: revision.schema_version,
              resourceDependencies: revision.resource_dependencies,
              derivedAttributes: revision.derived_attributes,
              rig: revision.rig,
              createdAt: iso(revision.created_at),
            })),
            createdAt: iso(preset.created_at),
            updatedAt: iso(preset.updated_at),
          });
        }

        const collections = await client.query<{
          id: string; title: string; description: string; visibility: string;
          created_at: Date | string; updated_at: Date | string; tag_ids: string[];
          items: Array<{ position: number; presetId: string; revisionId: string }>;
        } & QueryResultRow>(
          `SELECT collection.id, collection.title, collection.description, collection.visibility,
                  collection.created_at, collection.updated_at,
                  COALESCE((
                    SELECT array_agg(tag.tag_id ORDER BY tag.tag_id)
                    FROM marketplace_preset_collection_tags AS tag
                    WHERE tag.collection_id = collection.id
                  ), '{}'::text[]) AS tag_ids,
                  COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                      'position', item.position,
                      'presetId', item.preset_id,
                      'revisionId', item.revision_id
                    ) ORDER BY item.position)
                    FROM marketplace_preset_collection_items AS item
                    WHERE item.collection_id = collection.id
                  ), '[]'::jsonb) AS items
           FROM marketplace_preset_collections AS collection
           WHERE collection.creator_id = $1
           ORDER BY collection.created_at, collection.id`,
          [member.id],
        );
        const presetLikes = await client.query<{
          preset_id: string; created_at: Date | string;
        } & QueryResultRow>(
          `SELECT preset_id, created_at FROM marketplace_preset_likes
           WHERE member_id = $1 ORDER BY created_at, preset_id`,
          [member.id],
        );
        const collectionLikes = await client.query<{
          collection_id: string; created_at: Date | string;
        } & QueryResultRow>(
          `SELECT collection_id, created_at FROM marketplace_collection_likes
           WHERE member_id = $1 ORDER BY created_at, collection_id`,
          [member.id],
        );
        const reports = await client.query<{
          id: string; target_kind: string; target_id: string; reason: string;
          details: string; status: string; created_at: Date | string;
        } & QueryResultRow>(
          `SELECT id, target_kind, target_id, reason, details, status, created_at
           FROM marketplace_moderation_reports
           WHERE reporter_member_id = $1 ORDER BY created_at, id`,
          [member.id],
        );
        const appeals = await client.query<{
          id: string; action_id: string; statement: string; status: string;
          created_at: Date | string;
        } & QueryResultRow>(
          `SELECT id, action_id, statement, status, created_at
           FROM marketplace_moderation_appeals
           WHERE author_member_id = $1 ORDER BY created_at, id`,
          [member.id],
        );
        await client.query('COMMIT');
        return {
          formatVersion: 1,
          exportedAt: now.toISOString(),
          account: { email: member.email },
          member: {
            id: member.id,
            handle: member.handle,
            displayName: member.display_name,
            bio: member.bio,
            avatarUrl: member.avatar_url,
            createdAt: iso(member.created_at),
            updatedAt: iso(member.updated_at),
          },
          presets: presetExports,
          collections: collections.rows.map((collection) => ({
            id: collection.id,
            title: collection.title,
            description: collection.description,
            visibility: collection.visibility,
            tagIds: collection.tag_ids,
            items: collection.items,
            createdAt: iso(collection.created_at),
            updatedAt: iso(collection.updated_at),
          })),
          relationships: {
            presetLikes: presetLikes.rows.map((like) => ({
              presetId: like.preset_id, createdAt: iso(like.created_at),
            })),
            collectionLikes: collectionLikes.rows.map((like) => ({
              collectionId: like.collection_id, createdAt: iso(like.created_at),
            })),
            moderationReports: reports.rows.map((report) => ({
              id: report.id,
              targetKind: report.target_kind,
              targetId: report.target_id,
              reason: report.reason,
              details: report.details,
              status: report.status,
              createdAt: iso(report.created_at),
            })),
            moderationAppeals: appeals.rows.map((appeal) => ({
              id: appeal.id,
              actionId: appeal.action_id,
              statement: appeal.statement,
              status: appeal.status,
              createdAt: iso(appeal.created_at),
            })),
          },
        };
      } catch (cause) {
        await rollback(client);
        throw cause;
      } finally {
        client.release();
      }
    },

    async findDeletion(authUserId) {
      const result = await pool.query<DeletionRow>(
        `SELECT request.member_id, request.requested_at, request.purge_after,
                member.account_status
         FROM marketplace_member_auth_identities AS identity
         JOIN marketplace_members AS member ON member.id = identity.member_id
         LEFT JOIN marketplace_account_deletion_requests AS request
           ON request.member_id = member.id
         WHERE identity.auth_user_id = $1
         LIMIT 1`,
        [authUserId],
      );
      const row = result.rows[0];
      return row?.requested_at && row.purge_after ? {
        status: 'pending',
        requestedAt: iso(row.requested_at),
        purgeAfter: iso(row.purge_after),
      } : null;
    },

    async requestDeletion(authUserId, now) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const member = await memberByAuthUserId(client, authUserId, true);
        if (!member || member.account_status === 'tombstoned') {
          throw new MarketplaceAccountNotFoundError();
        }
        const existing = await client.query<DeletionRow>(
          `SELECT request.member_id, request.requested_at, request.purge_after,
                  member.account_status
           FROM marketplace_account_deletion_requests AS request
           JOIN marketplace_members AS member ON member.id = request.member_id
           WHERE request.member_id = $1`,
          [member.id],
        );
        if (existing.rows[0]) {
          await client.query('COMMIT');
          return {
            status: 'pending',
            requestedAt: iso(existing.rows[0].requested_at),
            purgeAfter: iso(existing.rows[0].purge_after),
          };
        }
        const purgeAfter = new Date(now.getTime() + ACCOUNT_DELETION_GRACE_MS);
        await client.query(
          `INSERT INTO marketplace_account_deletion_requests
             (member_id, requested_at, purge_after)
           VALUES ($1, $2, $3)`,
          [member.id, now, purgeAfter],
        );
        await client.query(
          `INSERT INTO marketplace_account_deletion_restorations
             (member_id, target_kind, target_id, previous_visibility)
           SELECT $1, 'preset', id, visibility
           FROM marketplace_published_presets
           WHERE creator_id = $1 AND visibility IN ('public', 'unlisted')
           UNION ALL
           SELECT $1, 'collection', id, visibility
           FROM marketplace_preset_collections
           WHERE creator_id = $1 AND visibility IN ('public', 'unlisted')`,
          [member.id],
        );
        await client.query(
          `UPDATE marketplace_published_presets SET visibility = 'withdrawn', updated_at = $2
           WHERE creator_id = $1 AND visibility IN ('public', 'unlisted')`,
          [member.id, now],
        );
        await client.query(
          `UPDATE marketplace_preset_collections SET visibility = 'withdrawn', updated_at = $2
           WHERE creator_id = $1 AND visibility IN ('public', 'unlisted')`,
          [member.id, now],
        );
        await client.query(
          `UPDATE marketplace_members SET account_status = 'pending_deletion', updated_at = $2
           WHERE id = $1`,
          [member.id, now],
        );
        await client.query(
          `DELETE FROM marketplace_auth_sessions WHERE "userId" = $1`,
          [authUserId],
        );
        await client.query(
          `DELETE FROM marketplace_auth_verifications
           WHERE strpos(value, '"email":' || to_json($1::text)::text) > 0`,
          [member.email],
        );
        await client.query('COMMIT');
        return {
          status: 'pending',
          requestedAt: now.toISOString(),
          purgeAfter: purgeAfter.toISOString(),
        };
      } catch (cause) {
        await rollback(client);
        throw cause;
      } finally {
        client.release();
      }
    },

    async recoverDeletion(authUserId, now) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const member = await memberByAuthUserId(client, authUserId, true);
        if (!member || member.account_status === 'tombstoned') {
          throw new MarketplaceAccountNotFoundError();
        }
        const result = await client.query<DeletionRow>(
          `SELECT request.member_id, request.requested_at, request.purge_after,
                  member.account_status
           FROM marketplace_account_deletion_requests AS request
           JOIN marketplace_members AS member ON member.id = request.member_id
           WHERE request.member_id = $1 FOR UPDATE OF request`,
          [member.id],
        );
        const deletion = result.rows[0];
        if (!deletion || deletion.account_status !== 'pending_deletion') {
          throw new MarketplaceAccountDeletionNotPendingError();
        }
        if (new Date(deletion.purge_after) <= now) throw new MarketplaceAccountRecoveryExpiredError();
        await client.query(
          `UPDATE marketplace_published_presets AS preset
           SET visibility = restoration.previous_visibility, updated_at = $2
           FROM marketplace_account_deletion_restorations AS restoration
           WHERE restoration.member_id = $1
             AND restoration.target_kind = 'preset'
             AND restoration.target_id = preset.id
             AND preset.visibility = 'withdrawn'`,
          [member.id, now],
        );
        await client.query(
          `UPDATE marketplace_preset_collections AS collection
           SET visibility = restoration.previous_visibility, updated_at = $2
           FROM marketplace_account_deletion_restorations AS restoration
           WHERE restoration.member_id = $1
             AND restoration.target_kind = 'collection'
             AND restoration.target_id = collection.id
             AND collection.visibility = 'withdrawn'`,
          [member.id, now],
        );
        await client.query(
          `UPDATE marketplace_members SET account_status = 'active', updated_at = $2 WHERE id = $1`,
          [member.id, now],
        );
        await client.query(
          `DELETE FROM marketplace_account_deletion_requests WHERE member_id = $1`,
          [member.id],
        );
        await client.query('COMMIT');
      } catch (cause) {
        await rollback(client);
        throw cause;
      } finally {
        client.release();
      }
    },

    async purgeDue(now) {
      const due = await pool.query<{ member_id: string } & QueryResultRow>(
        `SELECT member_id FROM marketplace_account_deletion_requests
         WHERE purge_after <= $1 ORDER BY purge_after, member_id`,
        [now],
      );
      const purgedMemberIds: string[] = [];
      for (const { member_id: memberId } of due.rows) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT pg_advisory_xact_lock($1)', [MARKETPLACE_LIKE_WRITE_LOCK]);
          const locked = await client.query<{
            member_id: string; auth_user_id: string | null; email: string | null;
          } & QueryResultRow>(
            `SELECT request.member_id, identity.auth_user_id, auth_user.email
             FROM marketplace_account_deletion_requests AS request
             JOIN marketplace_members AS member ON member.id = request.member_id
             LEFT JOIN marketplace_member_auth_identities AS identity ON identity.member_id = member.id
             LEFT JOIN marketplace_auth_users AS auth_user ON auth_user.id = identity.auth_user_id
             WHERE request.member_id = $1 AND request.purge_after <= $2
               AND member.account_status = 'pending_deletion'
             FOR UPDATE OF request, member`,
            [memberId, now],
          );
          const account = locked.rows[0];
          if (!account) {
            await client.query('ROLLBACK');
            continue;
          }
          await client.query(
            `SELECT set_config('marketplace.account_purge_member_id', $1, true)`,
            [memberId],
          );
          await deleteMarketplaceWriteBucketsForMember(client, memberId);

          await client.query(`DELETE FROM marketplace_preset_likes WHERE member_id = $1`, [memberId]);
          await client.query(`DELETE FROM marketplace_collection_likes WHERE member_id = $1`, [memberId]);
          await client.query(
            `DELETE FROM marketplace_preset_likes
             WHERE preset_id IN (SELECT id FROM marketplace_published_presets WHERE creator_id = $1)`,
            [memberId],
          );
          await client.query(
            `DELETE FROM marketplace_collection_likes
             WHERE collection_id IN (SELECT id FROM marketplace_preset_collections WHERE creator_id = $1)`,
            [memberId],
          );
          await rebuildMarketplaceLikeCountsInTransaction(client, now);
          await rebuildMarketplaceTrendingInTransaction(client, {
            now,
            policy: trendingPolicy,
          });
          await client.query(
            `DELETE FROM marketplace_preset_like_count_history
             WHERE preset_id IN (SELECT id FROM marketplace_published_presets WHERE creator_id = $1)`,
            [memberId],
          );
          await client.query(
            `DELETE FROM marketplace_collection_like_count_history
             WHERE collection_id IN (SELECT id FROM marketplace_preset_collections WHERE creator_id = $1)`,
            [memberId],
          );
          await client.query(
            `DELETE FROM marketplace_preset_like_counts
             WHERE preset_id IN (SELECT id FROM marketplace_published_presets WHERE creator_id = $1)`,
            [memberId],
          );
          await client.query(
            `DELETE FROM marketplace_collection_like_counts
             WHERE collection_id IN (SELECT id FROM marketplace_preset_collections WHERE creator_id = $1)`,
            [memberId],
          );

          await client.query(
            `UPDATE marketplace_published_preset_revisions AS revision
             SET rig = '{}'::jsonb, resource_dependencies = '[]'::jsonb,
                 derived_attributes = '{}'::jsonb
             FROM marketplace_published_presets AS preset
             WHERE revision.preset_id = preset.id AND preset.creator_id = $1`,
            [memberId],
          );
          await client.query(
            `DELETE FROM marketplace_published_preset_tags
             WHERE preset_id IN (SELECT id FROM marketplace_published_presets WHERE creator_id = $1)`,
            [memberId],
          );
          await client.query(
            `DELETE FROM marketplace_published_preset_search_projection
             WHERE preset_id IN (SELECT id FROM marketplace_published_presets WHERE creator_id = $1)`,
            [memberId],
          );
          await client.query(
            `UPDATE marketplace_published_presets SET
               title = 'Deleted preset', description = '', visibility = 'withdrawn', updated_at = $2
             WHERE creator_id = $1`,
            [memberId, now],
          );
          await client.query(
            `DELETE FROM marketplace_preset_collection_tags
             WHERE collection_id IN (SELECT id FROM marketplace_preset_collections WHERE creator_id = $1)`,
            [memberId],
          );
          await client.query(
            `DELETE FROM marketplace_preset_collection_items
             WHERE collection_id IN (SELECT id FROM marketplace_preset_collections WHERE creator_id = $1)`,
            [memberId],
          );
          await client.query(
            `UPDATE marketplace_preset_collections SET
               title = 'Deleted collection', description = '', visibility = 'withdrawn', updated_at = $2
             WHERE creator_id = $1`,
            [memberId, now],
          );
          await client.query(
            `UPDATE marketplace_member_handle_claims
             SET handle = 'deleted-claim-' || substr(handle_digest, 1, 32)
             WHERE member_id = $1`,
            [memberId],
          );
          await client.query(
            `UPDATE marketplace_members SET
               handle = 'deleted-' || substr(md5(id || $2::timestamptz::text || random()::text), 1, 20),
               display_name = 'Deleted member', bio = '', avatar_url = NULL,
               handle_changed_at = NULL, account_status = 'tombstoned',
               updated_at = $2::timestamptz
             WHERE id = $1`,
            [memberId, now],
          );
          if (account.email) {
            await client.query(
              `DELETE FROM marketplace_auth_verifications
               WHERE strpos(value, '"email":' || to_json($1::text)::text) > 0`,
              [account.email],
            );
          }
          if (account.auth_user_id) {
            await client.query(`DELETE FROM marketplace_auth_users WHERE id = $1`, [account.auth_user_id]);
          }
          await client.query(
            `DELETE FROM marketplace_account_deletion_requests WHERE member_id = $1`,
            [memberId],
          );
          await client.query('COMMIT');
          purgedMemberIds.push(memberId);
        } catch (cause) {
          await rollback(client);
          throw cause;
        } finally {
          client.release();
        }
      }
      return purgedMemberIds;
    },
  };
}
