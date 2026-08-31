import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

const MARKETPLACE_MIGRATION_LOCK_NAMESPACE = 7_410_250;
const MARKETPLACE_MIGRATION_LOCK_ID = 1;

export interface MarketplaceMigration {
  name: string;
  sql: string;
}

export interface MarketplaceMigrationResult {
  applied: string[];
  skipped: string[];
}

interface MigrationLedgerRow extends QueryResultRow {
  name: string;
  sha256: string;
}

export class MarketplaceMigrationChecksumError extends Error {
  constructor(readonly migrationName: string) {
    super(`Marketplace migration checksum changed after application: ${migrationName}`);
  }
}

function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

function transactionBody(migration: MarketplaceMigration): string {
  const withoutBegin = migration.sql.replace(/^\s*BEGIN;\s*/i, '');
  const withoutCommit = withoutBegin.replace(/\s*COMMIT;\s*$/i, '');
  if (withoutBegin === migration.sql || withoutCommit === withoutBegin) {
    throw new Error(`Marketplace migration must have one outer BEGIN/COMMIT pair: ${migration.name}`);
  }
  return withoutCommit;
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the migration failure that caused the rollback.
  }
}

async function releaseMigrationLock(client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_unlock($1, $2)', [
    MARKETPLACE_MIGRATION_LOCK_NAMESPACE,
    MARKETPLACE_MIGRATION_LOCK_ID,
  ]);
}

export async function applyMarketplaceMigrations(
  pool: Pool,
  migrations: readonly MarketplaceMigration[],
  onApplied: (name: string) => void = () => undefined,
): Promise<MarketplaceMigrationResult> {
  const client = await pool.connect();
  let lockHeld = false;
  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', [
      MARKETPLACE_MIGRATION_LOCK_NAMESPACE,
      MARKETPLACE_MIGRATION_LOCK_ID,
    ]);
    lockHeld = true;
    await client.query(`CREATE TABLE IF NOT EXISTS marketplace_schema_migrations (
      name text PRIMARY KEY,
      sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    const ledger = await client.query<MigrationLedgerRow>(
      'SELECT name, sha256 FROM marketplace_schema_migrations ORDER BY name',
    );
    const appliedChecksums = new Map(ledger.rows.map((row) => [row.name, row.sha256]));
    const result: MarketplaceMigrationResult = { applied: [], skipped: [] };

    for (const migration of migrations) {
      const checksum = migrationChecksum(migration.sql);
      const recordedChecksum = appliedChecksums.get(migration.name);
      if (recordedChecksum) {
        if (recordedChecksum !== checksum) {
          throw new MarketplaceMigrationChecksumError(migration.name);
        }
        result.skipped.push(migration.name);
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(transactionBody(migration));
        await client.query(
          `INSERT INTO marketplace_schema_migrations (name, sha256)
           VALUES ($1, $2)`,
          [migration.name, checksum],
        );
        await client.query('COMMIT');
      } catch (cause) {
        await rollback(client);
        throw cause;
      }
      result.applied.push(migration.name);
      onApplied(migration.name);
    }
    return result;
  } finally {
    try {
      if (lockHeld) await releaseMigrationLock(client);
    } finally {
      client.release();
    }
  }
}
