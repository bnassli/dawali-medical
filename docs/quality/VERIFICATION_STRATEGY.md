# Verification Strategy

Verification is evidence that the implementation preserves the intended clinical and operational rules. Code volume, schema size, passing compilation, and an agent's confidence are not evidence of correctness by themselves.

## Test layers

1. **Static checks:** TypeScript strict, lint, dependency and secret scanning.
2. **Unit tests:** validation, state transitions, permission decisions, and pure domain rules.
3. **PostgreSQL integration tests:** migrations, constraints, transactions, audit coupling, and repository behavior against the real database.
4. **Application integration tests:** authentication, server actions/APIs, object-level authorization, and file access.
5. **Invariant/property tests:** generated sequences preserve every applicable `INV-*` property.
6. **Concurrency and failure tests:** simultaneous saves, duplicate requests, retries after timeout, deadlocks, process interruption, database/storage unavailability, and partial dependencies.
7. **Security tests:** IDOR, privilege escalation, session handling, CSRF assumptions, brute force/rate limiting, injection, unsafe upload, and sensitive-data leakage.
8. **Performance tests:** representative and worst-reasonable patient/search/history/file workloads with explicit latency and resource thresholds.
9. **Recovery tests:** database plus object-store restore, migration rollback/forward recovery, and reconciliation.
10. **Human acceptance:** clinicians verify terminology, workflow, report content, and rules that cannot be inferred safely from code.

## Required critical flows

- Login → search/create Patient → open/create Visit → Patient Chart → logout.
- Patient creation and Visit creation each commit their audit record atomically.
- Direct access without authentication is denied.
- Each role is denied operations outside its permission set.
- Changing a patient, visit, report, diagram, or file identifier cannot cross the authorized object boundary.
- Duplicate submission does not create duplicate critical records.
- Concurrent clinical edits are detected or safely serialized.
- Diagram and Report finalization preserve previous versions.
- Private patient file upload/download verifies ownership and checksum.
- Backup restore reconstructs a consistent database/object set.

## Evidence required in a change report

- Requirement and applicable `INV-*` identifiers.
- Tests added or updated and the layer each test covers.
- Exact checks executed and their results.
- Migration rehearsal and reconciliation result when the schema or data changes.
- Security/privacy analysis.
- Tests not run, environment limitations, accepted risks, and owner of follow-up.

## Test quality rules

- A mock-based test cannot prove database constraints, transaction atomicity, SQL behavior, or production audit writes.
- A UI test cannot replace server-side authorization tests.
- Happy-path coverage cannot replace denial and failure-path coverage.
- Do not use production medical data in development or CI.
- Test fixtures must be deterministic, isolated, and safe to rerun.
- CI must fail closed when a required check does not run or cannot connect to its required service.
