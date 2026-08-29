# Marketplace operations: primary-source constraints

Research date: 2026-08-29. This note records provider-neutral constraints for Issue #37. Facts
below come from PostgreSQL or Vercel first-party documentation; recommendations labelled
"Implication" are engineering conclusions drawn from those facts.

## PostgreSQL logical backup and restore

### Consistency and coverage

- `pg_dump` produces an internally consistent logical snapshot even while normal reads and writes
  continue. The snapshot represents the database when the dump began; operations needing an
  exclusive lock, such as many `ALTER TABLE` forms, are the important exception. Parallel dumps
  use synchronized snapshots so their worker connections see the same data set.
  ([SQL Dump](https://www.postgresql.org/docs/current/backup-dump.html),
  [`pg_dump`](https://www.postgresql.org/docs/current/app-pgdump.html))
- One `pg_dump` covers one database. It does not include cluster-wide roles or tablespaces.
  `pg_dumpall --globals-only` is required if those global objects must also be recoverable. A full
  `pg_dumpall` gives each database an internally consistent snapshot, but snapshots across
  databases are not synchronized.
  ([SQL Dump: using `pg_dumpall`](https://www.postgresql.org/docs/current/backup-dump.html#BACKUP-DUMP-ALL))
- Custom (`-Fc`) and directory (`-Fd`) archives are compressed by default, selectable, and
  restorable with `pg_restore`; both support parallel restore, while only directory format supports
  parallel dump.
  ([`pg_dump` formats](https://www.postgresql.org/docs/current/app-pgdump.html))
- `pg_dump` is a logical snapshot, not a continuous/PITR backup. PostgreSQL explicitly says a dump
  cannot participate in WAL replay, and its current documentation cautions that, outside simple
  cases, `pg_dump` is generally not the complete answer for regular production backups.
  ([continuous archiving and PITR](https://www.postgresql.org/docs/current/continuous-archiving.html),
  [`pg_dump` description](https://www.postgresql.org/docs/current/app-pgdump.html))

### Restore semantics that affect a drill

- By default, `pg_restore` continues after SQL errors and reports an error count at the end.
  `--exit-on-error` changes this to fail immediately.
  ([`pg_restore --exit-on-error`](https://www.postgresql.org/docs/current/app-pgrestore.html))
- `pg_restore --single-transaction` makes the restore all-or-nothing and implies
  `--exit-on-error`. It cannot be combined with parallel `--jobs`; parallel restore can reduce RTO,
  but gives up that single-transaction guarantee.
  ([`pg_restore --single-transaction`](https://www.postgresql.org/docs/current/app-pgrestore.html))
- A current `pg_dump` can dump older supported servers, but an older client refuses a newer server.
  Loading into an older major server is not guaranteed. After restore, PostgreSQL recommends
  `ANALYZE` so the optimizer has useful statistics.
  ([`pg_dump` compatibility](https://www.postgresql.org/docs/current/app-pgdump.html),
  [restore guidance](https://www.postgresql.org/docs/current/backup-dump.html#BACKUP-DUMP-RESTORE))
- Production backup scripts should not pass `--no-sync`: the default waits for files to reach safe
  storage, while `--no-sync` can leave a corrupt dump after an operating-system crash.
  ([`pg_dump --no-sync`](https://www.postgresql.org/docs/current/app-pgdump.html))

### Implications for the Issue #37 backup contract

1. A portable baseline can use a daily custom archive (`pg_dump -Fc`) plus an optional encrypted
   `pg_dumpall --globals-only` artifact when database roles/ownership are in recovery scope. Use a
   dump client at least as new as the server, capture both versions, inspect stderr, require a zero
   exit status, and never use `--no-sync`.
2. "The cron endpoint returned 2xx" is not a completed backup. Completion should be recorded only
   after the archive has reached durable storage, its byte size and cryptographic digest have been
   recorded, and the run manifest has been committed. Retain the last successful completion time,
   not merely the last attempt time.
3. A daily schedule is only evidence toward RPO 24 hours. The actual proof is a most-recent
   successful, durable artifact no older than 24 hours. A failed daily run needs an alert and a
   separate catch-up path; waiting for the next daily tick can make the recovery point older than
   24 hours.
4. The recovery drill should restore a chosen artifact into a newly created empty database, use
   `pg_restore --single-transaction` when it remains within the eight-hour RTO, run `ANALYZE`, then
   execute schema/version checks and domain invariants. Record artifact timestamp, restore start
   and finish, commands/tool versions, row/invariant results, and the measured RPO and RTO. If data
   growth forces `--jobs`, the runbook must explicitly handle and clean up partial restores.
5. Listing an archive or checking its digest detects some classes of damage, but only a successful
   restore plus application/domain checks proves recoverability. The drill therefore cannot be
   replaced by a backup-success log line.

## Vercel does not provide the project's PostgreSQL backup guarantee

- Vercel Postgres has been retired. New PostgreSQL resources connected through Vercel are provided
  by external Marketplace providers; Vercel supplies provisioning integration and injected
  credentials. Vercel tells customers to compare provider-specific features such as point-in-time
  recovery.
  ([Postgres on Vercel](https://vercel.com/docs/postgres),
  [Marketplace storage](https://vercel.com/docs/marketplace-storage))
- Vercel describes two-hour backups for its own infrastructure, but explicitly says those backups
  are not available to customers and exist for Vercel's infrastructure disaster recovery.
  ([Security & Compliance: Data backup](https://vercel.com/docs/security/compliance#data-backup))
- Vercel's Data Processing Addendum also assigns customers responsibility for maintaining their own
  backups of Customer Data.
  ([Vercel DPA, section 8](https://vercel.com/legal/dpa))

**Implication:** neither a Vercel deployment nor a connected Marketplace database proves #37's
RPO/RTO. Provider-native backup/PITR can be an additional layer, but its retention, restore access,
and contractual targets must be verified against the selected database provider. The
provider-neutral acceptance evidence should remain the independently retained dump, manifest, and
repeatable restore drill.

## Vercel Cron authorization and reliability

### Documented behavior

- A Vercel Cron Job invokes the configured path on the production deployment with an HTTP `GET`.
  Preview deployments are ignored, expressions always use UTC, and the cron request has
  `vercel-cron/1.0` as its user agent.
  ([Cron Jobs](https://vercel.com/docs/cron-jobs),
  [setup guide](https://vercel.com/kb/guide/how-to-setup-cron-jobs-on-vercel))
- When `CRON_SECRET` is configured, Vercel sends it as
  `Authorization: Bearer <CRON_SECRET>`. The handler must compare the complete header with the
  environment variable and reject a missing or incorrect value. Vercel recommends a random secret
  of at least 16 characters; the user-agent string is useful for diagnosis, not a substitute for
  secret verification.
  ([Managing Cron Jobs: securing cron jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs))
- Vercel explicitly does **not retry a failed cron invocation**. Its event-driven system can also
  deliver the same cron event more than once, and a second invocation can overlap a still-running
  first invocation. Vercel recommends both locking and idempotency.
  ([Managing Cron Jobs: errors, concurrency, and idempotency](https://vercel.com/docs/cron-jobs/manage-cron-jobs))
- Cron execution has the same maximum-duration limit as its Vercel Function. Cron requests do not
  follow redirects. A redirect or cached response is not shown in cron runtime logs, so the cron
  route should be a direct, uncached function route.
  ([Managing Cron Jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs),
  [Function limits](https://vercel.com/docs/functions/limitations))
- A Vercel Function's filesystem is read-only except for at most 500 MB of `/tmp` scratch space.
  `/tmp` is not durable backup storage.
  ([Function runtimes: filesystem support](https://vercel.com/docs/functions/runtimes#file-system-support))

### Reliability conclusion

Vercel Cron provides neither exactly-once execution nor a successful-at-least-once backup:
duplicates are possible, failures are not retried, and overlapping runs are possible. A daily Vercel
Cron alone therefore cannot guarantee daily backup completion.

### Implications for the scheduler adapter

1. Keep the backup command/runbook independent of Vercel. A Vercel endpoint, if used, is only one
   authenticated scheduler adapter around the same operation.
2. Give each intended backup interval a stable idempotency key (for example its UTC backup date).
   Atomically claim that key in persistent storage, use a lease/lock to prevent overlap, and make a
   duplicate invocation return the existing run state instead of creating another artifact.
3. Persist `started`, `completed`, and `failed` run states outside the Function filesystem. A
   `completed` state must point to the durable artifact and manifest. An abandoned `started` lease
   must be detectable and safely reclaimable.
4. Monitor the age of the last completed backup independently of the trigger. Alert before it can
   exceed 24 hours, and expose an authenticated manual/catch-up invocation because Vercel will not
   retry a failure.
5. Stream or upload the archive to durable object storage within the function's time, disk, and
   payload limits; never treat `/tmp` as the retained copy. If representative data cannot complete
   with margin inside the configured Function limit, run the same provider-neutral backup command
   on a longer-lived job runner and let Cron trigger only that durable workflow.

## Vercel observability and monthly availability

### What Vercel records

- Vercel Observability is event/request based. Its Function view provides invocation count, error
  rate, performance, and route breakdowns; the External APIs view separately shows outbound host
  request volume, p75 latency, and error rate.
  ([Observability](https://vercel.com/docs/observability),
  [Observability Insights](https://vercel.com/docs/observability/insights))
- Runtime Logs can be filtered by production/preview, request path or route, method, status, and
  request ID. Log Drain records expose a unique log `id`, timestamp, source, path, environment,
  request ID, and status code; `-1` means the Function returned no response/crashed. Drain sampling
  rules can select environment and path prefixes, and unmatched requests are dropped. No sampling
  rules means 100% is forwarded.
  ([Runtime Logs](https://vercel.com/docs/logs/runtime),
  [Log Drains reference](https://vercel.com/docs/drains/reference/logs))
- Native Runtime Log retention is plan-dependent: currently 1 hour on Hobby, 1 day on Pro, 3 days
  on Enterprise, and 30 days with Observability Plus; the Plus UI can inspect at most 14 consecutive
  days at a time. Vercel's shared-responsibility guidance assigns long-term retention and additional
  visibility to customer-configured drains.
  ([Runtime Log limits](https://vercel.com/docs/logs/runtime#limits),
  [shared responsibility](https://vercel.com/docs/security/shared-responsibility))
- Vercel's built-in anomaly alert is not a fixed SLO alert: its documented error alert compares a
  five-minute 5xx rate with a 24-hour baseline and statistical threshold.
  ([Alerts](https://vercel.com/docs/alerts))
- Vercel's Enterprise SLA uses a monthly minute-based platform-availability formula, excludes
  third-party failures and other excused downtime, and is not an automatic measurement of this
  application's own 99.5% backend SLO.
  ([Vercel Enterprise SLA](https://vercel.com/legal/sla))

The Log Drain reference describes forwarding and supplies a unique event id, but does not state an
exactly-once or complete-delivery guarantee. Do not silently promote a drain into the sole source of
truth for an availability audit; deduplicate received events by id and monitor the drain itself.

### Implications for the 99.5% backend SLO

1. Publish the SLI definition in code/config: production Marketplace API route allowlist,
   measurement interval, what constitutes a valid opportunity, good status classes, exclusions,
   and missing-probe treatment. Do not use a whole-project dashboard whose route population can
   change unnoticed.
2. Retain a provider-neutral monthly rollup outside Vercel's short native log window. If Log Drains
   feed the rollup, forward 100% of the allowlisted production API paths, deduplicate by event id,
   and alarm on ingestion gaps. Preserve the numerator, denominator, exclusions, and source-window
   coverage so the result is reproducible rather than a screenshot.
3. Request-derived error rate cannot observe an outage during a zero-traffic minute. Add an
   independent synthetic probe of a representative read-only health/API path at a fixed cadence,
   persist every expected probe slot, and count a missing or unsuccessful probe according to the
   published SLI. This supplies time coverage while actual request telemetry supplies user-impact
   coverage.
4. Compute the monthly value from eligible observations, not from Vercel's Enterprise SLA. For a
   minute-based calendar-month SLO, 99.5% permits at most 0.5% bad measured minutes (about 3 hours
   36 minutes in a 30-day month); store exact calendar boundaries in UTC.
5. Exclude TONE3000 by an explicit boundary, not by manually deleting slow samples. Keep its
   download/proxy route out of the Marketplace API allowlist and tag its outbound span/metric as an
   external dependency. Vercel already exposes external APIs separately by host; use that view for
   dependency health. If a Marketplace API synchronously waits for TONE3000, whole-Function
   duration includes that wait, so instrument an application-owned server-processing duration or
   redesign the download path before claiming the site's p95.
6. Alerts and runbooks should cover fixed SLO burn/thresholds, synthetic-probe gaps, drain gaps,
   backup age, backup failure, and restore-drill failure. Vercel's anomaly alert and cron logs are
   useful diagnostics, but neither independently proves the monthly SLO or daily backup objective.

## Minimum evidence package for #37

The source constraints above imply that a repeatable verification package should preserve:

- the backup/restore scripts and pinned PostgreSQL client version;
- each backup run manifest, artifact digest/location, and completion state;
- restore-drill commands, timings, target environment, row/domain invariant results, and projection
  rebuild results;
- the versioned availability-SLI route allowlist and exclusion rules;
- raw or durable rollups for every calendar-month interval, plus synthetic probe results and
  telemetry-ingestion coverage;
- alert definitions and evidence that duplicate cron calls, failed calls, overlapping calls, stale
  backups, and missing telemetry are handled.

This package is what can prove RPO 24 hours, RTO 8 hours, and monthly 99.5% backend availability.
Vercel's scheduler, dashboard, SLA, and internal disaster-recovery backups are supporting signals,
not substitutes for that evidence.
