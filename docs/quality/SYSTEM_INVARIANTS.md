# System Invariants

These properties must remain true regardless of UI path, retries, concurrency, imports, integrations, or failures. Each invariant must eventually have an automated test at the lowest reliable layer, plus an integration test for critical workflows.

## Identity and relationships

- **INV-ID-001:** Every Patient has one immutable internal UUID. No external identifier is a primary key.
- **INV-ID-002:** Within one external system, an external patient identifier maps to at most one internal Patient.
- **INV-ID-003:** Every Visit belongs to exactly one existing Patient.
- **INV-ID-004:** A clinical entry, procedure, diagram, report, or patient file cannot be associated with a Patient different from the Patient owning its Visit.
- **INV-ID-005:** A requested object identifier never bypasses authorization or changes the authorized patient scope.

## Clinical history and versioning

- **INV-HIST-001:** Historical Visits are never overwritten as a substitute for a new Visit or follow-up entry.
- **INV-HIST-002:** Finalized Reports are immutable. Any correction creates a new amended version linked to the prior version.
- **INV-HIST-003:** Saved Diagram versions are immutable and never replace their base template or an earlier saved version.
- **INV-HIST-004:** Clinically meaningful deletion is privileged, reasoned, and audited; ordinary deletion cannot erase history.
- **INV-HIST-005:** Every material clinical mutation produces exactly one corresponding audit event in the same successful transaction.

## Authorization and privacy

- **INV-AUTH-001:** An unauthenticated request cannot read or mutate protected data.
- **INV-AUTH-002:** A user lacking the named permission cannot perform the operation through UI, server action, API, or direct identifier manipulation.
- **INV-AUTH-003:** Inactive users cannot create new authenticated activity, even if an unexpired session row exists.
- **INV-AUTH-004:** Patient files are never publicly readable and never exposed through permanent unauthenticated URLs.
- **INV-AUTH-005:** Passwords, tokens, secrets, and private file credentials never appear in logs or audit payloads.

## Atomicity, retries, and concurrency

- **INV-TXN-001:** A failed Patient, Visit, clinical artifact, Diagram, Report, or File operation leaves no partial domain record or misleading success audit.
- **INV-TXN-002:** Repeating an idempotent critical command with the same key produces the effect of one command.
- **INV-TXN-003:** Concurrent saves never silently discard a previously committed clinical change.
- **INV-TXN-004:** A transaction cannot commit an artifact whose required parent or version is missing.

## Files, reports, and recovery

- **INV-FILE-001:** Every stored patient object has a database record containing patient/visit ownership where applicable, checksum, size, media type, version/status, creator, and timestamps.
- **INV-FILE-002:** The stored object checksum matches the database metadata before the file is trusted or finalized.
- **INV-FILE-003:** A database restore and object-store restore reconcile without orphaned finalized records or files.
- **INV-REC-001:** A backup is not marked usable until restore and invariant validation succeed.

## Current enforcement status

Use this status vocabulary in reviews: `DB`, `application`, `automated test`, `manual control`, or `not yet enforced`. A sprint may introduce an invariant before its future module exists, but no implemented feature may be called complete while an applicable invariant remains `not yet enforced` without an explicit accepted risk.
