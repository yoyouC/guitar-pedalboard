import type { Pool, QueryResultRow } from 'pg';
import type { PublicCreatorWorkSummary } from '../../shared/members.js';
import type { PublishedPreset } from '../../shared/marketplace.js';

export interface PublicCreatorWorks {
  listByCreatorId(creatorId: string): Promise<PublicCreatorWorkSummary[]>;
}

export function createMemoryPublicCreatorWorks(
  presets: readonly PublishedPreset[] = [],
): PublicCreatorWorks {
  return {
    async listByCreatorId(creatorId) {
      return presets
        .filter((preset) => preset.creator.id === creatorId && preset.visibility === 'public')
        .slice(0, 100)
        .map((preset) => ({
          id: preset.id,
          title: preset.title,
          url: `/marketplace/tones/${encodeURIComponent(preset.id)}`,
        }));
    },
  };
}

interface WorkRow extends QueryResultRow {
  id: string;
  title: string;
}

export function createPostgresPublicCreatorWorks(pool: Pool): PublicCreatorWorks {
  return {
    async listByCreatorId(creatorId) {
      const result = await pool.query<WorkRow>(
        `SELECT id, title
         FROM marketplace_published_presets
         WHERE creator_id = $1 AND visibility = 'public'
         ORDER BY created_at DESC, id DESC
         LIMIT 100`,
        [creatorId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        url: `/marketplace/tones/${encodeURIComponent(row.id)}`,
      }));
    },
  };
}
