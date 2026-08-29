import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type {
  MarketplaceTag,
  PresetCollection,
  PresetCollectionVisibility,
  PublishedPresetVisibility,
} from '../../shared/marketplace.ts';
import {
  PresetCollectionAccessError,
  PresetCollectionConflictError,
  PresetCollectionReferenceError,
  PresetCollectionTagError,
  type CreatePresetCollectionInput,
  type PresetCollectionManagementRepository,
  type PresetCollectionRepository,
  type UpdatePresetCollectionInput,
} from './repository.ts';
import type { PostgresQueryable } from '../marketplace/postgresRepository.ts';
import { canIncludePresetRevision } from './referencePolicy.ts';
import { lockCommunityWriteMember } from '../members/postgresStanding.ts';

interface CollectionRow extends QueryResultRow {
  id: string;
  title: string;
  description: string;
  visibility: PresetCollectionVisibility;
  creator_id: string;
  creator_handle: string;
  creator_display_name: string;
  tags: MarketplaceTag[];
  items: Array<{
    position: number;
    presetId: string;
    revisionId: string;
    availability: 'available' | 'unavailable';
    title: string | null;
    creator: { id: string; handle: string; displayName: string };
  }>;
  created_at: Date | string;
  updated_at: Date | string;
}

interface LockedCollectionRow extends QueryResultRow {
  visibility: PresetCollectionVisibility;
  updated_at: Date | string;
}

interface ReferenceRow extends QueryResultRow {
  preset_id: string;
  revision_id: string;
  visibility: PublishedPresetVisibility;
  creator_id: string;
}

interface TagRow extends QueryResultRow {
  id: string;
  dimension: string;
  name_zh: string;
  name_en: string;
}

function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function fromRow(row: CollectionRow): PresetCollection {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    visibility: row.visibility,
    creator: {
      id: row.creator_id,
      handle: row.creator_handle,
      displayName: row.creator_display_name,
    },
    tags: row.tags,
    items: row.items,
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

async function findCollection(
  database: PostgresQueryable,
  collectionId: string,
  creatorId?: string,
): Promise<PresetCollection | null> {
  const access = creatorId
    ? `collection.creator_id = $2 AND collection.visibility <> 'hidden'`
    : `collection.visibility IN ('public', 'unlisted')`;
  const values = creatorId ? [collectionId, creatorId] : [collectionId];
  const result = await database.query<CollectionRow>(
    `SELECT
       collection.id,
       collection.title,
       collection.description,
       collection.visibility,
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
         FROM marketplace_preset_collection_tags AS collection_tag
         JOIN marketplace_tags AS tag ON tag.id = collection_tag.tag_id
         WHERE collection_tag.collection_id = collection.id
       ), '[]'::jsonb) AS tags,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'position', item.position,
           'presetId', item.preset_id,
           'revisionId', item.revision_id,
           'availability', CASE
             WHEN preset.visibility = 'public'
               OR (
                 collection.visibility = 'unlisted'
                 AND preset.visibility = 'unlisted'
                 AND preset.creator_id = collection.creator_id
               )
             THEN 'available' ELSE 'unavailable' END,
           'title', CASE
             WHEN preset.visibility = 'public'
               OR (
                 collection.visibility = 'unlisted'
                 AND preset.visibility = 'unlisted'
                 AND preset.creator_id = collection.creator_id
               )
             THEN preset.title ELSE NULL END,
           'creator', jsonb_build_object(
             'id', preset_creator.id,
             'handle', preset_creator.handle,
             'displayName', preset_creator.display_name
           )
         ) ORDER BY item.position)
         FROM marketplace_preset_collection_items AS item
         JOIN marketplace_published_presets AS preset ON preset.id = item.preset_id
         JOIN marketplace_members AS preset_creator ON preset_creator.id = preset.creator_id
         WHERE item.collection_id = collection.id
       ), '[]'::jsonb) AS items,
       collection.created_at,
       collection.updated_at
     FROM marketplace_preset_collections AS collection
     JOIN marketplace_members AS creator ON creator.id = collection.creator_id
     WHERE collection.id = $1 AND ${access}
     LIMIT 1`,
    values,
  );
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}

function tagFromRow(row: TagRow): MarketplaceTag {
  return { id: row.id, dimension: row.dimension, nameZh: row.name_zh, nameEn: row.name_en };
}

async function activeTags(
  database: PostgresQueryable,
  tagIds?: readonly string[],
  lock = false,
): Promise<MarketplaceTag[]> {
  const result = tagIds
    ? await database.query<TagRow>(
      `SELECT id, dimension, name_zh, name_en
       FROM marketplace_tags
       WHERE status = 'active' AND id = ANY($1::text[])
       ORDER BY dimension, id
       ${lock ? 'FOR SHARE' : ''}`,
      [tagIds],
    )
    : await database.query<TagRow>(
      `SELECT id, dimension, name_zh, name_en
       FROM marketplace_tags
       WHERE status = 'active'
       ORDER BY dimension, id`,
    );
  return result.rows.map(tagFromRow);
}

async function requireTags(database: PostgresQueryable, tagIds: readonly string[]): Promise<void> {
  const tags = await activeTags(database, tagIds, true);
  if (tags.length !== new Set(tagIds).size) throw new PresetCollectionTagError();
}

async function replaceTags(
  client: PostgresQueryable,
  collectionId: string,
  tagIds: readonly string[],
): Promise<void> {
  await client.query(
    `DELETE FROM marketplace_preset_collection_tags WHERE collection_id = $1`,
    [collectionId],
  );
  for (const tagId of tagIds) {
    await client.query(
      `INSERT INTO marketplace_preset_collection_tags (collection_id, tag_id)
       VALUES ($1, $2)`,
      [collectionId, tagId],
    );
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
}

async function lockOwnedCollection(
  client: PostgresQueryable,
  input: UpdatePresetCollectionInput,
): Promise<LockedCollectionRow> {
  const result = await client.query<LockedCollectionRow>(
    `SELECT visibility, updated_at
     FROM marketplace_preset_collections
     WHERE id = $1 AND creator_id = $2 AND visibility <> 'hidden'
     FOR NO KEY UPDATE`,
    [input.collectionId, input.creatorId],
  );
  const current = result.rows[0];
  if (!current) throw new PresetCollectionAccessError();
  if (new Date(current.updated_at).getTime() !== input.expectedUpdatedAt.getTime()) {
    throw new PresetCollectionConflictError({
      updatedAt: isoTimestamp(current.updated_at),
      visibility: current.visibility,
    });
  }
  return current;
}

async function existingReferenceKeys(
  client: PostgresQueryable,
  collectionId: string,
): Promise<Set<string>> {
  const result = await client.query<{ preset_id: string; revision_id: string } & QueryResultRow>(
    `SELECT preset_id, revision_id
     FROM marketplace_preset_collection_items
     WHERE collection_id = $1`,
    [collectionId],
  );
  return new Set(result.rows.map((row) => `${row.preset_id}\u0000${row.revision_id}`));
}

async function validateReferences(
  client: PostgresQueryable,
  input: UpdatePresetCollectionInput,
  currentVisibility: PresetCollectionVisibility,
): Promise<void> {
  const existing = await existingReferenceKeys(client, input.collectionId);
  for (const item of input.items) {
    const result = await client.query<ReferenceRow>(
      `SELECT preset.id AS preset_id, revision.id AS revision_id,
              preset.visibility, preset.creator_id
       FROM marketplace_published_presets AS preset
       JOIN marketplace_published_preset_revisions AS revision
         ON revision.preset_id = preset.id AND revision.id = $2
       WHERE preset.id = $1
       FOR SHARE OF preset, revision`,
      [item.presetId, item.revisionId],
    );
    const reference = result.rows[0];
    if (!reference) throw new PresetCollectionReferenceError();
    const allowed = canIncludePresetRevision({
      targetVisibility: input.visibility,
      currentVisibility,
      collectionCreatorId: input.creatorId,
      presetVisibility: reference.visibility,
      presetCreatorId: reference.creator_id,
      alreadyIncluded: existing.has(`${item.presetId}\u0000${item.revisionId}`),
    });
    if (!allowed) throw new PresetCollectionReferenceError();
  }
}

async function replaceItems(
  client: PostgresQueryable,
  collectionId: string,
  items: UpdatePresetCollectionInput['items'],
): Promise<void> {
  await client.query(
    `DELETE FROM marketplace_preset_collection_items WHERE collection_id = $1`,
    [collectionId],
  );
  for (const [position, item] of items.entries()) {
    await client.query(
      `INSERT INTO marketplace_preset_collection_items
         (collection_id, position, preset_id, revision_id)
       VALUES ($1, $2, $3, $4)`,
      [collectionId, position, item.presetId, item.revisionId],
    );
  }
}

export function createPostgresPresetCollectionRepository(
  database: PostgresQueryable,
): PresetCollectionRepository {
  return {
    async findVisibleById(id) {
      return findCollection(database, id);
    },
  };
}

export function createPostgresPresetCollectionManagementRepository(
  pool: Pool,
): PresetCollectionManagementRepository {
  return {
    async listAvailableTags() {
      return activeTags(pool);
    },

    async findVisibleById(id) {
      return findCollection(pool, id);
    },

    async findManagedById(collectionId, creatorId) {
      const collection = await findCollection(pool, collectionId, creatorId);
      if (!collection) throw new PresetCollectionAccessError();
      return collection;
    },

    async create(input: CreatePresetCollectionInput) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await lockCommunityWriteMember(client, input.creator.id);
        await requireTags(client, input.tagIds);
        await client.query(
          `INSERT INTO marketplace_preset_collections
             (id, creator_id, title, description, visibility, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6)`,
          [input.id, input.creator.id, input.title, input.description, input.visibility, input.now],
        );
        await replaceTags(client, input.id, input.tagIds);
        await client.query('COMMIT');
      } catch (cause) {
        await rollback(client);
        throw cause;
      } finally {
        client.release();
      }
      const created = await findCollection(pool, input.id, input.creator.id);
      if (!created) throw new PresetCollectionAccessError();
      return created;
    },

    async update(input: UpdatePresetCollectionInput) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await lockCommunityWriteMember(client, input.creatorId);
        const current = await lockOwnedCollection(client, input);
        await requireTags(client, input.tagIds);
        await validateReferences(client, input, current.visibility);
        await client.query(
          `UPDATE marketplace_preset_collections
           SET title = $3,
               description = $4,
               visibility = $5,
               updated_at = GREATEST($6::timestamptz, updated_at + interval '1 millisecond')
           WHERE id = $1 AND creator_id = $2`,
          [
            input.collectionId,
            input.creatorId,
            input.title,
            input.description,
            input.visibility,
            input.now,
          ],
        );
        await replaceTags(client, input.collectionId, input.tagIds);
        await replaceItems(client, input.collectionId, input.items);
        await client.query('COMMIT');
      } catch (cause) {
        await rollback(client);
        throw cause;
      } finally {
        client.release();
      }
      const updated = await findCollection(pool, input.collectionId, input.creatorId);
      if (!updated) throw new PresetCollectionAccessError();
      return updated;
    },
  };
}
