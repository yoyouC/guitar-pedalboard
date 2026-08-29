import { Pool } from 'pg';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';

const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!connectionString) throw new Error('Set DATABASE_URL or POSTGRES_URL');

const preset = demoPublishedPreset;
const revision = preset.currentRevision;
const pool = new Pool({ connectionString });
const client = await pool.connect();

try {
  await client.query('BEGIN');
  await client.query(
    `INSERT INTO marketplace_members (id, handle, display_name, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [preset.creator.id, preset.creator.handle, preset.creator.displayName, preset.createdAt],
  );
  await client.query(
    `INSERT INTO marketplace_member_handle_claims (handle, member_id, claimed_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (handle) DO NOTHING`,
    [preset.creator.handle, preset.creator.id, preset.createdAt],
  );
  await client.query(
    `INSERT INTO marketplace_published_presets
       (id, creator_id, title, description, visibility, current_revision_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO NOTHING`,
    [
      preset.id,
      preset.creator.id,
      preset.title,
      preset.description,
      preset.visibility,
      revision.id,
      preset.createdAt,
      preset.updatedAt,
    ],
  );
  await client.query(
    `INSERT INTO marketplace_published_preset_revisions
       (id, preset_id, schema_version, resource_dependencies, rig, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [
      revision.id,
      preset.id,
      revision.schemaVersion,
      JSON.stringify(revision.resourceDependencies),
      JSON.stringify(revision.rig),
      revision.createdAt,
    ],
  );
  await client.query('COMMIT');
  console.log(`Seeded ${preset.id}`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
