# Dawali Medical System — V1
Web-based medical system preserving the familiar SonoSoft workflow while modernizing architecture, storage, reporting, auditing, and future integrations.

## First milestone
Login → Patient Search → Create/Open Patient → Create/Open Visit → Patient Chart Shell → Logout

See `/docs`, `CLAUDE.md`, and `PROMPT_SPRINT_1.md`.

## Sprint 1 — Setup

### Prerequisites
- Node.js 24, npm 11
- A PostgreSQL 16 instance for local dev — either:
  - `docker-compose up -d` (starts `postgres` on `localhost:5432`), or
  - any PostgreSQL 16 instance you already have.

### Environment
Copy `.env.example` to `.env` and fill in real values. `.env` is
git-ignored and must never be committed.

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dawali_medical
NODE_ENV=development
SESSION_TTL_HOURS=12
SEED_ADMIN_EMAIL=admin@example.com
SEED_ADMIN_PASSWORD=change-me-please
```

`SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` are only required when you want
`npm run db:seed` to bootstrap the initial admin user — there is no
default password baked into the code. If you set one of the two, you must
set both. The admin is created only if no user with that email exists;
re-running the seed never resets an existing password, re-activates a
disabled account or changes its roles.

### Install, migrate, seed, run
```
npm install
npm run db:migrate   # applies the committed SQL migrations in ./drizzle
npm run db:seed      # idempotent: seeds roles/permissions and (if configured) the admin user
npm run dev           # http://localhost:3000
```

Log in with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`. The admin role has
every Sprint 1 permission, including `/admin/users`.

### Other scripts
```
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # vitest run — integration tests against a real PostgreSQL
npm run db:generate  # drizzle-kit generate (after changing src/db/schema/*)
npm run db:validate  # fresh-database migration + schema-drift check
npm run build         # production build (no DATABASE_URL required at build time)
```

`npm test` and `npm run db:validate` need a real PostgreSQL to run
against. If `TEST_DATABASE_URL` is set, they use it (this is how CI runs
them, against a `postgres` service container — see
`.github/workflows/ci.yml`). Otherwise they start a throwaway
`embedded-postgres` instance automatically — no Docker or local `psql`
required.

### Known limitations
- **Windows + Administrator account**: real PostgreSQL refuses to start
  under a Windows process token that holds the built-in Administrator
  group ("Execution of PostgreSQL by a user with administrative
  permissions is not permitted"). If your shell/user has that token (some
  sandboxes and VMs run every process this way even without an explicit
  "Run as administrator"), the automatic `embedded-postgres` fallback used
  by `npm test` / `npm run db:validate` will fail with that message. Fixes,
  in order of preference:
  1. Run the command from a standard (non-administrator) Windows user.
  2. Set `TEST_DATABASE_URL` to a real reachable PostgreSQL instance (e.g.
     the one started by `docker-compose up -d`, or a Postgres inside WSL).
  3. Run inside WSL / Linux, where this restriction does not apply.
  4. Quick local fallback with no install: serve an in-memory PGlite
     (PostgreSQL compiled to WASM) over the wire protocol, then point
     `TEST_DATABASE_URL` at it:
     `npm i --no-save @electric-sql/pglite @electric-sql/pglite-socket`
     `npx pglite-server --port=54331 --max-connections=50`
     `TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54331/postgres?sslmode=disable" npm test`
     Use a fresh server per run. CI remains the authoritative gate.
  This does not affect `.github/workflows/ci.yml`, which always uses a
  real `postgres` service container.
- `docker-compose.yml` is provided for local development but has not been
  exercised in the Sprint 1 sandbox (no Docker available there); it uses a
  standard, unmodified `postgres:16` image and should work as-is anywhere
  Docker is available.
- Clinical tabs, diagrams, reports, iCare integration, and inventory are
  explicitly out of scope for Sprint 1 (see `PROMPT_SPRINT_1.md`). The
  Patient Chart page renders a neutral "Clinical tabs arrive in later
  sprints" placeholder only.

## Engineering quality gates

All work must also follow the project quality gates:

- [`docs/quality/ENGINEERING_STANDARDS.md`](docs/quality/ENGINEERING_STANDARDS.md)
- [`docs/quality/SYSTEM_INVARIANTS.md`](docs/quality/SYSTEM_INVARIANTS.md)
- [`docs/quality/VERIFICATION_STRATEGY.md`](docs/quality/VERIFICATION_STRATEGY.md)
- [`docs/quality/RELEASE_CHECKLIST.md`](docs/quality/RELEASE_CHECKLIST.md)
