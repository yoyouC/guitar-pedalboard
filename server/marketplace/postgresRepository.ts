import type { QueryResult, QueryResultRow } from 'pg';
import type {
  PublishedPreset,
  PublishedPresetVisibility,
  RigResourceDependency,
} from '../../shared/marketplace.ts';
import type { RigPresetState } from '../../src/state/presetCodec.ts';
import type { PublishedPresetRepository } from './repository.ts';

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
         WHERE preset.id = $1 AND preset.visibility = 'public'
         LIMIT 1`,
        [id],
      );
      return result.rows[0] ? publishedPresetFromRow(result.rows[0]) : null;
    },
  };
}
