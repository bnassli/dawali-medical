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
  role differences. CI installs Chromium; locally set `PW_CHANNEL=chrome`.

Core target smoke flow:
Login → Search/Create Patient → Open/Create Visit → Patient Chart → Save clinical data → Create Diagram → Generate Report → Logout.
