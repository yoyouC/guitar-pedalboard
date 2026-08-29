const QUERY_ENVIRONMENT = {
  application_name: 'PGAPPNAME',
  channel_binding: 'PGCHANNELBINDING',
  connect_timeout: 'PGCONNECT_TIMEOUT',
  options: 'PGOPTIONS',
  sslcert: 'PGSSLCERT',
  sslkey: 'PGSSLKEY',
  sslmode: 'PGSSLMODE',
  sslpassword: 'PGSSLPASSWORD',
  sslrootcert: 'PGSSLROOTCERT',
  target_session_attrs: 'PGTARGETSESSIONATTRS',
} as const;

export function postgresCommandEnvironment(connectionString: string): Record<string, string> {
  const url = new URL(connectionString);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('PostgreSQL command requires a postgres connection URL');
  }
  const environment: Record<string, string> = {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')),
  };
  if (url.username) environment.PGUSER = decodeURIComponent(url.username);
  if (url.password) environment.PGPASSWORD = decodeURIComponent(url.password);
  for (const [parameter, variable] of Object.entries(QUERY_ENVIRONMENT)) {
    const value = url.searchParams.get(parameter);
    if (value !== null) environment[variable] = value;
  }
  if (!environment.PGSSLMODE && url.searchParams.get('ssl') === 'true') {
    environment.PGSSLMODE = 'require';
  }
  return environment;
}
