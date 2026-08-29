import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type {
  MarketplaceTag,
  PublishedPreset,
  PublishedPresetConcurrencyState,
  PublishedPresetRevision,
  PublishedPresetRevisionSummary,
  PublishedPresetRevisionView,
  PublishedPresetSource,
  PublishedPresetVisibility,
  RigDerivedAttributes,
  RigResourceDependency,
} from '../../shared/marketplace.ts';
import type { RigPresetState } from '../../src/state/presetCodec.ts';
import { RIG_PRESET_VERSION } from '../../src/state/presetCodec.ts';
import type {
  AppendPublishedPresetRevisionInput,
  CreatePublishedPresetInput,
  PublishedPresetManagementRepository,
  PublishedPresetPublicationRepository,
  PublishedPresetRepository,
  RestorePublishedPresetRevisionInput,
  UpdatePublishedPresetMetadataInput,
  UpdatePublishedPresetVisibilityInput,
} from './repository.ts';
import {
  PublishedPresetAccessError,
  PublishedPresetConflictError,
  PublishedPresetRevisionNotFoundError,
  PublishedPresetSourceError,
  UnavailableTagError,
} from './repository.ts';
import { isValidStoredPublishedPresetRevision } from '../../shared/marketplaceValidation.ts';
import { lockCommunityWriteMember } from '../members/postgresStanding.ts';

export interface PostgresQueryable {
  query<R extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<R>>;
}

interface PublishedPresetSourceRowFields {
  source_preset_id: string | null;
  source_revision_id: string | null;
  source_title: string | null;
  source_visibility: PublishedPresetVisibility | null;
  source_creator_id: string | null;
  source_creator_handle: string | null;
  source_creator_display_name: string | null;
}

interface PublishedPresetRow extends QueryResultRow, PublishedPresetSourceRowFields {
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
  revision_derived_attributes: RigDerivedAttributes;
  rig: unknown;
  revision_created_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function revisionFromStorage(row: {
  revision_id: string;
  schema_version: number;
  resource_dependencies: RigResourceDependency[];
  revision_derived_attributes: RigDerivedAttributes;
  rig: unknown;
  revision_created_at: Date | string;
}): PublishedPresetRevision {
  const stored = {
    id: row.revision_id,
    schemaVersion: row.schema_version,
    resourceDependencies: row.resource_dependencies,
    derivedAttributes: row.revision_derived_attributes,
    rig: row.rig,
    createdAt: isoTimestamp(row.revision_created_at),
  };
  return row.schema_version === RIG_PRESET_VERSION
    ? {
        ...stored,
        payloadKind: 'canonical-rig',
        schemaVersion: RIG_PRESET_VERSION,
        rig: row.rig as RigPresetState,
      }
    : { ...stored, payloadKind: 'opaque' };
}

function publishedPresetFromRow(row: PublishedPresetRow): PublishedPreset {
  const source = sourceFromRow(row);
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
    currentRevision: revisionFromStorage(row),
    ...(source ? { source } : {}),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

function sourceFromRow(row: PublishedPresetSourceRowFields): PublishedPresetSource | null {
  if (!row.source_preset_id) return null;
  if (
    !row.source_revision_id
    || !row.source_creator_id
    || row.source_creator_handle === null
    || row.source_creator_display_name === null
  ) throw new PublishedPresetSourceError();
  const available = row.source_visibility === 'public' || row.source_visibility === 'unlisted';
  return {
    presetId: row.source_preset_id,
    revisionId: row.source_revision_id,
    creator: {
      id: row.source_creator_id,
      handle: row.source_creator_handle,
      displayName: row.source_creator_display_name,
    },
    availability: available ? 'available' : 'unavailable',
    title: available ? row.source_title : null,
  };
}

interface PublishedPresetRevisionViewRow extends QueryResultRow, PublishedPresetSourceRowFields {
  preset_id: string;
  title: string;
  description: string;
  visibility: 'public' | 'unlisted';
  creator_id: string;
  creator_handle: string;
  creator_display_name: string;
  tags: MarketplaceTag[];
  current_revision_id: string;
  revision_id: string;
  schema_version: number;
  resource_dependencies: RigResourceDependency[];
  revision_derived_attributes: RigDerivedAttributes;
  rig: unknown;
  revision_created_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

function revisionViewFromRow(row: PublishedPresetRevisionViewRow): PublishedPresetRevisionView {
  const source = sourceFromRow(row);
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
    revision: revisionFromStorage(row),
    currentRevisionId: row.current_revision_id,
    ...(source ? { source } : {}),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

async function findPresetById(
  database: PostgresQueryable,
  id: string,
  visibility: 'visible' | 'managed',
): Promise<PublishedPreset | null> {
  const visibilityClause = visibility === 'visible'
    ? `preset.visibility IN ('public', 'unlisted')`
    : `preset.visibility <> 'hidden'`;
  const result = await database.query<PublishedPresetRow>(
    `SELECT
       preset.id AS preset_id,
       preset.title,
       preset.description,
       preset.visibility,
       creator.id AS creator_id,
       creator.handle AS creator_handle,
       creator.display_name AS creator_display_name,
       preset.source_preset_id,
       preset.source_revision_id,
       source_preset.title AS source_title,
       source_preset.visibility AS source_visibility,
       source_creator.id AS source_creator_id,
       source_creator.handle AS source_creator_handle,
       source_creator.display_name AS source_creator_display_name,
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
       revision.derived_attributes AS revision_derived_attributes,
       revision.rig,
       revision.created_at AS revision_created_at,
       preset.created_at,
       preset.updated_at
     FROM marketplace_published_presets AS preset
     JOIN marketplace_members AS creator ON creator.id = preset.creator_id
     LEFT JOIN marketplace_published_presets AS source_preset
       ON source_preset.id = preset.source_preset_id
     LEFT JOIN marketplace_members AS source_creator
       ON source_creator.id = source_preset.creator_id
     JOIN marketplace_published_preset_revisions AS revision
       ON revision.id = preset.current_revision_id
     JOIN marketplace_published_preset_search_projection AS projection
       ON projection.preset_id = preset.id
     WHERE preset.id = $1 AND ${visibilityClause}
     LIMIT 1`,
    [id],
  );
  return result.rows[0] ? publishedPresetFromRow(result.rows[0]) : null;
}

export function createPostgresPublishedPresetRepository(
  database: PostgresQueryable,
): PublishedPresetRepository {
  return {
    async findVisibleById(id) {
      return findPresetById(database, id, 'visible');
    },

    async findVisibleRevisionById(presetId, revisionId) {
      const result = await database.query<PublishedPresetRevisionViewRow>(
        `SELECT
           preset.id AS preset_id,
           preset.title,
           preset.description,
           preset.visibility,
           creator.id AS creator_id,
           creator.handle AS creator_handle,
           creator.display_name AS creator_display_name,
           preset.source_preset_id,
           preset.source_revision_id,
           source_preset.title AS source_title,
           source_preset.visibility AS source_visibility,
           source_creator.id AS source_creator_id,
           source_creator.handle AS source_creator_handle,
           source_creator.display_name AS source_creator_display_name,
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
           preset.current_revision_id,
           revision.id AS revision_id,
           revision.schema_version,
           revision.resource_dependencies,
           revision.derived_attributes AS revision_derived_attributes,
           revision.rig,
           revision.created_at AS revision_created_at,
           preset.created_at,
           preset.updated_at
         FROM marketplace_published_presets AS preset
         JOIN marketplace_members AS creator ON creator.id = preset.creator_id
         LEFT JOIN marketplace_published_presets AS source_preset
           ON source_preset.id = preset.source_preset_id
         LEFT JOIN marketplace_members AS source_creator
           ON source_creator.id = source_preset.creator_id
         JOIN marketplace_published_preset_revisions AS revision
           ON revision.preset_id = preset.id AND revision.id = $2
         WHERE preset.id = $1 AND preset.visibility IN ('public', 'unlisted')
         LIMIT 1`,
        [presetId, revisionId],
      );
      return result.rows[0] ? revisionViewFromRow(result.rows[0]) : null;
    },
  };
}

interface TagRow extends QueryResultRow {
  id: string;
  dimension: string;
  name_zh: string;
  name_en: string;
}

interface RemixSourceRow extends QueryResultRow {
  source_preset_id: string;
  source_revision_id: string;
  source_title: string;
  source_visibility: 'public' | 'unlisted';
  source_creator_id: string;
  source_creator_handle: string;
  source_creator_display_name: string;
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

interface OwnedPresetRow extends QueryResultRow {
  current_revision_id: string;
  updated_at: Date | string;
  visibility: PublishedPresetVisibility;
}

async function lockOwnedPreset(
  client: PostgresQueryable,
  presetId: string,
  creatorId: string,
  expectedUpdatedAt?: Date,
): Promise<OwnedPresetRow> {
  const result = await client.query<OwnedPresetRow>(
    `SELECT current_revision_id, updated_at, visibility
     FROM marketplace_published_presets
     WHERE id = $1 AND creator_id = $2 AND visibility <> 'hidden'
     FOR UPDATE`,
    [presetId, creatorId],
  );
  const current = result.rows[0];
  if (!current) throw new PublishedPresetAccessError();
  if (expectedUpdatedAt && new Date(current.updated_at).getTime() !== expectedUpdatedAt.getTime()) {
    const state: PublishedPresetConcurrencyState = {
      updatedAt: isoTimestamp(current.updated_at),
      currentRevisionId: current.current_revision_id,
      visibility: current.visibility,
    };
    throw new PublishedPresetConflictError(state);
  }
  return current;
}

async function replaceProjection(
  client: PostgresQueryable,
  presetId: string,
  attributes: RigDerivedAttributes,
  dependencies: readonly RigResourceDependency[],
  now: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO marketplace_published_preset_search_projection
       (preset_id, pedal_ids, amp_id, amp_model_key, cab_id, resource_kinds,
        resource_dependency_keys, projected_at)
     VALUES ($1, $2::text[], $3, $4, $5, $6::text[],
       marketplace_resource_dependency_keys($7::jsonb), $8)
     ON CONFLICT (preset_id) DO UPDATE SET
       pedal_ids = EXCLUDED.pedal_ids,
       amp_id = EXCLUDED.amp_id,
       amp_model_key = EXCLUDED.amp_model_key,
       cab_id = EXCLUDED.cab_id,
       resource_kinds = EXCLUDED.resource_kinds,
       resource_dependency_keys = EXCLUDED.resource_dependency_keys,
       projected_at = EXCLUDED.projected_at`,
    [
      presetId,
      attributes.pedalIds,
      attributes.ampId,
      attributes.ampModelKey,
      attributes.cabId,
      attributes.resourceKinds,
      JSON.stringify(dependencies),
      now,
    ],
  );
}

async function managedPreset(client: PostgresQueryable, presetId: string): Promise<PublishedPreset> {
  const preset = await findPresetById(client, presetId, 'managed');
  if (!preset) throw new PublishedPresetAccessError();
  return preset;
}

export function createPostgresPublishedPresetPublicationRepository(
  pool: Pool,
): PublishedPresetPublicationRepository & PublishedPresetManagementRepository {
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

    async listManagedByCreator(creatorId) {
      const ids = await pool.query<{ id: string } & QueryResultRow>(
        `SELECT id FROM marketplace_published_presets
         WHERE creator_id = $1 AND visibility <> 'hidden'
         ORDER BY updated_at DESC, id DESC`,
        [creatorId],
      );
      return Promise.all(ids.rows.map((row) => managedPreset(pool, row.id)));
    },

    async create(input: CreatePublishedPresetInput) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await lockCommunityWriteMember(client, input.creator.id);
        const selected = await client.query<TagRow>(
          `SELECT id, dimension, name_zh, name_en
           FROM marketplace_tags
           WHERE status = 'active' AND id = ANY($1::text[])
           ORDER BY array_position($1::text[], id)
           FOR SHARE`,
          [input.tagIds],
        );
        if (selected.rows.length !== input.tagIds.length) throw new UnavailableTagError();

        let source: PublishedPresetSource | null = null;
        if (input.source) {
          const sourceResult = await client.query<RemixSourceRow>(
            `SELECT
               source_preset.id AS source_preset_id,
               source_revision.id AS source_revision_id,
               source_preset.title AS source_title,
               source_preset.visibility AS source_visibility,
               source_creator.id AS source_creator_id,
               source_creator.handle AS source_creator_handle,
               source_creator.display_name AS source_creator_display_name
             FROM marketplace_published_presets AS source_preset
             JOIN marketplace_published_preset_revisions AS source_revision
               ON source_revision.preset_id = source_preset.id AND source_revision.id = $2
             JOIN marketplace_members AS source_creator
               ON source_creator.id = source_preset.creator_id
             WHERE source_preset.id = $1
               AND source_preset.creator_id <> $3
               AND source_preset.visibility IN ('public', 'unlisted')
             FOR SHARE OF source_preset, source_revision`,
            [input.source.presetId, input.source.revisionId, input.creator.id],
          );
          const row = sourceResult.rows[0];
          if (!row) throw new PublishedPresetSourceError();
          source = {
            presetId: row.source_preset_id,
            revisionId: row.source_revision_id,
            creator: {
              id: row.source_creator_id,
              handle: row.source_creator_handle,
              displayName: row.source_creator_display_name,
            },
            availability: 'available',
            title: row.source_title,
          };
        }

        await client.query(
          `INSERT INTO marketplace_published_presets
             (id, creator_id, title, description, visibility, current_revision_id,
              source_preset_id, source_revision_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
          [
            input.id,
            input.creator.id,
            input.title,
            input.description,
            input.visibility ?? 'public',
            input.revisionId,
            input.source?.presetId ?? null,
            input.source?.revisionId ?? null,
            input.now,
          ],
        );
        await client.query(
          `INSERT INTO marketplace_published_preset_revisions
             (id, preset_id, schema_version, resource_dependencies, derived_attributes, rig, created_at)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7)`,
          [
            input.revisionId,
            input.id,
            input.schemaVersion,
            JSON.stringify(input.resourceDependencies),
            JSON.stringify(input.derivedAttributes),
            JSON.stringify(input.rig),
            input.now,
          ],
        );
        await client.query(
          `INSERT INTO marketplace_published_preset_tags (preset_id, tag_id)
           SELECT $1, unnest($2::text[])`,
          [input.id, input.tagIds],
        );
        await replaceProjection(
          client,
          input.id,
          input.derivedAttributes,
          input.resourceDependencies,
          input.now,
        );
        await client.query('COMMIT');

        const createdAt = input.now.toISOString();
        return {
          id: input.id,
          title: input.title,
          description: input.description,
          visibility: input.visibility ?? 'public',
          creator: input.creator,
          tags: selected.rows.map(tagFromRow),
          derivedAttributes: input.derivedAttributes,
          currentRevision: {
            payloadKind: 'canonical-rig',
            id: input.revisionId,
            schemaVersion: input.schemaVersion,
            resourceDependencies: input.resourceDependencies,
            derivedAttributes: input.derivedAttributes,
            rig: input.rig,
            createdAt,
          },
          ...(source ? { source } : {}),
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

    async listRevisions(presetId, creatorId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await lockOwnedPreset(client, presetId, creatorId);
        const result = await client.query<QueryResultRow & {
          id: string;
          created_at: Date | string;
          is_current: boolean;
        }>(
          `SELECT
             revision.id,
             revision.created_at,
             revision.id = preset.current_revision_id AS is_current
           FROM marketplace_published_preset_revisions AS revision
           JOIN marketplace_published_presets AS preset ON preset.id = revision.preset_id
           WHERE revision.preset_id = $1
           ORDER BY revision.created_at DESC, revision.id DESC`,
          [presetId],
        );
        await client.query('COMMIT');
        return result.rows.map((row): PublishedPresetRevisionSummary => ({
          id: row.id,
          createdAt: isoTimestamp(row.created_at),
          isCurrent: row.is_current,
        }));
      } catch (cause) {
        await rollback(client);
        throw cause;
      } finally {
        client.release();
      }
    },

    async findManagedById(presetId, creatorId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await lockOwnedPreset(client, presetId, creatorId);
        const preset = await managedPreset(client, presetId);
        await client.query('COMMIT');
        return preset;
      } catch (cause) {
        await rollback(client);
        throw cause;
      } finally {
        client.release();
      }
    },

    async updateMetadata(input: UpdatePublishedPresetMetadataInput) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await lockCommunityWriteMember(client, input.creatorId);
        await lockOwnedPreset(client, input.presetId, input.creatorId, input.expectedUpdatedAt);
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
          `UPDATE marketplace_published_presets
           SET title = $3,
               description = $4,
               updated_at = GREATEST($5, updated_at + interval '1 millisecond')
           WHERE id = $1 AND creator_id = $2`,
          [input.presetId, input.creatorId, input.title, input.description, input.now],
        );
        await client.query(
          `DELETE FROM marketplace_published_preset_tags WHERE preset_id = $1`,
          [input.presetId],
        );
        await client.query(
          `INSERT INTO marketplace_published_preset_tags (preset_id, tag_id)
           SELECT $1, unnest($2::text[])`,
          [input.presetId, input.tagIds],
        );
        const updated = await managedPreset(client, input.presetId);
        await client.query('COMMIT');
        return updated;
      } catch (cause) {
        await rollback(client);
        throw cause;
      } finally {
        client.release();
      }
    },

    async appendRevision(input: AppendPublishedPresetRevisionInput) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await lockCommunityWriteMember(client, input.creatorId);
        await lockOwnedPreset(client, input.presetId, input.creatorId, input.expectedUpdatedAt);
        await client.query(
          `INSERT INTO marketplace_published_preset_revisions
             (id, preset_id, schema_version, resource_dependencies, derived_attributes, rig, created_at)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7)`,
          [
            input.revisionId,
            input.presetId,
            input.schemaVersion,
            JSON.stringify(input.resourceDependencies),
            JSON.stringify(input.derivedAttributes),
            JSON.stringify(input.rig),
            input.now,
          ],
        );
        await client.query(
          `UPDATE marketplace_published_presets
           SET current_revision_id = $3,
               updated_at = GREATEST($4, updated_at + interval '1 millisecond')
           WHERE id = $1 AND creator_id = $2`,
          [input.presetId, input.creatorId, input.revisionId, input.now],
        );
        await replaceProjection(
          client,
          input.presetId,
          input.derivedAttributes,
          input.resourceDependencies,
          input.now,
        );
        const updated = await managedPreset(client, input.presetId);
        await client.query('COMMIT');
        return updated;
      } catch (cause) {
        await rollback(client);
        throw cause;
      } finally {
        client.release();
      }
    },

    async restoreRevision(input: RestorePublishedPresetRevisionInput) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await lockCommunityWriteMember(client, input.creatorId);
        await lockOwnedPreset(client, input.presetId, input.creatorId, input.expectedUpdatedAt);
        const sourceResult = await client.query<QueryResultRow & {
          id: string;
          schema_version: number;
          resource_dependencies: RigResourceDependency[];
          derived_attributes: RigDerivedAttributes;
          rig: unknown;
          created_at: Date | string;
        }>(
          `SELECT id, schema_version, resource_dependencies, derived_attributes, rig, created_at
           FROM marketplace_published_preset_revisions
           WHERE preset_id = $1 AND id = $2`,
          [input.presetId, input.sourceRevisionId],
        );
        const source = sourceResult.rows[0];
        if (!source) throw new PublishedPresetRevisionNotFoundError();
        if (!isValidStoredPublishedPresetRevision({
          id: source.id,
          schemaVersion: source.schema_version,
          payloadKind: source.schema_version === RIG_PRESET_VERSION ? 'canonical-rig' : 'opaque',
          resourceDependencies: source.resource_dependencies,
          derivedAttributes: source.derived_attributes,
          rig: source.rig,
          createdAt: isoTimestamp(source.created_at),
        })) throw new PublishedPresetRevisionNotFoundError();
        await client.query(
          `INSERT INTO marketplace_published_preset_revisions
             (id, preset_id, schema_version, resource_dependencies, derived_attributes, rig, created_at)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7)`,
          [
            input.revisionId,
            input.presetId,
            source.schema_version,
            JSON.stringify(source.resource_dependencies),
            JSON.stringify(source.derived_attributes),
            JSON.stringify(source.rig),
            input.now,
          ],
        );
        await client.query(
          `UPDATE marketplace_published_presets
           SET current_revision_id = $3,
               updated_at = GREATEST($4, updated_at + interval '1 millisecond')
           WHERE id = $1 AND creator_id = $2`,
          [input.presetId, input.creatorId, input.revisionId, input.now],
        );
        await replaceProjection(
          client,
          input.presetId,
          source.derived_attributes,
          source.resource_dependencies,
          input.now,
        );
        const updated = await managedPreset(client, input.presetId);
        await client.query('COMMIT');
        return updated;
      } catch (cause) {
        await rollback(client);
        throw cause;
      } finally {
        client.release();
      }
    },

    async updateVisibility(input: UpdatePublishedPresetVisibilityInput) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await lockCommunityWriteMember(client, input.creatorId);
        await lockOwnedPreset(client, input.presetId, input.creatorId, input.expectedUpdatedAt);
        await client.query(
          `UPDATE marketplace_published_presets
           SET visibility = $3,
               updated_at = GREATEST($4, updated_at + interval '1 millisecond')
           WHERE id = $1 AND creator_id = $2`,
          [input.presetId, input.creatorId, input.visibility, input.now],
        );
        const updated = await managedPreset(client, input.presetId);
        await client.query('COMMIT');
        return updated;
      } catch (cause) {
        await rollback(client);
        throw cause;
      } finally {
        client.release();
      }
    },
  };
}
