import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;

export const marketplacePool = connectionString
  ? new Pool({ connectionString, max: 5, idleTimeoutMillis: 10_000 })
  : null;
