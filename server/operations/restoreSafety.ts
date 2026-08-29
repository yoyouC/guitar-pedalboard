export function assertDisposableRestoreDatabase(
  restoreConnectionString: string,
  productionConnectionString?: string,
): void {
  const restore = new URL(restoreConnectionString);
  const databaseName = decodeURIComponent(restore.pathname.replace(/^\//, ''));
  if (productionConnectionString && restoreConnectionString === productionConnectionString) {
    throw new Error('Restore drill target must not be the production database');
  }
  if (!/(?:^|[_-])restore(?:[_-]drill)?(?:$|[_-])|(?:^|[_-])restore_drill$/i.test(databaseName)) {
    throw new Error('Restore drill database name must explicitly contain restore_drill');
  }
}

export function assertDisposableBenchmarkDatabase(connectionString: string): void {
  const databaseName = new URL(connectionString).pathname.slice(1).toLowerCase();
  if (!/(benchmark|bench|perf)/.test(databaseName)) {
    throw new Error('Benchmark database name must contain benchmark, bench, or perf');
  }
}
