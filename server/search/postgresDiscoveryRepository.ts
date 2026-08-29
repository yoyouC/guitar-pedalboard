import type { QueryResultRow } from 'pg';
import type {
  MarketplaceTag,
  PresetCollectionSearchItem,
  PublicCreatorSearchItem,
} from '../../shared/marketplace.ts';
import type { PostgresQueryable } from '../marketplace/postgresRepository.ts';
import {
  decodeDiscoveryCursor,
  encodeDiscoveryCursor,
  type MarketplaceDiscoveryKind,
} from './discoveryCursor.ts';
import type {
  MarketplaceDiscoveryRepository,
  MarketplaceDiscoverySearchInput,
} from './repository.ts';
import type { SearchBoundary } from './cursor.ts';
import {
  marketplaceTagSearchFields,
  matchesSearchText,
  searchCandidateToken,
} from './text.ts';

interface CollectionSearchTag extends MarketplaceTag {
  aliases: string[];
}

interface CollectionSearchRow extends QueryResultRow {
  id: string;
  title: string;
  description: string;
  creator_id: string;
  creator_handle: string;
  creator_display_name: string;
  tags: CollectionSearchTag[];
  created_at: Date | string;
  updated_at: Date | string;
}

interface CreatorSearchRow extends QueryResultRow {
  id: string;
  handle: string;
  display_name: string;
  bio: string;
  avatar_url: string | null;
  created_at: Date | string;
}

interface TimestampedRow extends QueryResultRow {
  id: string;
  created_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function boundary(row: TimestampedRow): SearchBoundary {
  return { id: row.id, createdAt: iso(row.created_at) };
}

function collectionFromRow(row: CollectionSearchRow): PresetCollectionSearchItem {
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
    url: `/marketplace/collections/${encodeURIComponent(row.id)}`,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function creatorFromRow(row: CreatorSearchRow): PublicCreatorSearchItem {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    bio: row.bio,
    avatarUrl: row.avatar_url,
    url: `/creators/id/${encodeURIComponent(row.id)}`,
    createdAt: iso(row.created_at),
  };
}

function pagingWhere(
  snapshot: SearchBoundary | null,
  after: SearchBoundary | null,
  values: unknown[],
): string[] {
  const clauses: string[] = [];
  const parameter = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  if (snapshot) {
    const createdAt = parameter(snapshot.createdAt);
    const id = parameter(snapshot.id);
    clauses.push(`(subject.created_at, subject.id) <= (${createdAt}::timestamptz, ${id})`);
  }
  if (after) {
    const createdAt = parameter(after.createdAt);
    const id = parameter(after.id);
    clauses.push(`(subject.created_at, subject.id) < (${createdAt}::timestamptz, ${id})`);
  }
  return clauses;
}

async function collectionRows(
  database: PostgresQueryable,
  text: string,
  snapshot: SearchBoundary | null,
  after: SearchBoundary | null,
  limit: number,
): Promise<CollectionSearchRow[]> {
  const values: unknown[] = [];
  const clauses = [`subject.visibility = 'public'`, ...pagingWhere(snapshot, after, values)];
  const candidate = searchCandidateToken(text);
  const settingsCte = candidate
    ? `WITH search_settings AS MATERIALIZED (
         SELECT set_config('pg_trgm.word_similarity_threshold', '0.2', true)
       )`
    : '';
  if (candidate) {
    values.push(candidate);
    const token = `$${values.length}`;
    clauses.push(`(
      subject.search_text IS NULL
      OR ${token}::text OPERATOR(public.<%) subject.search_text
      OR creator.search_text IS NULL
      OR ${token}::text OPERATOR(public.<%) creator.search_text
      OR EXISTS (
        SELECT 1
        FROM marketplace_preset_collection_tags AS candidate_collection_tag
        JOIN marketplace_tags AS candidate_tag ON candidate_tag.id = candidate_collection_tag.tag_id
        WHERE candidate_collection_tag.collection_id = subject.id
          AND (
            candidate_tag.search_text IS NULL
            OR ${token}::text OPERATOR(public.<%) candidate_tag.search_text
            OR EXISTS (
              SELECT 1
              FROM marketplace_tags AS forwarded_source_tag
              WHERE forwarded_source_tag.merged_into_id = candidate_tag.id
                AND (forwarded_source_tag.search_text IS NULL
                  OR ${token}::text OPERATOR(public.<%) forwarded_source_tag.search_text)
            )
          )
      )
    )`);
  }
  values.push(limit);
  const result = await database.query<CollectionSearchRow>(
    `${settingsCte}
     SELECT
       subject.id, subject.title, subject.description,
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
         FROM marketplace_preset_collection_tags AS collection_tag
         JOIN marketplace_tags AS tag ON tag.id = collection_tag.tag_id
         WHERE collection_tag.collection_id = subject.id
       ), '[]'::jsonb) AS tags,
       subject.created_at, subject.updated_at
     FROM marketplace_preset_collections AS subject
     JOIN marketplace_members AS creator ON creator.id = subject.creator_id
     ${candidate ? 'CROSS JOIN search_settings' : ''}
     WHERE ${clauses.join(' AND ')}
     ORDER BY subject.created_at DESC, subject.id DESC
     LIMIT $${values.length}`,
    values,
  );
  return result.rows;
}

async function creatorRows(
  database: PostgresQueryable,
  text: string,
  snapshot: SearchBoundary | null,
  after: SearchBoundary | null,
  limit: number,
): Promise<CreatorSearchRow[]> {
  const values: unknown[] = [];
  const clauses = ["subject.account_status = 'active'", ...pagingWhere(snapshot, after, values)];
  const candidate = searchCandidateToken(text);
  const settingsCte = candidate
    ? `WITH search_settings AS MATERIALIZED (
         SELECT set_config('pg_trgm.word_similarity_threshold', '0.2', true)
       )`
    : '';
  if (candidate) {
    values.push(candidate);
    const token = `$${values.length}`;
    clauses.push(`(subject.search_text IS NULL OR ${token}::text OPERATOR(public.<%) subject.search_text)`);
  }
  values.push(limit);
  const result = await database.query<CreatorSearchRow>(
    `${settingsCte}
     SELECT subject.id, subject.handle, subject.display_name, subject.bio,
            subject.avatar_url, subject.created_at
     FROM marketplace_members AS subject
     ${candidate ? 'CROSS JOIN search_settings' : ''}
     ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY subject.created_at DESC, subject.id DESC
     LIMIT $${values.length}`,
    values,
  );
  return result.rows;
}

async function search<Row extends TimestampedRow, Item>(input: {
  kind: MarketplaceDiscoveryKind;
  request: MarketplaceDiscoverySearchInput;
  fetchRows(snapshot: SearchBoundary | null, after: SearchBoundary | null, limit: number): Promise<Row[]>;
  matches(row: Row): boolean;
  project(row: Row): Item;
}): Promise<{ items: Item[]; nextCursor: string | null }> {
  const cursor = decodeDiscoveryCursor(input.kind, input.request);
  const first = cursor ? [] : await input.fetchRows(null, null, 1);
  const snapshot = cursor?.snapshot ?? (first[0] ? boundary(first[0]) : null);
  if (!snapshot) return { items: [], nextCursor: null };

  const matching: Row[] = [];
  const batchSize = Math.max(100, input.request.limit * 5);
  let scanAfter = cursor?.after ?? null;
  while (matching.length <= input.request.limit) {
    const rows = await input.fetchRows(snapshot, scanAfter, batchSize);
    for (const row of rows) {
      if (input.matches(row)) matching.push(row);
      if (matching.length > input.request.limit) break;
    }
    if (matching.length > input.request.limit || rows.length < batchSize) break;
    scanAfter = boundary(rows[rows.length - 1]);
  }
  const selected = matching.slice(0, input.request.limit);
  const last = selected.at(-1);
  return {
    items: selected.map(input.project),
    nextCursor: matching.length > input.request.limit && last
      ? encodeDiscoveryCursor(input.kind, input.request, snapshot, boundary(last))
      : null,
  };
}

export function createPostgresMarketplaceDiscoveryRepository(
  database: PostgresQueryable,
): MarketplaceDiscoveryRepository {
  return {
    searchPublicCollections(request) {
      return search<CollectionSearchRow, PresetCollectionSearchItem>({
        kind: 'collections',
        request,
        fetchRows: (snapshot, after, limit) => collectionRows(
          database, request.text, snapshot, after, limit,
        ),
        matches: (row) => matchesSearchText(request.text, [
          row.title,
          row.description,
          row.creator_handle,
          row.creator_display_name,
          ...row.tags.flatMap(marketplaceTagSearchFields),
        ]),
        project: collectionFromRow,
      });
    },

    searchCreators(request) {
      return search<CreatorSearchRow, PublicCreatorSearchItem>({
        kind: 'creators',
        request,
        fetchRows: (snapshot, after, limit) => creatorRows(
          database, request.text, snapshot, after, limit,
        ),
        matches: (row) => matchesSearchText(request.text, [row.handle, row.display_name]),
        project: creatorFromRow,
      });
    },
  };
}
