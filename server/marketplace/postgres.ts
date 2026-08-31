import { attachDatabasePool } from '@vercel/functions';
import { Pool } from 'pg';

const DEFAULT_POOL_MAX = 2;
const DEFAULT_IDLE_TIMEOUT_MS = 5_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 2_000;
const DEFAULT_QUERY_TIMEOUT_MS = 15_000;

export class MarketplacePostgresConfigurationError extends Error {}

function configuredInteger(
  environment: Record<string, string | undefined>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new MarketplacePostgresConfigurationError(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function runtimeConnectionString(
  environment: Record<string, string | undefined>,
): string | null {
  const connectionString = environment.MARKETPLACE_RUNTIME_DATABASE_URL
    ?? environment.DATABASE_URL
    ?? environment.POSTGRES_URL;
  if (!connectionString) return null;
  try {
    const url = new URL(connectionString);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new Error('invalid');
  } catch {
    throw new MarketplacePostgresConfigurationError(
      'Marketplace runtime database URL must be a PostgreSQL connection string',
    );
  }
  return connectionString;
}

export function createMarketplacePostgresPool(
  environment: Record<string, string | undefined>,
  attach: (pool: Pool) => void = attachDatabasePool,
): Pool | null {
  const connectionString = runtimeConnectionString(environment);
  if (!connectionString) return null;
  const pool = new Pool({
    connectionString,
    max: configuredInteger(environment, 'MARKETPLACE_DATABASE_POOL_MAX', DEFAULT_POOL_MAX, 1, 5),
    idleTimeoutMillis: configuredInteger(
      environment,
      'MARKETPLACE_DATABASE_IDLE_TIMEOUT_MS',
      DEFAULT_IDLE_TIMEOUT_MS,
      1_000,
      30_000,
    ),
    connectionTimeoutMillis: configuredInteger(
      environment,
      'MARKETPLACE_DATABASE_CONNECTION_TIMEOUT_MS',
      DEFAULT_CONNECTION_TIMEOUT_MS,
      250,
      10_000,
    ),
    query_timeout: configuredInteger(
      environment,
      'MARKETPLACE_DATABASE_QUERY_TIMEOUT_MS',
      DEFAULT_QUERY_TIMEOUT_MS,
      1_000,
      60_000,
    ),
  });
  attach(pool);
  return pool;
}

export const marketplacePool = createMarketplacePostgresPool(process.env);
