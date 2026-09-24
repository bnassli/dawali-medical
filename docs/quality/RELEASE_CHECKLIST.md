# Release Checklist

Record evidence or `N/A` with a reason for every item. An unchecked or unavailable critical control blocks production release unless a named owner explicitly accepts the risk and records an expiry date.

## Scope and design

- [ ] Release scope and out-of-scope items are documented.
- [ ] Clinical/business rules and applicable `INV-*` identifiers are identified.
- [ ] Architecture changes have an ADR.
- [ ] Clinical terminology and workflow received human domain acceptance.

## Data and migrations

- [ ] Schema changes have versioned migrations and suitable constraints.
- [ ] Migration was rehearsed on representative data.
- [ ] Forward recovery, rollback, and reconciliation were tested.
- [ ] No destructive change can silently erase clinical history.

## Security and privacy

- [ ] Authentication, named permissions, and object-level authorization were tested negatively.
- [ ] Session, rate-limit, secret, logging, and dependency controls were reviewed.
- [ ] Patient file storage and download paths remain private.
- [ ] Logs and audit payloads contain no passwords, tokens, secrets, or unnecessary protected data.

## Correctness and resilience

- [ ] Static, unit, PostgreSQL integration, and application integration checks pass.
- [ ] Applicable invariant/property tests pass.
- [ ] Applicable duplicate, retry, concurrency, and partial-failure tests pass.
- [ ] Performance thresholds pass for representative data volume.
- [ ] Observability and alerts cover new critical failure modes.

## Recovery and deployment

- [ ] Database and patient-file backups completed.
- [ ] A restore rehearsal and database/object reconciliation passed within the agreed recovery objectives.
- [ ] Deployment and rollback procedures were exercised in staging.
- [ ] Post-deployment smoke tests and rollback decision owner are defined.

## Sign-off

- Release/version:
- Commit:
- Evidence links:
- Known limitations and accepted risks:
- Clinical/domain approver:
- Engineering approver:
- Release date:
