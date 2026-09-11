# Archive operation

Build and migrate before starting a new worker binary. Never run an older worker
alongside a version that adds job definitions. The API binds to loopback by default;
the false development session endpoint is removed. Set `WORKSPACE_TOKEN` in `.env`
to protect access when using a reverse proxy, and set `WEB_ORIGINS` to its exact
origin. Keep the API port private; use TLS at the proxy for a remote installation.

## This Mac

`node ops/supervisor.mjs` writes reviewable, validated LaunchAgent definitions in
`.reports/supervisor`. After building, migrating and stopping any terminal worker,
`node ops/supervisor.mjs --install` installs the archive worker and hourly backup
check. The worker restarts after exit; backup checks create one verified daily
backup. Jobs read `.env` without embedding credentials in the service definitions.
Inspect services with `launchctl print gui/$(id -u)/local.cryptopanel.worker`.

The supervised worker runs the compiled `apps/api/dist/worker.js` and does not
hot-reload. After changing worker or backtest code, rebuild and restart it, or
queued work (scheduled jobs, backtest runs) is never picked up:

```bash
pnpm --filter @crypto-panel/api build
launchctl kickstart -k gui/$(id -u)/local.cryptopanel.worker
```

LaunchAgents run while the user is logged in. They cannot collect while this Mac
is asleep, shut down, logged out, or Docker Desktop is stopped. This provides
local supervision, not an always-on hosting guarantee. Enable Docker Desktop at
login and keep the machine awake during desired coverage. The Data Health page
reports missing heartbeats and acquisition gaps after recovery.

The two service logs are under `.reports/supervisor`. Inspect these after updates.
After reviewing the generated definitions, `node --env-file-if-exists=.env ops/activate-local.mjs`
performs the local handoff: stops the named supervised worker and this
repository's terminal worker, applies migrations, requeues current bounded
failures, verifies a backup, enables PostgreSQL container restart and installs
the two LaunchAgents. Build first. The installer does not recreate the PostgreSQL
container or its volume. `node --env-file-if-exists=.env ops/verify-local.mjs --restart-test`
verifies recovery and saves a health report in `.reports`. If activation fails,
fix the reported error and rerun it; inspect the worker heartbeat before assuming
collection resumed.
Stage acceptance scripts are read-only and write dated evidence under
`docs/data`: `ops/verify-btc.mjs`, `ops/verify-btc-context.mjs`,
`ops/verify-overview.mjs` and `ops/verify-perp.mjs`. Each calls the local API,
checks that an uncovered replay cutoff is refused, and fails loudly instead of
writing a report.
To stop a service, use `launchctl bootout gui/$(id -u)/local.cryptopanel.worker`
(or `local.cryptopanel.backup`). Remove only these two named plist files from
`~/Library/LaunchAgents` to uninstall; this does not delete the archive.

## Linux host

`archive-worker.service` is a systemd template for an always-on host. Install the
repository at `/opt/crypto-panel`, build with the pinned pnpm version, run migrations,
create a dedicated `crypto-panel` service user, and configure `.env` with its
`DATABASE_URL` and optional provider keys. Adjust the Node executable path to the
installed supported release. Review ownership before enabling the unit.
Keep PostgreSQL on persistent storage and supervised by the host. Use native
`pg_dump`/`pg_restore` with the same verification and retention policy below if
PostgreSQL is hosted outside the local Compose service.

## Backup, retention and restore

`node --env-file-if-exists=.env ops/backup.mjs` targets the local Compose PostgreSQL
service. It writes a mode-600 custom-format dump under `.backups`, restores it to
an isolated temporary database, checks archive tables, then removes that temporary
database. Only after verification does it record a checksum, size and restore time
in Data Health. It keeps the latest seven generated backups. Failed verification
leaves the dump for diagnosis and exits nonzero. Production backups need an
additional copy on a separate machine or storage service.

Archive rows, revisions, provenance, discovery lifecycle evidence and gap records
are retained indefinitely; there is no automatic archive pruning. Monitor database
size on Data Health before increasing acquisition coverage. Do not truncate archive
tables or edit applied migrations. Provider request failures remain quota evidence.

For disaster recovery, stop the API and worker. Restore a verified dump into a new,
empty database with `pg_restore --exit-on-error --no-owner --dbname=NEW_DATABASE`.
Check migration versions, payload/snapshot counts and replay coverage before changing
`DATABASE_URL` to the restored database. Run migrations, restart the API and worker,
then verify health and replay. Keep the previous database until verification passes.
Never restore over the only surviving database. A backup on the same Mac protects
against database mistakes, but not loss of that machine.
