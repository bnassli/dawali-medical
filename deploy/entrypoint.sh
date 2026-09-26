#!/bin/sh
# Container start: apply migrations, run the idempotent seed, then serve.
set -e
npm run db:migrate
npm run db:seed
exec npx next start -p "${PORT:-3000}"
