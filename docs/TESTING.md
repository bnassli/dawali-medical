# Testing Strategy
Risk-based testing to keep delivery fast.

High-priority automated tests:
- authentication
- permissions
- patient creation/search
- visit creation
- patient/visit separation
- clinical save/load
- audit log
- diagram save/versioning
- report generation
- correct patient/visit association
- finalized report versioning

Low priority: cosmetic spacing, static labels, broad snapshot tests.

Sprint 2 additions:
- Vitest (`npm test`, real PostgreSQL): clinical save/load, append-only trigger,
  option lists, permissions per role, visit lock, optimistic concurrency,
  idempotent replays, Route Handler status mapping, Reason-for-Visit backfill,
  client autosave engine (fake timers/fetch).
- Playwright E2E (`npm run build && npm run test:e2e`, production build + real
  PostgreSQL, no retries): exact field order, selection persistence, permanent
  vs visit-only options, keyboard operation, concurrent conflict, session expiry
  with pending text, reload/navigation flush, Reason for Visit single source,
  role differences, unsaved-changes guard on in-app links and Logout (session
  expired, server unreachable, conflict, locked, pending flush, explicit
  discard, keyboard/focus in the dialog), actor change on the same browser,
  V1 -> V2 -> V1 visit switching, intake reason length, retired fields.
  CI installs Chromium; locally set `PW_CHANNEL=chrome`.
- Migration tests (Vitest, real PostgreSQL): Reason-for-Visit backfill —
  trimming, idempotency, over-limit abort without truncation, table lock
  (`pg_locks`, plus a real blocked-writer test), skipped-audit for every
  pre-existing reason case, verification abort, ASCII-only file.
- Definitions tests: global field uniqueness, one concept in two tabs, shared
  option lists, seed refuses structural drift, retired fields stay visible.

Sprint 3A additions:
- Vitest (`test/clinical-sprint3a.test.ts`, real PostgreSQL): tab list and exact per-tab
  field order/labels/types, Subj unchanged (explicit fieldCodes), Family Medical Hx =
  `family_history` (one field, one version stream), independent option lists, Impression/
  Recommendations options + visit-only text, independent Stockings fields, Unknown
  exclusivity (both directions, free text counts, per visit, clearing always allowed,
  already-inconsistent data resolvable, concurrent saves cannot both win, no write and no
  audit on refusal), checkbox validation/no-op/replay, permissions per role, visit lock,
  optimistic concurrency, Route Handler mapping (409 `exclusive_value`, 400 for `checked`
  misuse), seed label overrides cosmetic + idempotent, definitions guards (relabel of an
  unplaced field, exclusion-rule consistency, no female-specific field).
- `test/autosave-client.test.ts`: checkbox `checked` round-trip; 409 `exclusive_value` is a
  rejection (text kept), not a version conflict.
- Playwright (`e2e/clinical-tabs.spec.ts`): tab order and exact field order per tab (one form
  rendered), unknown tab 404, persistence per tab, Family Medical Hx sharing, Stocking
  independence, Unknown exclusivity UI + stale-page server refusal, tab-switch unsaved guard
  (Stay / Retry / explicit discard / pending flush), permissions per role.

Core target smoke flow:
Login → Search/Create Patient → Open/Create Visit → Patient Chart → Save clinical data → Create Diagram → Generate Report → Logout.
