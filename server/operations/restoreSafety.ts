export function assertDisposableRestoreDatabase(
  restoreConnectionString: string,
  productionConnectionString?: string,
): void {
  const restore = new URL(restoreConnectionString);
  const databaseName = decodeURIComponent(restore.pathname.replace(/^\//, ''));
  if (
    productionConnectionString
    && databaseIdentityKey(marketplaceDatabaseIdentity(restoreConnectionString))
      === databaseIdentityKey(marketplaceDatabaseIdentity(productionConnectionString))
  ) {
    throw new Error('Restore drill target must not be the production database');
  }
  if (!/(?:^|[_-])restore(?:[_-]drill)?(?:$|[_-])|(?:^|[_-])restore_drill$/i.test(databaseName)) {
    throw new Error('Restore drill database name must explicitly contain restore_drill');
  }
}

export interface MarketplaceDatabaseIdentity {
  host: string;
  port: string;
  database: string;
}

export function isMarketplaceDatabaseIdentity(value: unknown): value is MarketplaceDatabaseIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Record<string, unknown>;
  return typeof identity.host === 'string' && identity.host.length > 0
    && typeof identity.port === 'string' && /^\d+$/.test(identity.port)
    && typeof identity.database === 'string' && identity.database.length > 0;
}

export function marketplaceDatabaseIdentity(connectionString: string): MarketplaceDatabaseIdentity {
  const url = new URL(connectionString);
  const host = url.hostname.toLocaleLowerCase('en');
  const port = url.port || '5432';
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  return { host, port, database };
}

export function assertExpectedMarketplaceBackupSource(
  expectedConnectionString: string,
  actual: MarketplaceDatabaseIdentity,
): void {
  if (
    databaseIdentityKey(marketplaceDatabaseIdentity(expectedConnectionString))
    !== databaseIdentityKey(actual)
  ) {
    throw new Error('Backup manifest source does not match the expected Marketplace database');
  }
}

function databaseIdentityKey(identity: MarketplaceDatabaseIdentity): string {
  return `${identity.host}:${identity.port}/${identity.database}`;
}

export function assertDisposableBenchmarkDatabase(connectionString: string): void {
  const databaseName = new URL(connectionString).pathname.slice(1).toLowerCase();
  if (!/(benchmark|bench|perf)/.test(databaseName)) {
    throw new Error('Benchmark database name must contain benchmark, bench, or perf');
  }
}
