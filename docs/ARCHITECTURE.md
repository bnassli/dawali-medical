# Architecture
- Modular monolith
- Next.js + TypeScript strict
- PostgreSQL
- ORM with migrations
- Private S3-compatible object storage
- Docker
- GitHub private repo
- CI: typecheck/lint/tests/build
- Development / Staging / Production

Modules: auth, users, patients, visits, clinical, treatments, follow-up, laser-ablation, diagrams, reports, files, audit, integrations/icare, future inventory.

Use internal UUIDs. External IDs such as iCare file numbers are attributes, not PKs.
Store patient files privately in object storage; DB stores metadata, ownership, visit association, versions, audit info.
