import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type {
  ManagedMarketplaceTag,
  MarketplaceTagAdministrationRepository,
  MarketplaceTagAuditEntry,
  MarketplaceTagCommand,
  MarketplaceTagStatus,
} from './repository.ts';
import { MarketplaceTagConflictError, MarketplaceTagNotFoundError } from './repository.ts';
import type { PostgresQueryable } from '../marketplace/postgresRepository.ts';

interface TagRow extends QueryResultRow {
  id: string;
  dimension: string;
  name_zh: string;
  name_en: string;
  aliases: string[];
  status: MarketplaceTagStatus;
  merged_into_id: string | null;
  preset_count: string | number;
  collection_count: string | number;
}

interface LockedTagRow extends QueryResultRow {
  id: string;
  dimension: string;
  name_zh: string;
  name_en: string;
  aliases: string[];
  status: MarketplaceTagStatus;
  merged_into_id: string | null;
}

interface AuditRow extends QueryResultRow {
  id: string;
  actor_auth_user_id: string;
  action: MarketplaceTagAuditEntry['action'];
  tag_id: string;
  target_tag_id: string | null;
  reason: string;
  created_at: Date | string;
}

const tagFromRow = (row: TagRow): ManagedMarketplaceTag => ({
  id: row.id, dimension: row.dimension, nameZh: row.name_zh, nameEn: row.name_en,
  aliases: row.aliases, status: row.status, mergedIntoId: row.merged_into_id,
  presetCount: Number(row.preset_count), collectionCount: Number(row.collection_count),
});

async function listTags(database: PostgresQueryable, id?: string): Promise<ManagedMarketplaceTag[]> {
  const result = await database.query<TagRow>(
    `SELECT tag.id, tag.dimension, tag.name_zh, tag.name_en, tag.aliases,
            tag.status, tag.merged_into_id,
            count(DISTINCT preset_tag.preset_id) AS preset_count,
            count(DISTINCT collection_tag.collection_id) AS collection_count
     FROM marketplace_tags AS tag
     LEFT JOIN marketplace_published_preset_tags AS preset_tag ON preset_tag.tag_id = tag.id
     LEFT JOIN marketplace_preset_collection_tags AS collection_tag ON collection_tag.tag_id = tag.id
     ${id ? 'WHERE tag.id = $1' : ''}
     GROUP BY tag.id
     ORDER BY tag.dimension, tag.id`,
    id ? [id] : [],
  );
  return result.rows.map(tagFromRow);
}

function uniqueAliases(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.normalize('NFKC').toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function audit(client: PostgresQueryable, command: MarketplaceTagCommand, tagId: string, targetTagId: string | null) {
  const action = `${command.action}_tag`;
  await client.query(
    `INSERT INTO marketplace_tag_administration_audit
       (id, actor_auth_user_id, action, tag_id, target_tag_id, reason, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [command.auditId, command.actorAuthUserId, action, tagId, targetTagId, command.reason, command.now],
  );
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
}

export function createPostgresMarketplaceTagAdministrationRepository(
  pool: Pool,
): MarketplaceTagAdministrationRepository {
  return {
    list: () => listTags(pool),
    async apply(command) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('marketplace_tag_administration'))`);
        if (command.action === 'create') {
          const inserted = await client.query(
            `INSERT INTO marketplace_tags
               (id, dimension, name_zh, name_en, aliases, status, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, 'active', $6, $6)
             ON CONFLICT (id) DO NOTHING RETURNING id`,
            [command.tag.id, command.tag.dimension, command.tag.nameZh, command.tag.nameEn,
              JSON.stringify(command.tag.aliases), command.now],
          );
          if (inserted.rows.length === 0) throw new MarketplaceTagConflictError();
          await audit(client, command, command.tag.id, null);
          await client.query('COMMIT');
          return (await listTags(pool, command.tag.id))[0];
        }

        if (command.action === 'merge') {
          const locked = await client.query<LockedTagRow>(
            `SELECT id, dimension, name_zh, name_en, aliases, status, merged_into_id
             FROM marketplace_tags WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`,
            [[command.tagId, command.targetId]],
          );
          const source = locked.rows.find((row) => row.id === command.tagId);
          const target = locked.rows.find((row) => row.id === command.targetId);
          if (!source || !target) throw new MarketplaceTagNotFoundError();
          if (source.status === 'merged') {
            if (source.merged_into_id !== target.id) throw new MarketplaceTagConflictError();
            await client.query('COMMIT');
            return (await listTags(pool, source.id))[0];
          }
          if (source.id === target.id || target.status !== 'active') throw new MarketplaceTagConflictError();
          const aliases = uniqueAliases([
            ...target.aliases, ...source.aliases, source.name_zh, source.name_en, source.id,
          ]);
          await client.query(
            `INSERT INTO marketplace_published_preset_tags (preset_id, tag_id)
             SELECT preset_id, $2 FROM marketplace_published_preset_tags WHERE tag_id = $1
             ON CONFLICT DO NOTHING`,
            [source.id, target.id],
          );
          await client.query(
            `INSERT INTO marketplace_preset_collection_tags (collection_id, tag_id)
             SELECT collection_id, $2 FROM marketplace_preset_collection_tags WHERE tag_id = $1
             ON CONFLICT DO NOTHING`,
            [source.id, target.id],
          );
          await client.query('DELETE FROM marketplace_published_preset_tags WHERE tag_id = $1', [source.id]);
          await client.query('DELETE FROM marketplace_preset_collection_tags WHERE tag_id = $1', [source.id]);
          await client.query(
            `UPDATE marketplace_tags SET aliases = $2::jsonb, updated_at = $3 WHERE id = $1`,
            [target.id, JSON.stringify(aliases), command.now],
          );
          await client.query(
            `UPDATE marketplace_tags
             SET merged_into_id = $2, updated_at = $3 WHERE merged_into_id = $1`,
            [source.id, target.id, command.now],
          );
          await client.query(
            `UPDATE marketplace_tags
             SET status = 'merged', merged_into_id = $2, updated_at = $3 WHERE id = $1`,
            [source.id, target.id, command.now],
          );
          await audit(client, command, source.id, target.id);
          await client.query('COMMIT');
          return (await listTags(pool, source.id))[0];
        }

        const locked = await client.query<LockedTagRow>(
          `SELECT id, dimension, name_zh, name_en, aliases, status, merged_into_id
           FROM marketplace_tags WHERE id = $1 FOR UPDATE`,
          [command.tagId],
        );
        const current = locked.rows[0];
        if (!current) throw new MarketplaceTagNotFoundError();
        if (current.status === 'merged') throw new MarketplaceTagConflictError();
        if (command.action === 'edit') {
          await client.query(
            `UPDATE marketplace_tags
             SET dimension = $2, name_zh = $3, name_en = $4, aliases = $5::jsonb, updated_at = $6
             WHERE id = $1`,
            [command.tagId, command.tag.dimension, command.tag.nameZh, command.tag.nameEn,
              JSON.stringify(command.tag.aliases), command.now],
          );
        } else {
          await client.query(
            `UPDATE marketplace_tags SET status = 'deprecated', updated_at = $2 WHERE id = $1`,
            [command.tagId, command.now],
          );
        }
        await audit(client, command, command.tagId, null);
        await client.query('COMMIT');
        return (await listTags(pool, command.tagId))[0];
      } catch (cause) {
        await rollback(client);
        throw cause;
      } finally {
        client.release();
      }
    },
    async listAudit() {
      const result = await pool.query<AuditRow>(
        `SELECT id, actor_auth_user_id, action, tag_id, target_tag_id, reason, created_at
         FROM marketplace_tag_administration_audit ORDER BY created_at, id`,
      );
      return result.rows.map((row) => ({
        id: row.id, actorAuthUserId: row.actor_auth_user_id, action: row.action,
        tagId: row.tag_id, targetTagId: row.target_tag_id, reason: row.reason,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
      }));
    },
  };
}
