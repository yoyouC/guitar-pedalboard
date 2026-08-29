import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type {
  MarketplaceTag,
  PublishedPreset,
  PublishedPresetVisibility,
  RigDerivedAttributes,
  RigResourceDependency,
} from '../../shared/marketplace.ts';
import type { RigPresetState } from '../../src/state/presetCodec.ts';
import type {
  CreatePublishedPresetInput,
  PublishedPresetPublicationRepository,
  PublishedPresetRepository,
} from './repository.ts';
import { UnavailableTagError } from './repository.ts';

export interface PostgresQueryable {
  query<R extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<R>>;
}

interface PublishedPresetRow extends QueryResultRow {
  preset_id: string;
  title: string;
  description: string;
  visibility: PublishedPresetVisibility;
  creator_id: string;
  creator_handle: string;
  creator_display_name: string;
  tags: MarketplaceTag[];
  pedal_ids: string[];
  amp_id: string;
  amp_model_key: string;
  cab_id: string;
  resource_kinds: RigDerivedAttributes['resourceKinds'];
  revision_id: string;
  schema_version: number;
  resource_dependencies: RigResourceDependency[];
  rig: RigPresetState;
  revision_created_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function publishedPresetFromRow(row: PublishedPresetRow): PublishedPreset {
  return {
    id: row.preset_id,
    title: row.title,
    description: row.description,
    visibility: row.visibility,
    creator: {
      id: row.creator_id,
      handle: row.creator_handle,
      displayName: row.creator_display_name,
    },
    tags: row.tags,
    derivedAttributes: {
      pedalIds: row.pedal_ids,
      ampId: row.amp_id,
      ampModelKey: row.amp_model_key,
      cabId: row.cab_id,
      resourceKinds: row.resource_kinds,
    },
    currentRevision: {
      id: row.revision_id,
      schemaVersion: row.schema_version,
      resourceDependencies: row.resource_dependencies,
      rig: row.rig,
      createdAt: isoTimestamp(row.revision_created_at),
    },
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

export function createPostgresPublishedPresetRepository(
  database: PostgresQueryable,
): PublishedPresetRepository {
  return {
    async findPublicById(id) {
      const result = await database.query<PublishedPresetRow>(
        `SELECT
           preset.id AS preset_id,
           preset.title,
           preset.description,
           preset.visibility,
           creator.id AS creator_id,
           creator.handle AS creator_handle,
           creator.display_name AS creator_display_name,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'id', tag.id,
               'dimension', tag.dimension,
               'nameZh', tag.name_zh,
               'nameEn', tag.name_en
             ) ORDER BY tag.id)
             FROM marketplace_published_preset_tags AS preset_tag
             JOIN marketplace_tags AS tag ON tag.id = preset_tag.tag_id
             WHERE preset_tag.preset_id = preset.id
           ), '[]'::jsonb) AS tags,
           projection.pedal_ids,
           projection.amp_id,
           projection.amp_model_key,
           projection.cab_id,
           projection.resource_kinds,
           revision.id AS revision_id,
           revision.schema_version,
           revision.resource_dependencies,
           revision.rig,
           revision.created_at AS revision_created_at,
           preset.created_at,
           preset.updated_at
         FROM marketplace_published_presets AS preset
         JOIN marketplace_members AS creator ON creator.id = preset.creator_id
         JOIN marketplace_published_preset_revisions AS revision
           ON revision.id = preset.current_revision_id
         JOIN marketplace_published_preset_search_projection AS projection
           ON projection.preset_id = preset.id
         WHERE preset.id = $1 AND preset.visibility = 'public'
         LIMIT 1`,
        [id],
      );
      return result.rows[0] ? publishedPresetFromRow(result.rows[0]) : null;
    },
  };
}

interface TagRow extends QueryResultRow {
  id: string;
  dimension: string;
  name_zh: string;
  name_en: string;
}

function tagFromRow(row: TagRow): MarketplaceTag {
  return {
    id: row.id,
    dimension: row.dimension,
    nameZh: row.name_zh,
    nameEn: row.name_en,
  };
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
}

export function createPostgresPublishedPresetPublicationRepository(
  pool: Pool,
): PublishedPresetPublicationRepository {
  return {
    async listAvailableTags() {
      const result = await pool.query<TagRow>(
        `SELECT id, dimension, name_zh, name_en
         FROM marketplace_tags
         WHERE status = 'active'
         ORDER BY dimension, id`,
      );
      return result.rows.map(tagFromRow);
    },

    async create(input: CreatePublishedPresetInput) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const selected = await client.query<TagRow>(
          `SELECT id, dimension, name_zh, name_en
           FROM marketplace_tags
           WHERE status = 'active' AND id = ANY($1::text[])
           ORDER BY array_position($1::text[], id)
           FOR SHARE`,
          [input.tagIds],
        );
        if (selected.rows.length !== input.tagIds.length) throw new UnavailableTagError();

        await client.query(
          `INSERT INTO marketplace_published_presets
             (id, creator_id, title, description, visibility, current_revision_id,
              created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'public', $5, $6, $6)`,
          [
            input.id,
            input.creator.id,
            input.title,
            input.description,
            input.revisionId,
            input.now,
          ],
        );
        await client.query(
          `INSERT INTO marketplace_published_preset_revisions
             (id, preset_id, schema_version, resource_dependencies, rig, created_at)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
          [
            input.revisionId,
            input.id,
            input.schemaVersion,
            JSON.stringify(input.resourceDependencies),
            JSON.stringify(input.rig),
            input.now,
          ],
        );
        await client.query(
          `INSERT INTO marketplace_published_preset_tags (preset_id, tag_id)
           SELECT $1, unnest($2::text[])`,
          [input.id, input.tagIds],
        );
        await client.query(
          `INSERT INTO marketplace_published_preset_search_projection
             (preset_id, pedal_ids, amp_id, amp_model_key, cab_id, resource_kinds, projected_at)
           VALUES ($1, $2::text[], $3, $4, $5, $6::text[], $7)`,
          [
            input.id,
            input.derivedAttributes.pedalIds,
            input.derivedAttributes.ampId,
            input.derivedAttributes.ampModelKey,
            input.derivedAttributes.cabId,
            input.derivedAttributes.resourceKinds,
            input.now,
          ],
        );
        await client.query('COMMIT');

        const createdAt = input.now.toISOString();
        return {
          id: input.id,
          title: input.title,
          description: input.description,
          visibility: 'public',
          creator: input.creator,
          tags: selected.rows.map(tagFromRow),
          derivedAttributes: input.derivedAttributes,
          currentRevision: {
            id: input.revisionId,
            schemaVersion: input.schemaVersion,
            resourceDependencies: input.resourceDependencies,
            rig: input.rig,
            createdAt,
          },
          createdAt,
          updatedAt: createdAt,
        };
      } catch (cause) {
        await rollback(client);
        throw cause;
      } finally {
        client.release();
      }
    },
  };
}
