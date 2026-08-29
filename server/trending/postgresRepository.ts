import type { Pool, QueryResultRow } from 'pg';
import type {
  MarketplaceLikeTargetKind,
  MarketplaceLikeTargetSummary,
} from '../../shared/marketplace.ts';
import type { PostgresQueryable } from '../marketplace/postgresRepository.ts';
import { MARKETPLACE_LIKE_WRITE_LOCK } from '../likes/postgresLock.ts';
import { decodeTrendingCursor, encodeTrendingCursor } from './cursor.ts';
import type { MarketplaceTrendingPolicy } from './policy.ts';
import { InvalidTrendingCursorError, type MarketplaceTrendingRepository } from './repository.ts';

interface TargetConfig {
  targetTable: string;
  likeTable: string;
  trendingTable: string;
  idColumn: string;
}

const CONFIG: Record<MarketplaceLikeTargetKind, TargetConfig> = {
  preset: {
    targetTable: 'marketplace_published_presets',
    likeTable: 'marketplace_preset_likes',
    trendingTable: 'marketplace_preset_trending_snapshots',
    idColumn: 'preset_id',
  },
  collection: {
    targetTable: 'marketplace_preset_collections',
    likeTable: 'marketplace_collection_likes',
    trendingTable: 'marketplace_collection_trending_snapshots',
    idColumn: 'collection_id',
  },
};

interface TrendingRow extends QueryResultRow {
  id: string;
  title: string;
  creator_id: string;
  creator_handle: string;
  creator_display_name: string;
  like_count: number;
  trend_score: number;
}

function summary(row: TrendingRow): MarketplaceLikeTargetSummary {
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

async function rollback(database: PostgresQueryable): Promise<void> {
  try { await database.query('ROLLBACK'); } catch { /* preserve original error */ }
}

export function createPostgresMarketplaceTrendingRepository(
  pool: Pool,
): MarketplaceTrendingRepository {
  return {
    async list({ kind, limit, cursor }) {
      const config = CONFIG[kind];
      const cursorState = cursor ? decodeTrendingCursor(cursor, kind, limit) : null;
      const versionResult = cursorState
        ? await pool.query<{ rank_version: string } & QueryResultRow>(
          `SELECT rank_version::text FROM marketplace_trending_rebuilds WHERE rank_version = $1`,
          [cursorState.snapshotVersion],
        )
        : await pool.query<{ rank_version: string | null } & QueryResultRow>(
          `SELECT max(rank_version)::text AS rank_version FROM marketplace_trending_rebuilds`,
        );
      const snapshotVersion = Number(versionResult.rows[0]?.rank_version ?? 0);
      if (cursorState && snapshotVersion === 0) throw new InvalidTrendingCursorError();
      if (snapshotVersion === 0) return { items: [], nextCursor: null };
      const values: unknown[] = [snapshotVersion];
      const boundary = cursorState
        ? `AND (ranking.trend_score, target.id) < ($2::double precision, $3)`
        : '';
      if (cursorState) values.push(cursorState.trendScore, cursorState.id);
      values.push(limit + 1);
      const result = await pool.query<TrendingRow>(
        `SELECT target.id, target.title,
           creator.id AS creator_id, creator.handle AS creator_handle,
           creator.display_name AS creator_display_name,
           ranking.valid_like_count AS like_count, ranking.trend_score
         FROM ${config.trendingTable} AS ranking
         JOIN ${config.targetTable} AS target ON target.id = ranking.${config.idColumn}
         JOIN marketplace_members AS creator ON creator.id = target.creator_id
         WHERE ranking.rank_version = $1 AND target.visibility = 'public' ${boundary}
         ORDER BY ranking.trend_score DESC, target.id DESC
         LIMIT $${values.length}`,
        values,
      );
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const last = rows.at(-1);
      return {
        items: rows.map(summary),
        nextCursor: hasMore && last
          ? encodeTrendingCursor(kind, limit, snapshotVersion, {
            trendScore: Number(last.trend_score), id: last.id,
          })
          : null,
      };
    },
    rebuild(input) {
      return rebuildMarketplaceTrending(pool, input);
    },
  };
}

export async function rebuildMarketplaceTrending(
  pool: Pool,
  input: { now: Date; policy: MarketplaceTrendingPolicy },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await rebuildMarketplaceTrendingInTransaction(client, input);
    await client.query('COMMIT');
  } catch (cause) {
    await rollback(client);
    throw cause;
  } finally {
    client.release();
  }
}

export async function rebuildMarketplaceTrendingInTransaction(
  database: PostgresQueryable,
  input: { now: Date; policy: MarketplaceTrendingPolicy },
): Promise<void> {
  await database.query('SELECT pg_advisory_xact_lock($1)', [MARKETPLACE_LIKE_WRITE_LOCK]);
  const version = await database.query<{ rank_version: string } & QueryResultRow>(
    `SELECT nextval('marketplace_trending_rank_version_seq')::text AS rank_version`,
  );
  const rankVersion = version.rows[0].rank_version;
  await database.query(
    `INSERT INTO marketplace_trending_rebuilds
       (rank_version, computed_at, window_hours, half_life_hours)
     VALUES ($1, $2, $3, $4)`,
    [rankVersion, input.now, input.policy.windowHours, input.policy.halfLifeHours],
  );
  for (const kind of ['preset', 'collection'] as const) {
    const config = CONFIG[kind];
    await database.query(
      `WITH scored AS (
         SELECT active.${config.idColumn}, count(*)::integer AS valid_like_count,
           sum(CASE
             WHEN active.created_at >= $2::timestamptz - make_interval(hours => $3)
             THEN power(
               2.0,
               -extract(epoch FROM ($2::timestamptz - active.created_at)) / 3600.0 / $4
             )
             ELSE 0
           END)::double precision AS trend_score
         FROM ${config.likeTable} AS active
         JOIN marketplace_members AS member ON member.id = active.member_id
         WHERE member.community_status = 'active' AND active.created_at <= $2::timestamptz
         GROUP BY active.${config.idColumn}
       )
       INSERT INTO ${config.trendingTable}
         (rank_version, ${config.idColumn}, trend_score, valid_like_count)
       SELECT $1, scored.${config.idColumn}, scored.trend_score, scored.valid_like_count
       FROM scored
       WHERE scored.trend_score > 0`,
      [rankVersion, input.now, input.policy.windowHours, input.policy.halfLifeHours],
    );
  }
}
