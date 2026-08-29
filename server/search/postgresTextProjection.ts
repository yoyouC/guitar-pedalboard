import type { QueryResultRow } from 'pg';
import type { PostgresQueryable } from '../marketplace/postgresRepository.ts';
import { normalizeSearchText } from './text.ts';

interface ProjectionSourceRow extends QueryResultRow {
  id: string;
  fields: string[];
}

const BATCH_SIZE = 1_000;

export async function rebuildMarketplaceTextSearchProjection(
  database: PostgresQueryable,
): Promise<void> {
  await rebuildTable(database, 'marketplace_members',
    `SELECT id, ARRAY[handle, display_name] AS fields FROM marketplace_members`);
  await rebuildTable(database, 'marketplace_published_presets',
    `SELECT id, ARRAY[title, description] AS fields FROM marketplace_published_presets`);
  await rebuildTable(database, 'marketplace_preset_collections',
    `SELECT id, ARRAY[title, description] AS fields FROM marketplace_preset_collections`);
  await rebuildTable(database, 'marketplace_tags',
    `SELECT id, ARRAY[id, name_zh, name_en] || ARRAY(
       SELECT jsonb_array_elements_text(aliases)
     ) AS fields
     FROM marketplace_tags`);
}

async function rebuildTable(
  database: PostgresQueryable,
  table: 'marketplace_members' | 'marketplace_published_presets'
    | 'marketplace_preset_collections' | 'marketplace_tags',
  sourceSql: string,
): Promise<void> {
  const result = await database.query<ProjectionSourceRow>(sourceSql);
  for (let offset = 0; offset < result.rows.length; offset += BATCH_SIZE) {
    const batch = result.rows.slice(offset, offset + BATCH_SIZE);
    await database.query(
      `UPDATE ${table} AS subject
       SET search_text = projection.search_text
       FROM unnest($1::text[], $2::text[]) AS projection(id, search_text)
       WHERE subject.id = projection.id`,
      [
        batch.map((row) => row.id),
        batch.map((row) => normalizeSearchText(row.fields.join(' '))),
      ],
    );
  }
}
