import type { QueryResultRow } from 'pg';
import type {
  MarketplaceTag,
  PublishedPresetSearchItem,
  RigDerivedAttributes,
  RigResourceDependencyKey,
} from '../../shared/marketplace.ts';
import type { PostgresQueryable } from '../marketplace/postgresRepository.ts';
import {
  decodeSearchCursor,
  encodeSearchCursor,
  type SearchBoundary,
} from './cursor.ts';
import type {
  PublishedPresetSearchInput,
  PublishedPresetSearchRepository,
} from './repository.ts';
import { matchesSearchText } from './text.ts';

interface SearchTag extends MarketplaceTag {
  aliases: string[];
}

interface SearchRow extends QueryResultRow {
  id: string;
  title: string;
  description: string;
  creator_id: string;
  creator_handle: string;
  creator_display_name: string;
  tags: SearchTag[];
  pedal_ids: string[];
  amp_id: string;
  amp_model_key: string;
  cab_id: string;
  resource_kinds: RigDerivedAttributes['resourceKinds'];
  resource_dependency_keys: RigResourceDependencyKey[];
  created_at: Date | string;
  updated_at: Date | string;
}

function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function boundary(row: Pick<SearchRow, 'id' | 'created_at'>): SearchBoundary {
  return { id: row.id, createdAt: isoTimestamp(row.created_at) };
}

function itemFromRow(row: SearchRow): PublishedPresetSearchItem {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    creator: {
      id: row.creator_id,
      handle: row.creator_handle,
      displayName: row.creator_display_name,
    },
    tags: row.tags.map(({ aliases: _aliases, ...tag }) => tag),
    derivedAttributes: {
      pedalIds: row.pedal_ids,
      ampId: row.amp_id,
      ampModelKey: row.amp_model_key,
      cabId: row.cab_id,
      resourceKinds: row.resource_kinds,
    },
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

function buildWhere(input: PublishedPresetSearchInput): {
  clauses: string[];
  values: unknown[];
} {
  const clauses = [`preset.visibility = 'public'`];
  const values: unknown[] = [];
  const parameter = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  if (input.tagIds.length > 0) {
    const token = parameter(input.tagIds);
    clauses.push(
      `NOT EXISTS (
         SELECT 1 FROM unnest(${token}::text[]) AS required_tag(id)
         WHERE NOT EXISTS (
           SELECT 1
           FROM marketplace_tags AS requested_tag
           JOIN marketplace_published_preset_tags AS filter_tag
             ON filter_tag.tag_id = COALESCE(requested_tag.merged_into_id, requested_tag.id)
           WHERE requested_tag.id = required_tag.id AND filter_tag.preset_id = preset.id
         )
       )`,
    );
  }
  if (input.pedalIds.length > 0) {
    clauses.push(`projection.pedal_ids @> ${parameter(input.pedalIds)}::text[]`);
  }
  if (input.ampIds.length > 0) {
    clauses.push(`projection.amp_id = ANY(${parameter(input.ampIds)}::text[])`);
  }
  if (input.cabIds.length > 0) {
    clauses.push(`projection.cab_id = ANY(${parameter(input.cabIds)}::text[])`);
  }
  if (input.resourceKinds.length > 0) {
    clauses.push(`projection.resource_kinds @> ${parameter(input.resourceKinds)}::text[]`);
  }
  if (input.resourceDependencyKeys.length > 0) {
    clauses.push(
      `projection.resource_dependency_keys @> ${parameter(input.resourceDependencyKeys)}::text[]`,
    );
  }
  if (input.publishedAfter) {
    clauses.push(`preset.created_at >= ${parameter(input.publishedAfter)}::timestamptz`);
  }
  if (input.publishedBefore) {
    clauses.push(`preset.created_at <= ${parameter(input.publishedBefore)}::timestamptz`);
  }
  return { clauses, values };
}

async function fetchRows(
  database: PostgresQueryable,
  input: PublishedPresetSearchInput,
  snapshot: SearchBoundary | null,
  after: SearchBoundary | null,
  limit: number,
): Promise<SearchRow[]> {
  const { clauses, values } = buildWhere(input);
  const parameter = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  if (snapshot) {
    const createdAt = parameter(snapshot.createdAt);
    const id = parameter(snapshot.id);
    clauses.push(`(preset.created_at, preset.id) <= (${createdAt}::timestamptz, ${id})`);
  }
  if (after) {
    const createdAt = parameter(after.createdAt);
    const id = parameter(after.id);
    clauses.push(`(preset.created_at, preset.id) < (${createdAt}::timestamptz, ${id})`);
  }
  const rowLimit = parameter(limit);
  const result = await database.query<SearchRow>(
    `SELECT
       preset.id,
       preset.title,
       preset.description,
       creator.id AS creator_id,
       creator.handle AS creator_handle,
       creator.display_name AS creator_display_name,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'id', tag.id,
           'dimension', tag.dimension,
           'nameZh', tag.name_zh,
           'nameEn', tag.name_en,
           'aliases', tag.aliases || COALESCE((
             SELECT jsonb_agg(forwarded.value)
             FROM marketplace_tags AS source_tag
             CROSS JOIN LATERAL jsonb_array_elements(
               source_tag.aliases || jsonb_build_array(
                 source_tag.id, source_tag.name_zh, source_tag.name_en
               )
             ) AS forwarded(value)
             WHERE source_tag.merged_into_id = tag.id
           ), '[]'::jsonb)
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
       projection.resource_dependency_keys,
       preset.created_at,
       preset.updated_at
     FROM marketplace_published_presets AS preset
     JOIN marketplace_members AS creator ON creator.id = preset.creator_id
     JOIN marketplace_published_preset_search_projection AS projection
       ON projection.preset_id = preset.id
     WHERE ${clauses.join(' AND ')}
     ORDER BY preset.created_at DESC, preset.id DESC
     LIMIT ${rowLimit}`,
    values,
  );
  return result.rows;
}

function rowMatchesText(row: SearchRow, text: string): boolean {
  return matchesSearchText(text, [
    row.title,
    row.description,
    row.creator_handle,
    ...row.tags.flatMap((tag) => [tag.nameZh, tag.nameEn, ...tag.aliases]),
  ]);
}

export function createPostgresPublishedPresetSearchRepository(
  database: PostgresQueryable,
): PublishedPresetSearchRepository {
  return {
    async searchPublicPresets(input) {
      const cursor = input.cursor ? decodeSearchCursor(input.cursor, input) : null;
      const first = cursor ? [] : await fetchRows(database, input, null, null, 1);
      const snapshot = cursor?.snapshot ?? (first[0] ? boundary(first[0]) : null);
      if (!snapshot) return { items: [], nextCursor: null };

      const matching: SearchRow[] = [];
      const batchSize = Math.max(100, input.limit * 5);
      let scanAfter: SearchBoundary | null = cursor?.after ?? null;
      while (matching.length <= input.limit) {
        const rows = await fetchRows(database, input, snapshot, scanAfter, batchSize);
        for (const row of rows) {
          if (rowMatchesText(row, input.text)) matching.push(row);
          if (matching.length > input.limit) break;
        }
        if (matching.length > input.limit || rows.length < batchSize) break;
        scanAfter = boundary(rows[rows.length - 1]);
      }
      const hasMore = matching.length > input.limit;
      const pageRows = matching.slice(0, input.limit);
      const last = pageRows.at(-1);
      return {
        items: pageRows.map(itemFromRow),
        nextCursor: hasMore && last
          ? encodeSearchCursor(input, snapshot, boundary(last))
          : null,
      };
    },
  };
}

interface SearchProjectionPool {
  connect(): Promise<PostgresQueryable & { release(): void }>;
}

export async function rebuildPublishedPresetSearchProjection(
  pool: SearchProjectionPool,
  now: Date,
): Promise<void> {
  const database = await pool.connect();
  try {
    await database.query('BEGIN');
    await database.query(
      `INSERT INTO marketplace_published_preset_search_projection
         (preset_id, pedal_ids, amp_id, amp_model_key, cab_id, resource_kinds,
          resource_dependency_keys, projected_at)
       SELECT
         preset.id,
         ARRAY(SELECT jsonb_array_elements_text(revision.derived_attributes->'pedalIds')),
         revision.derived_attributes->>'ampId',
         revision.derived_attributes->>'ampModelKey',
         revision.derived_attributes->>'cabId',
         ARRAY(SELECT jsonb_array_elements_text(revision.derived_attributes->'resourceKinds')),
         marketplace_resource_dependency_keys(revision.resource_dependencies),
         $1
       FROM marketplace_published_presets AS preset
       JOIN marketplace_published_preset_revisions AS revision
         ON revision.preset_id = preset.id AND revision.id = preset.current_revision_id
       ON CONFLICT (preset_id) DO UPDATE SET
         pedal_ids = EXCLUDED.pedal_ids,
         amp_id = EXCLUDED.amp_id,
         amp_model_key = EXCLUDED.amp_model_key,
         cab_id = EXCLUDED.cab_id,
         resource_kinds = EXCLUDED.resource_kinds,
         resource_dependency_keys = EXCLUDED.resource_dependency_keys,
         projected_at = EXCLUDED.projected_at`,
      [now],
    );
    await database.query(
      `DELETE FROM marketplace_published_preset_search_projection AS projection
       WHERE NOT EXISTS (
         SELECT 1 FROM marketplace_published_presets AS preset
         WHERE preset.id = projection.preset_id
       )`,
    );
    await database.query('COMMIT');
  } catch (cause) {
    try { await database.query('ROLLBACK'); } catch { /* preserve original error */ }
    throw cause;
  } finally {
    database.release();
  }
}
