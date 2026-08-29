import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { PublishedPresetVisibility } from '../../shared/marketplace.ts';
import { rebuildMarketplaceLikeCountsInTransaction } from '../likes/postgresRepository.ts';
import { MARKETPLACE_LIKE_WRITE_LOCK } from '../likes/postgresLock.ts';
import { rebuildMarketplaceTrendingInTransaction } from '../trending/postgresRepository.ts';
import type { MarketplaceTrendingPolicy } from '../trending/policy.ts';
import {
  lockActiveContentCreator,
  lockCommunityWriteMember,
} from '../members/postgresStanding.ts';
import {
  DuplicateModerationReportError,
  ModerationAppealForbiddenError,
  ModerationTargetNotFoundError,
  ModerationTransitionError,
  MODERATION_ACTION_FAMILIES,
  type AuthorModerationCase,
  type MarketplaceModerationRepository,
  type ModerationTargetKind,
} from './repository.ts';

const TARGET = {
  preset: { table: 'marketplace_published_presets' },
  collection: { table: 'marketplace_preset_collections' },
} as const;

interface VisibilityRow extends QueryResultRow {
  visibility: PublishedPresetVisibility;
  creator_id: string;
}

interface AuthorCaseRow extends QueryResultRow {
  action_id: string;
  target_id: string;
  reason: string;
  created_at: Date | string;
  appeal_id: string | null;
  appeal_status: 'pending' | 'upheld' | 'rejected' | null;
  appeal_statement: string | null;
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function isUniqueViolation(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === '23505';
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
}

async function target(
  database: Pool | PoolClient,
  kind: ModerationTargetKind,
  id: string,
  visibility?: 'accessible' | 'any',
): Promise<VisibilityRow> {
  const result = await database.query<VisibilityRow>(
    `SELECT visibility, creator_id FROM ${TARGET[kind].table}
     WHERE id = $1 ${visibility === 'accessible' ? "AND visibility IN ('public', 'unlisted')" : ''}
     LIMIT 1`,
    [id],
  );
  if (!result.rows[0]) throw new ModerationTargetNotFoundError();
  return result.rows[0];
}

async function recordAction(client: PoolClient, input: {
  id: string;
  actorAuthUserId: string;
  action: string;
  subjectKind: string;
  subjectId: string;
  reason: string;
  previousVisibility?: PublishedPresetVisibility | null;
  now: Date;
}): Promise<void> {
  await client.query(
    `INSERT INTO marketplace_moderation_actions
       (id, actor_auth_user_id, action, subject_kind, subject_id,
        reason, previous_visibility, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.id, input.actorAuthUserId, input.action, input.subjectKind,
      input.subjectId, input.reason, input.previousVisibility ?? null, input.now,
    ],
  );
}

export function createPostgresMarketplaceModerationRepository(
  pool: Pool,
  trendingPolicy: MarketplaceTrendingPolicy,
): MarketplaceModerationRepository {
  return {
    async submitReport(input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await lockCommunityWriteMember(client, input.reporterMemberId);
        await target(client, input.targetKind, input.targetId, 'accessible');
        await client.query(
          `INSERT INTO marketplace_moderation_reports
             (id, reporter_member_id, target_kind, target_id, reason, details, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            input.id, input.reporterMemberId, input.targetKind, input.targetId,
            input.reason, input.details, input.now,
          ],
        );
        await client.query('COMMIT');
      } catch (cause) {
        await rollback(client);
        if (isUniqueViolation(cause)) throw new DuplicateModerationReportError();
        throw cause;
      } finally {
        client.release();
      }
    },

    async submitInfringementNotice(input) {
      await target(pool, input.targetKind, input.targetId, 'any');
      await pool.query(
        `INSERT INTO marketplace_infringement_notices
           (id, claimant_name, claimant_email, target_kind, target_id,
            rights_statement, good_faith, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7)`,
        [
          input.id, input.claimantName, input.claimantEmail, input.targetKind,
          input.targetId, input.rightsStatement, input.now,
        ],
      );
    },

    async listQueue() {
      const result = await pool.query<{
        id: string;
        kind: 'report' | 'notice' | 'appeal';
        target_kind: ModerationTargetKind | null;
        target_id: string | null;
        reason: string | null;
        claimant_name: string | null;
        claimant_email: string | null;
        details: string;
        created_at: Date | string;
        status: 'open' | 'pending';
      } & QueryResultRow>(
        `SELECT id, 'report' AS kind, target_kind, target_id, reason,
           NULL::text AS claimant_name, NULL::text AS claimant_email,
           details, created_at, 'open' AS status
         FROM marketplace_moderation_reports WHERE status = 'open'
         UNION ALL
         SELECT id, 'notice' AS kind, target_kind, target_id, 'copyright' AS reason,
           claimant_name, claimant_email,
           rights_statement AS details, created_at, 'open' AS status
         FROM marketplace_infringement_notices WHERE status = 'open'
         UNION ALL
         SELECT appeal.id, 'appeal' AS kind, action.subject_kind AS target_kind,
           action.subject_id AS target_id, NULL AS reason,
           NULL::text AS claimant_name, NULL::text AS claimant_email,
           appeal.statement AS details, appeal.created_at, 'pending' AS status
         FROM marketplace_moderation_appeals AS appeal
         JOIN marketplace_moderation_actions AS action ON action.id = appeal.action_id
         WHERE appeal.status = 'pending'
         ORDER BY created_at, id`,
      );
      return result.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        ...(row.target_kind ? { targetKind: row.target_kind } : {}),
        ...(row.target_id ? { targetId: row.target_id } : {}),
        ...(row.reason ? { reason: row.reason as import('./repository.ts').ModerationReportReason } : {}),
        ...(row.claimant_name ? { claimantName: row.claimant_name } : {}),
        ...(row.claimant_email ? { claimantEmail: row.claimant_email } : {}),
        details: row.details,
        createdAt: iso(row.created_at),
        status: row.status,
      }));
    },

    async applyAction(input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        let previousVisibility: PublishedPresetVisibility | null = null;
        let standingChanged = false;
        const family = MODERATION_ACTION_FAMILIES[input.action];
        if (family === 'visibility') {
          if (input.subjectKind !== 'preset' && input.subjectKind !== 'collection') {
            throw new ModerationTransitionError();
          }
          const config = TARGET[input.subjectKind];
          if (input.action === 'restore') {
            const creator = await client.query<{ creator_id: string } & QueryResultRow>(
              `SELECT creator_id FROM ${config.table} WHERE id = $1`,
              [input.subjectId],
            );
            if (!creator.rows[0]) throw new ModerationTargetNotFoundError();
            await lockActiveContentCreator(client, creator.rows[0].creator_id);
          }
          const selected = await client.query<VisibilityRow>(
            `SELECT visibility, creator_id FROM ${config.table} WHERE id = $1 FOR UPDATE`,
            [input.subjectId],
          );
          if (!selected.rows[0]) throw new ModerationTargetNotFoundError();
          if (input.action === 'hide') {
            if (selected.rows[0].visibility === 'hidden') throw new ModerationTransitionError();
            previousVisibility = selected.rows[0].visibility;
            await client.query(`UPDATE ${config.table} SET visibility = 'hidden' WHERE id = $1`, [input.subjectId]);
          } else {
            if (selected.rows[0].visibility !== 'hidden') throw new ModerationTransitionError();
            const hidden = await client.query<{ previous_visibility: PublishedPresetVisibility } & QueryResultRow>(
              `SELECT previous_visibility FROM marketplace_moderation_actions
               WHERE action = 'hide' AND subject_kind = $1 AND subject_id = $2
               ORDER BY action_order DESC LIMIT 1`,
              [input.subjectKind, input.subjectId],
            );
            const restoreTo = hidden.rows[0]?.previous_visibility;
            if (!restoreTo || restoreTo === 'hidden') throw new ModerationTransitionError();
            await client.query(`UPDATE ${config.table} SET visibility = $2 WHERE id = $1`, [input.subjectId, restoreTo]);
          }
        } else if (family === 'standing') {
          if (input.subjectKind !== 'member') throw new ModerationTransitionError();
          await client.query('SELECT pg_advisory_xact_lock($1)', [MARKETPLACE_LIKE_WRITE_LOCK]);
          const from = input.action === 'ban' ? 'active' : 'banned';
          const to = input.action === 'ban' ? 'banned' : 'active';
          const updated = await client.query(
            `UPDATE marketplace_members SET community_status = $2
             WHERE id = $1 AND community_status = $3 RETURNING id`,
            [input.subjectId, to, from],
          );
          if (!updated.rowCount) throw new ModerationTransitionError();
          standingChanged = true;
        } else if (family === 'queue') {
          const report = input.action === 'resolve_report';
          if (input.subjectKind !== (report ? 'report' : 'notice')) throw new ModerationTransitionError();
          const table = report ? 'marketplace_moderation_reports' : 'marketplace_infringement_notices';
          const updated = await client.query(
            `UPDATE ${table} SET status = 'resolved', resolved_at = $2
             WHERE id = $1 AND status = 'open' RETURNING id`,
            [input.subjectId, input.now],
          );
          if (!updated.rowCount) throw new ModerationTransitionError();
        } else {
          throw new ModerationTransitionError();
        }
        await recordAction(client, { ...input, previousVisibility });
        if (standingChanged) {
          await rebuildMarketplaceLikeCountsInTransaction(client, input.now);
          await rebuildMarketplaceTrendingInTransaction(client, {
            now: input.now,
            policy: trendingPolicy,
          });
        }
        await client.query('COMMIT');
      } catch (cause) {
        await rollback(client);
        throw cause;
      } finally {
        client.release();
      }
    },

    async listAuthorCases(authorMemberId) {
      const cases: AuthorModerationCase[] = [];
      for (const kind of ['preset', 'collection'] as const) {
        const result = await pool.query<AuthorCaseRow>(
          `SELECT action.id AS action_id, action.subject_id AS target_id,
             action.reason, action.created_at,
             appeal.id AS appeal_id, appeal.status AS appeal_status,
             appeal.statement AS appeal_statement
           FROM marketplace_moderation_actions AS action
           JOIN ${TARGET[kind].table} AS target ON target.id = action.subject_id
           LEFT JOIN marketplace_moderation_appeals AS appeal ON appeal.action_id = action.id
           WHERE action.action = 'hide' AND action.subject_kind = $1
             AND target.creator_id = $2
           ORDER BY action.action_order DESC`,
          [kind, authorMemberId],
        );
        cases.push(...result.rows.map((row) => ({
          actionId: row.action_id,
          targetKind: kind,
          targetId: row.target_id,
          action: 'hide' as const,
          reason: row.reason,
          createdAt: iso(row.created_at),
          appeal: row.appeal_id ? {
            id: row.appeal_id,
            status: row.appeal_status!,
            statement: row.appeal_statement!,
          } : null,
        })));
      }
      return cases.sort((left, right) => (
        right.createdAt.localeCompare(left.createdAt) || right.actionId.localeCompare(left.actionId)
      ));
    },

    async submitAppeal(input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await lockCommunityWriteMember(client, input.authorMemberId);
        const action = await client.query<{
          subject_kind: ModerationTargetKind;
          subject_id: string;
        } & QueryResultRow>(
          `SELECT subject_kind, subject_id FROM marketplace_moderation_actions
           WHERE id = $1 AND action = 'hide' LIMIT 1`,
          [input.actionId],
        );
        const row = action.rows[0];
        if (!row || (row.subject_kind !== 'preset' && row.subject_kind !== 'collection')) {
          throw new ModerationAppealForbiddenError();
        }
        const owned = await client.query(
          `SELECT 1 FROM ${TARGET[row.subject_kind].table}
           WHERE id = $1 AND creator_id = $2`,
          [row.subject_id, input.authorMemberId],
        );
        if (!owned.rowCount) throw new ModerationAppealForbiddenError();
        await client.query(
          `INSERT INTO marketplace_moderation_appeals
             (id, action_id, author_member_id, statement, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [input.id, input.actionId, input.authorMemberId, input.statement, input.now],
        );
        await client.query('COMMIT');
      } catch (cause) {
        await rollback(client);
        if (isUniqueViolation(cause)) throw new ModerationTransitionError();
        throw cause;
      } finally {
        client.release();
      }
    },

    async resolveAppeal(input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const selected = await client.query<{
          action_id: string;
          subject_kind: ModerationTargetKind;
          subject_id: string;
          previous_visibility: PublishedPresetVisibility;
        } & QueryResultRow>(
          `SELECT appeal.action_id, action.subject_kind, action.subject_id,
             action.previous_visibility
           FROM marketplace_moderation_appeals AS appeal
           JOIN marketplace_moderation_actions AS action ON action.id = appeal.action_id
           WHERE appeal.id = $1 AND appeal.status = 'pending'
           FOR UPDATE OF appeal`,
          [input.appealId],
        );
        const appeal = selected.rows[0];
        if (!appeal) throw new ModerationTransitionError();
        const targetTable = TARGET[appeal.subject_kind].table;
        if (input.outcome === 'upheld') {
          const creator = await client.query<{ creator_id: string } & QueryResultRow>(
            `SELECT creator_id FROM ${targetTable} WHERE id = $1`,
            [appeal.subject_id],
          );
          if (!creator.rows[0]) throw new ModerationTransitionError();
          await lockActiveContentCreator(client, creator.rows[0].creator_id);
        }
        const lockedTarget = await client.query<{ visibility: PublishedPresetVisibility } & QueryResultRow>(
          `SELECT visibility FROM ${targetTable} WHERE id = $1 FOR UPDATE`,
          [appeal.subject_id],
        );
        if (!lockedTarget.rows[0]) throw new ModerationTransitionError();
        const effective = await client.query<{ id: string } & QueryResultRow>(
          `SELECT id FROM marketplace_moderation_actions
           WHERE subject_kind = $1 AND subject_id = $2
             AND action IN ('hide', 'restore')
           ORDER BY action_order DESC LIMIT 1`,
          [appeal.subject_kind, appeal.subject_id],
        );
        if (input.outcome === 'upheld'
          && effective.rows[0]?.id === appeal.action_id
          && lockedTarget.rows[0].visibility === 'hidden') {
          await client.query(
            `UPDATE ${targetTable} SET visibility = $2 WHERE id = $1`,
            [appeal.subject_id, appeal.previous_visibility],
          );
        }
        await recordAction(client, {
          id: input.id,
          actorAuthUserId: input.actorAuthUserId,
          action: input.outcome === 'upheld' ? 'uphold_appeal' : 'reject_appeal',
          subjectKind: 'appeal',
          subjectId: input.appealId,
          reason: input.reason,
          now: input.now,
        });
        await client.query(
          `UPDATE marketplace_moderation_appeals
           SET status = $2, resolved_at = $3, resolution_action_id = $4
           WHERE id = $1`,
          [input.appealId, input.outcome, input.now, input.id],
        );
        await client.query('COMMIT');
      } catch (cause) {
        await rollback(client);
        throw cause;
      } finally {
        client.release();
      }
    },

    async listAudit() {
      const result = await pool.query<{
        id: string;
        actor_auth_user_id: string;
        action: string;
        subject_kind: string;
        subject_id: string;
        reason: string;
        created_at: Date | string;
      } & QueryResultRow>(
        `SELECT id, actor_auth_user_id, action, subject_kind, subject_id, reason, created_at
         FROM marketplace_moderation_actions ORDER BY action_order DESC`,
      );
      return result.rows.map((row) => ({
        id: row.id,
        actorAuthUserId: row.actor_auth_user_id,
        action: row.action,
        subjectKind: row.subject_kind,
        subjectId: row.subject_id,
        reason: row.reason,
        createdAt: iso(row.created_at),
      }));
    },
  };
}
