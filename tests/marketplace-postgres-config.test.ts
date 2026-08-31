import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  createMarketplacePostgresPool,
  MarketplacePostgresConfigurationError,
} from '../server/marketplace/postgres.ts';

test('runtime PostgreSQL pool prefers the pooled URL and attaches its Vercel lifecycle', async () => {
  let attached: Pool | null = null;
  const pool = createMarketplacePostgresPool({
    MARKETPLACE_RUNTIME_DATABASE_URL: 'postgresql://runtime-pool.example.test/marketplace',
    DATABASE_URL: 'postgresql://direct.example.test/marketplace',
    MARKETPLACE_DATABASE_POOL_MAX: '3',
    MARKETPLACE_DATABASE_IDLE_TIMEOUT_MS: '6000',
    MARKETPLACE_DATABASE_CONNECTION_TIMEOUT_MS: '2500',
    MARKETPLACE_DATABASE_QUERY_TIMEOUT_MS: '12000',
  }, (candidate) => { attached = candidate; });
  assert.ok(pool);
  assert.equal(attached, pool);
  assert.equal(pool.options.connectionString, 'postgresql://runtime-pool.example.test/marketplace');
  assert.equal(pool.options.max, 3);
  assert.equal(pool.options.idleTimeoutMillis, 6_000);
  assert.equal(pool.options.connectionTimeoutMillis, 2_500);
  assert.equal(pool.options.query_timeout, 12_000);
  await pool.end();
});

test('runtime PostgreSQL pool stays disabled without a connection and rejects unsafe bounds', () => {
  let attached = false;
  assert.equal(createMarketplacePostgresPool({}, () => { attached = true; }), null);
  assert.equal(attached, false);
  assert.throws(
    () => createMarketplacePostgresPool({
      MARKETPLACE_RUNTIME_DATABASE_URL: 'postgresql://pool.example.test/marketplace',
      MARKETPLACE_DATABASE_POOL_MAX: '20',
    }, () => undefined),
    MarketplacePostgresConfigurationError,
  );
  assert.throws(
    () => createMarketplacePostgresPool({
      MARKETPLACE_RUNTIME_DATABASE_URL: 'https://pool.example.test/marketplace',
    }, () => undefined),
    MarketplacePostgresConfigurationError,
  );
});
