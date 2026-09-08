# Backup and restore

OriginPost's durable state spans PostgreSQL and private S3-compatible object storage. Redis contains rebuildable queues and caches; it is not restored as workflow truth. A useful backup must contain a PostgreSQL archive and every current media object with its exact key, bytes, content type, and OriginPost metadata.

## Local Compose backup

The bundled workflow is for the single-host Compose topology. Stop every writer first so the database and object inventory share one quiet backup boundary:

```bash
docker compose stop web api worker
backup_dir="$(mktemp -d)/originpost-backup"
pnpm run ops:backup -- --output "$backup_dir"
docker compose --profile app --profile malware-scan up -d api worker web clamav
```

The output directory must be new, absolute, and outside the public repository. The command refuses to run while API, worker, web, or Telegram services are active. PostgreSQL and MinIO remain available during capture.

The backup contains:

- `postgres.dump`: a compressed PostgreSQL custom-format archive with ownership and ACL statements omitted;
- `objects/`: one opaque file per current object;
- `manifest.json`: application version, migration/count inventory, original object keys, SHA-256, sizes, content headers, and metadata;
- `SHA256SUMS`: checksums for the database archive, object files, and manifest.

The backup fails if any currently usable (`ready` plus malware `clean`/local `disabled`) Media Asset is absent from object storage. The manifest separately lists missing references belonging to already unavailable, rejected, deleted, or legacy local records; investigate that warning, but it cannot make those records publishable.

Backups are sensitive. Database archives contain user-authored content and encrypted provider records; object files contain private media. Keep deployment encryption keys separately in an approved secret manager, encrypt backup storage, restrict access, define retention, and test key recovery. Never commit a backup or its manifest.

## Non-destructive restore drill

Test every backup before depending on it:

```bash
pnpm run ops:restore-drill -- --backup "$backup_dir"
```

The drill validates the checksum inventory and every file, starts disposable PostgreSQL 16 and MinIO containers with random credentials and isolated volumes, restores the database and objects, compares migration/critical-row inventories, rereads every object, verifies its SHA-256/content type/metadata, checks usable Media Asset references, and then removes the exact temporary containers and volumes. It never writes to the live database or bucket. Checksums detect accidental corruption; use authenticated/encrypted backup storage to detect malicious replacement.

A successful command returns `verified: true`. A dump existing on disk without a successful restore drill is not accepted recovery evidence.

## Production topology

Do not copy this single-host procedure blindly to a clustered or managed deployment:

- Use the database provider's point-in-time recovery and tested restore procedure in addition to logical archives.
- Use bucket/version/site replication appropriate to the object-store provider. MinIO documents site replication as its primary business-continuity/disaster-recovery mechanism; `mc mirror` covers only current object versions and is not equivalent to version-aware replication.
- Coordinate one application write boundary or a documented reconciliation strategy across PostgreSQL and object storage.
- Keep backups in a separate failure domain, monitor freshness and replication lag, and rehearse recovery with stated recovery-point and recovery-time objectives.
- After a real restore, rotate exposed credentials, run all migrations, verify media-reference integrity, start the API before workers, and keep live publishing disabled until a watched recovery check passes.

Primary references: [PostgreSQL `pg_dump`](https://www.postgresql.org/docs/16/app-pgdump.html), [Docker volume backup and restore](https://docs.docker.com/engine/storage/volumes/#back-up-restore-or-migrate-data-volumes), and [MinIO availability and disaster recovery](https://min.io/docs/minio/container/operations/concepts/availability-and-resiliency.html).
