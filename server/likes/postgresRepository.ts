import type { Pool, QueryResultRow } from 'pg';
import type {
  MarketplaceLikeState,
  MarketplaceLikeTargetKind,
  MarketplaceLikedTargetSummary,
  MarketplaceLikeTargetSummary,
} from '../../shared/marketplace.ts';
import type { PostgresQueryable } from '../marketplace/postgresRepository.ts';
import { decodePopularCursor, encodePopularCursor } from './cursor.ts';
import {
  InvalidPopularCursorError,
  LikeTargetNotFoundError,
  SelfLikeForbiddenError,
  type MarketplaceLikeRepository,
} from './repository.ts';
import { MARKETPLACE_LIKE_WRITE_LOCK } from './postgresLock.ts';

interface TargetConfig {
  targetTable: string;
  likeTable: string;
  countTable: string;
  historyTable: string;
  idColumn: string;
}

const CONFIG: Record<MarketplaceLikeTargetKind, TargetConfig> = {
  preset: {
    targetTable: 'marketplace_published_presets',
    likeTable: 'marketplace_preset_likes', countTable: 'marketplace_preset_like_counts',
    historyTable: 'marketplace_preset_like_count_history',
    idColumn: 'preset_id',
  },
  collection: {
    targetTable: 'marketplace_preset_collections',
    likeTable: 'marketplace_collection_likes', countTable: 'marketplace_collection_like_counts',
    historyTable: 'marketplace_collection_like_count_history',
    idColumn: 'collection_id',
  },
};

interface StateRow extends QueryResultRow {
  creator_id: string;
  liked: boolean;
  like_count: number;
}

interface SummaryRow extends QueryResultRow {
  id: string;
  title: string;
  creator_id: string;
  creator_handle: string;
  creator_display_name: string;
  like_count: number;
  liked_at?: Date | string;
}

function summary(row: SummaryRow): MarketplaceLikeTargetSummary {
  return {
    id: row.id,
    title: row.title,
    creator: {
      id: row.creator_id,
      handle: row.creator_handle,
      displayName: row.creator_display_name,
    },
    likeCount: Number(row.like_count),
  };
}

async function state(
  database: PostgresQueryable,
  kind: MarketplaceLikeTargetKind,
  targetId: string,
  memberId: string | null,
): Promise<MarketplaceLikeState> {
  const config = CONFIG[kind];
  const result = await database.query<StateRow>(
    `SELECT target.creator_id,
       EXISTS (
         SELECT 1 FROM ${config.likeTable} AS own_like
         WHERE own_like.${config.idColumn} = target.id AND own_like.member_id = $2
       ) AS liked,
       COALESCE(counts.like_count, 0) AS like_count
     FROM ${config.targetTable} AS target
     LEFT JOIN ${config.countTable} AS counts ON counts.${config.idColumn} = target.id
     WHERE target.id = $1 AND target.visibility IN ('public', 'unlisted')
     LIMIT 1`,
    [targetId, memberId],
  );
  const row = result.rows[0];
  if (!row) throw new LikeTargetNotFoundError();
  return {
    liked: memberId ? row.liked : false,
    canLike: Boolean(memberId && memberId !== row.creator_id),
    likeCount: Number(row.like_count),
  };
}

async function rollback(database: PostgresQueryable): Promise<void> {
  try { await database.query('ROLLBACK'); } catch { /* preserve original error */ }
}

async function currentRankVersion(database: PostgresQueryable): Promise<number> {
  const result = await database.query<{ rank_version: string } & QueryResultRow>(
    `SELECT GREATEST(
       COALESCE((SELECT max(rank_version) FROM marketplace_preset_like_count_history), 0),
       COALESCE((SELECT max(rank_version) FROM marketplace_collection_like_count_history), 0)
     )::text AS rank_version`,
  );
  return Number(result.rows[0]?.rank_version ?? 0);
}

async function recordCountHistory(
  database: PostgresQueryable,
  config: TargetConfig,
  targetId: string,
  now: Date,
): Promise<void> {
  const version = await database.query<{ rank_version: string } & QueryResultRow>(
    `SELECT nextval('marketplace_like_rank_version_seq')::text AS rank_version`,
  );
  await database.query(
    `INSERT INTO ${config.historyTable}
       (${config.idColumn}, rank_version, like_count, computed_at)
     SELECT $1, $2, COALESCE(counts.like_count, 0), $3
     FROM (SELECT 1) AS singleton
     LEFT JOIN ${config.countTable} AS counts ON counts.${config.idColumn} = $1`,
    [targetId, version.rows[0].rank_version, now],
  );
}

async function listMineKind(
  database: PostgresQueryable,
  kind: MarketplaceLikeTargetKind,
  memberId: string,
): Promise<MarketplaceLikedTargetSummary[]> {
  const config = CONFIG[kind];
  const result = await database.query<SummaryRow>(
    `SELECT target.id, target.title,
       creator.id AS creator_id, creator.handle AS creator_handle,
       creator.display_name AS creator_display_name,
       COALESCE(counts.like_count, 0) AS like_count,
       own_like.created_at AS liked_at
     FROM ${config.likeTable} AS own_like
     JOIN ${config.targetTable} AS target ON target.id = own_like.${config.idColumn}
     JOIN marketplace_members AS creator ON creator.id = target.creator_id
     LEFT JOIN ${config.countTable} AS counts ON counts.${config.idColumn} = target.id
     WHERE own_like.member_id = $1 AND target.visibility IN ('public', 'unlisted')
     ORDER BY own_like.created_at DESC, target.id DESC`,
    [memberId],
  );
  return result.rows.map((row) => ({
    ...summary(row),
    likedAt: row.liked_at instanceof Date
      ? row.liked_at.toISOString()
      : new Date(row.liked_at!).toISOString(),
  }));
}

export function createPostgresMarketplaceLikeRepository(pool: Pool): MarketplaceLikeRepository {
  return {
    getState(kind, targetId, memberId) {
      return state(pool, kind, targetId, memberId);
    },
    async setLiked({ kind, targetId, memberId, liked, now }) {
      const config = CONFIG[kind];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [MARKETPLACE_LIKE_WRITE_LOCK]);
        const target = await client.query<{ creator_id: string } & QueryResultRow>(
          `SELECT creator_id FROM ${config.targetTable}
           WHERE id = $1 AND visibility IN ('public', 'unlisted') FOR SHARE`,
          [targetId],
        );
        if (!target.rows[0]) throw new LikeTargetNotFoundError();
        if (target.rows[0].creator_id === memberId) throw new SelfLikeForbiddenError();
        let changed = false;
        if (liked) {
          const inserted = await client.query(
            `INSERT INTO ${config.likeTable} (member_id, ${config.idColumn}, created_at)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING 1`,
            [memberId, targetId, now],
          );
          if (inserted.rowCount) {
            changed = true;
            await client.query(
              `INSERT INTO ${config.countTable} (${config.idColumn}, like_count, computed_at)
               VALUES ($1, 1, $2)
               ON CONFLICT (${config.idColumn}) DO UPDATE SET
                 like_count = ${config.countTable}.like_count + 1,
                 computed_at = EXCLUDED.computed_at`,
              [targetId, now],
            );
          }
        } else {
          const deleted = await client.query(
            `DELETE FROM ${config.likeTable}
             WHERE member_id = $1 AND ${config.idColumn} = $2 RETURNING 1`,
            [memberId, targetId],
          );
          if (deleted.rowCount) {
            changed = true;
            await client.query(
              `UPDATE ${config.countTable}
               SET like_count = GREATEST(0, like_count - 1), computed_at = $2
               WHERE ${config.idColumn} = $1`,
              [targetId, now],
            );
          }
        }
        if (changed) await recordCountHistory(client, config, targetId, now);
        const updated = await state(client, kind, targetId, memberId);
        await client.query('COMMIT');
        return updated;
      } catch (cause) {
        await rollback(client);
        throw cause;
      } finally {
        client.release();
      }
    },
    async listMine(memberId) {
      const [presets, collections] = await Promise.all([
        listMineKind(pool, 'preset', memberId),
        listMineKind(pool, 'collection', memberId),
      ]);
      return { presets, collections };
    },
    async listPopular({ kind, limit, cursor }) {
      const config = CONFIG[kind];
      const cursorState = cursor ? decodePopularCursor(cursor, kind, limit) : null;
      const latestVersion = await currentRankVersion(pool);
      if (cursorState && cursorState.snapshotVersion > latestVersion) {
        throw new InvalidPopularCursorError();
      }
      const snapshotVersion = cursorState?.snapshotVersion ?? latestVersion;
      const values: unknown[] = [snapshotVersion];
      const boundary = cursorState
        ? `AND (counts.like_count, target.id) < ($2::integer, $3)`
        : '';
      if (cursorState) values.push(cursorState.likeCount, cursorState.id);
      values.push(limit + 1);
      const result = await pool.query<SummaryRow>(
        `WITH counts AS (
           SELECT DISTINCT ON (${config.idColumn}) ${config.idColumn}, like_count
           FROM ${config.historyTable}
           WHERE rank_version <= $1
           ORDER BY ${config.idColumn}, rank_version DESC
         )
         SELECT target.id, target.title,
           creator.id AS creator_id, creator.handle AS creator_handle,
           creator.display_name AS creator_display_name, counts.like_count
         FROM counts
         JOIN ${config.targetTable} AS target ON target.id = counts.${config.idColumn}
         JOIN marketplace_members AS creator ON creator.id = target.creator_id
         WHERE target.visibility = 'public' AND counts.like_count > 0 ${boundary}
         ORDER BY counts.like_count DESC, target.id DESC
         LIMIT $${values.length}`,
        values,
      );
      const hasMore = result.rows.length > limit;
      const items = result.rows.slice(0, limit).map(summary);
      const last = items.at(-1);
      return {
        items,
        nextCursor: hasMore && last
          ? encodePopularCursor(kind, limit, snapshotVersion, last)
          : null,
      };
    },
  };
}

export async function rebuildMarketplaceLikeCounts(pool: Pool, now: Date): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [MARKETPLACE_LIKE_WRITE_LOCK]);
    for (const kind of ['preset', 'collection'] as const) {
      const config = CONFIG[kind];
      await client.query(
        `INSERT INTO ${config.countTable} (${config.idColumn}, like_count, computed_at)
         SELECT ${config.idColumn}, count(*)::integer, $1
         FROM ${config.likeTable} GROUP BY ${config.idColumn}
         ON CONFLICT (${config.idColumn}) DO UPDATE SET
           like_count = EXCLUDED.like_count, computed_at = EXCLUDED.computed_at`,
        [now],
      );
      await client.query(
        `DELETE FROM ${config.countTable} AS counts
         WHERE NOT EXISTS (
           SELECT 1 FROM ${config.likeTable} AS active
           WHERE active.${config.idColumn} = counts.${config.idColumn}
         )`,
      );
    }
    const version = await client.query<{ rank_version: string } & QueryResultRow>(
      `SELECT nextval('marketplace_like_rank_version_seq')::text AS rank_version`,
    );
    for (const kind of ['preset', 'collection'] as const) {
      const config = CONFIG[kind];
      await client.query(
        `INSERT INTO ${config.historyTable}
           (${config.idColumn}, rank_version, like_count, computed_at)
         SELECT target.id, $1, COALESCE(counts.like_count, 0), $2
         FROM ${config.targetTable} AS target
         LEFT JOIN ${config.countTable} AS counts ON counts.${config.idColumn} = target.id`,
        [version.rows[0].rank_version, now],
      );
    }
    await client.query('COMMIT');
  } catch (cause) {
    await rollback(client);
    throw cause;
  } finally {
    client.release();
  }
}
