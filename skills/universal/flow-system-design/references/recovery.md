# Backup and recovery

Read this when a change adds a datastore, stores data that cannot be regenerated (user input, payments, paid generations), or deletes or rewrites data in bulk.

## Set the targets

- **RPO** (recovery point objective): how much recent data you can afford to lose. **RTO** (recovery time objective): how long the service can be down while you restore. Choose them per datastore; they decide everything below. Google Cloud DR planning guide: https://docs.cloud.google.com/architecture/dr-scenarios-planning-guide
- Classify data: regenerable (caches, derived tables, paid generations you could re-run at a known cost) versus irreplaceable. Back up the irreplaceable; for the regenerable, record the cost to rebuild.

## Backups

- Turn on automated backups and point-in-time recovery for the primary database; PITR gives an RPO of minutes. Cloud SQL: https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/pitr
- Keep at least one backup copy outside the blast radius of an operator mistake: a separate project or account, or object storage with retention lock, so a deleted database does not take its backups with it.
- Back up object storage with versioning and a lifecycle rule, not just the database.
- Secrets and infrastructure config belong in version control or a secret manager, so the environment can be rebuilt, not restored.

## Restore is the test

An untested backup is a hope. Restore to a scratch instance on a schedule (at least once per quarter, and after any backup config change), time it against the RTO, and check row counts. AWS reliability pillar on testing recovery: https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/plan-for-disaster-recovery-dr.html

## Destructive changes

- Bulk deletes and rewrites run as a job that first writes what it will change (or soft-deletes), so the change can be reversed without a full restore.
- Take an on-demand backup immediately before an irreversible migration.

## In the plan

The plan's Runtime design carries a `**Recovery:**` line, and the task that creates the store sets up backups, point-in-time recovery or versioning plus a restore check. Reading this page is not enough: planners have read it and still left both out of the Task breakdown, and flow-plan-lint checks for them.

## Proportionality

A pre-launch app needs automated backups plus PITR and one tested restore. Multi-region replicas and warm standby belong to RTOs of minutes, which few early products need.
