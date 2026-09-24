# Engineering Standards

This document is the engineering constitution for Dawali Medical. It applies to humans and coding agents. When a delivery shortcut conflicts with patient safety, data integrity, privacy, auditability, or recoverability, these standards take precedence.

## Definition of done

A feature is not complete merely because its page renders, its happy path works, or the application builds. It is complete only when:

1. The business and clinical rules are explicit.
2. The applicable invariants in `SYSTEM_INVARIANTS.md` are preserved.
3. Authorization is enforced on the server and at object level where applicable.
4. Database integrity is enforced with suitable PK, FK, UNIQUE, CHECK, NOT NULL, and transaction boundaries.
5. Material medical-data changes are auditable.
6. Automated tests cover the happy path and material failure paths.
7. Migrations, rollback/recovery implications, observability, and known risks are documented.
8. Typecheck, lint, tests, and production build pass.

## Data and domain integrity

- Use internal UUIDs for core entities. External identifiers such as an iCare number are attributes with explicit source and uniqueness rules.
- Keep Patient, Visit, clinical entry, Procedure, Diagram, Report, and File as separate entities with explicit relationships.
- Enforce relationships in PostgreSQL, not only in forms or service code.
- A child clinical artifact must derive its patient identity through its owning visit wherever practical. If `patient_id` is duplicated for indexing, validate consistency in the database or the same transaction.
- Store controlled states with enumerated or checked values and validate every allowed transition.
- Do not hard-delete clinical history through ordinary product flows. Use archive, soft-delete, reversal, correction, or amendment semantics defined for that entity.
- Normalize and constrain identifiers that are logically case-insensitive, including user email and external-system keys.
- Every migration is versioned, reviewed, forward-tested, and validated against representative data. Destructive migrations require backup, rollback, and reconciliation plans.

## Transactions, retries, and concurrency

- Operations that create a clinical record and its audit event must be atomic.
- Define the transaction boundary before implementing multi-step writes.
- Retried commands must not create duplicate visits, reports, files, or audit events. Use an idempotency key for externally retryable critical commands.
- Concurrent edits must not silently overwrite one another. Use optimistic version checks, row locking, or append-only versions according to the workflow.
- Never hide partial failure. Record and expose a recoverable state with enough context for safe retry or reconciliation.

## Authentication and authorization

- Default to denial. Grant only named permissions needed by each role.
- Enforce permissions in server-side application services; hiding a UI control is not authorization.
- Enforce object-level access for every patient, visit, report, diagram, and file lookup. Never trust an identifier supplied by the client as proof of access.
- Re-check authorization on mutations even if the page was previously authorized.
- Sessions use unpredictable tokens, secure cookie settings in production, expiry, revocation, and inactive-user enforcement.
- Authentication endpoints require rate limiting and security event logging before production exposure.
- Secrets never enter source control, logs, URLs, audit payloads, or client bundles.

## Audit and history

- Audit create, update, archive, finalize, amend, export/download, and privileged access where required by policy.
- Each event records actor, action, target, patient/visit context where applicable, time, and a safe before/after summary.
- Audit writes for a mutation occur in the same transaction as the mutation.
- Application roles must not update or delete audit rows. Administrative access and retention policy must be documented and monitored.
- Audit payloads must not contain passwords, session tokens, secrets, or unnecessary sensitive data.
- Finalized reports, saved diagrams, and clinically meaningful entries use append/version/amend semantics; they are never overwritten silently.

## Files and reports

- Patient files are private objects outside PostgreSQL. The database stores ownership, patient and visit association, media type, size, checksum, version, status, creator, and timestamps.
- File downloads use authenticated, short-lived access and object-level authorization. Public buckets and guessable permanent URLs are forbidden.
- Uploads validate size, type, content where feasible, checksum, and malware policy before becoming available.
- A finalized report is immutable. Corrections create an amended version linked to the version it supersedes.
- Backup and restore cover the database and object storage as one consistent recovery set.

## Testing and independent verification

- Tests must verify production paths, not only mocks that reproduce the expected result.
- Critical rules require integration or invariant tests against PostgreSQL and the real authorization layer.
- Include negative authorization, malformed input, duplicate requests, concurrent writes, timeout/retry, partial failure, migration, backup/restore, and reconciliation tests according to risk.
- A coding agent must not be the sole authority that its own work is correct. Acceptance relies on executable checks and human clinical/domain review.
- Never delete, weaken, skip, or rewrite a failing test solely to make a change pass.

## Operations and observability

- Log errors and critical workflow outcomes with correlation identifiers, without leaking protected medical data.
- Define alerts for repeated authentication failures, authorization denials, failed clinical writes, failed file operations, migration failures, and backup/restore failures.
- Backups are not considered valid until a restore rehearsal succeeds and reconciliation checks pass.
- Recovery objectives, retention, key management, dependency inventory, patching, and incident procedures must be documented before production launch.

## Change discipline

- Implement one bounded module or sprint at a time.
- Architecture changes require an ADR before implementation.
- State assumptions and ambiguities explicitly; do not invent clinical rules.
- Every change report lists affected modules, database/security/privacy impact, tests run, limitations, and residual risks.
