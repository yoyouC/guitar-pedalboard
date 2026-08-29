import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import { assertDisposableBenchmarkDatabase } from '../server/operations/restoreSafety.ts';
import { rebuildMarketplaceTextSearchProjection } from '../server/search/postgresTextProjection.ts';

const connectionString = process.env.MARKETPLACE_BENCHMARK_DATABASE_URL;
if (!connectionString) throw new Error('Set MARKETPLACE_BENCHMARK_DATABASE_URL');
if (process.env.MARKETPLACE_ALLOW_BENCHMARK_RESET !== 'true') {
  throw new Error('Set MARKETPLACE_ALLOW_BENCHMARK_RESET=true to reset the benchmark database');
}
assertDisposableBenchmarkDatabase(connectionString);

const pool = new Pool({ connectionString });
try {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const migrationsUrl = new URL('../server/marketplace/migrations/', import.meta.url);
  for (const migration of (await readdir(migrationsUrl)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
    await pool.query(await readFile(new URL(migration, migrationsUrl), 'utf8'));
  }

  const revision = demoPublishedPreset.currentRevision;
  await pool.query('BEGIN');
  await pool.query(
    `INSERT INTO marketplace_members (id, handle, display_name, created_at)
     SELECT 'member-bench-' || value, 'bench-' || value, 'Benchmark Member ' || value,
            timestamptz '2026-01-01 00:00:00+00' + value * interval '1 second'
     FROM generate_series(1, 10000) AS value`,
  );
  await pool.query('SET CONSTRAINTS ALL DEFERRED');
  await pool.query(
    `INSERT INTO marketplace_published_presets
       (id, creator_id, title, description, visibility, current_revision_id, created_at, updated_at)
     SELECT 'preset-bench-' || value,
            'member-bench-' || (((value - 1) % 10000) + 1),
            CASE WHEN value = 1 THEN 'Rare Quasar Tone' ELSE 'Benchmark Tone ' || value END,
            'Representative marketplace benchmark preset', 'public',
            'revision-bench-' || value,
            timestamptz '2026-01-01 00:00:00+00' + value * interval '1 second',
            timestamptz '2026-01-01 00:00:00+00' + value * interval '1 second'
     FROM generate_series(1, 100000) AS value`,
  );
  await pool.query(
    `INSERT INTO marketplace_published_preset_revisions
       (id, preset_id, schema_version, resource_dependencies, derived_attributes, rig, created_at)
     SELECT 'revision-bench-' || value, 'preset-bench-' || value, $1, $2::jsonb, $3::jsonb,
            $4::jsonb, timestamptz '2026-01-01 00:00:00+00' + value * interval '1 second'
     FROM generate_series(1, 100000) AS value`,
    [revision.schemaVersion, JSON.stringify(revision.resourceDependencies),
      JSON.stringify(demoPublishedPreset.derivedAttributes), JSON.stringify(revision.rig)],
  );
  await pool.query(
    `INSERT INTO marketplace_published_preset_search_projection
       (preset_id, pedal_ids, amp_id, amp_model_key, cab_id, resource_kinds,
        resource_dependency_keys, projected_at)
     SELECT 'preset-bench-' || value, '{}'::text[], 'crunch', 'builtin:crunch', 'gb4x12',
            ARRAY['builtin'], ARRAY['builtin'], now()
     FROM generate_series(1, 100000) AS value`,
  );
  await pool.query(
    `INSERT INTO marketplace_published_preset_tags (preset_id, tag_id)
     SELECT 'preset-bench-' || value, 'tone-crunch'
     FROM generate_series(1, 100000) AS value`,
  );
  await pool.query('COMMIT');
  await rebuildMarketplaceTextSearchProjection(pool);
  await pool.query('ANALYZE');
  console.log(JSON.stringify({ members: 10_000, publicPresets: 100_000 }));
} catch (cause) {
  try { await pool.query('ROLLBACK'); } catch { /* preserve original error */ }
  throw cause;
} finally {
  await pool.end();
}
