#!/usr/bin/env bash
# Restore a backup made by backup.sh (R6a, ADR-036). REPLACES the current database and
# patient files with the backup's. Usage: deploy/restore.sh deploy/backups/2026-09-26_0230
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:?usage: restore.sh <backup folder>}"
FILES_DIR="${FILES_DIR:-$HERE/data/files}"
( cd "$SRC" && sha256sum --check --quiet SHA256SUMS )

if [[ "${CONFIRM:-}" != "yes" ]]; then
  read -r -p "This REPLACES the current database and files with $SRC. Type yes to continue: " answer
  [[ "$answer" == "yes" ]] || { echo "cancelled"; exit 1; }
fi

if [[ -n "${DATABASE_URL:-}" ]]; then
  pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$SRC/database.dump"
else
  docker compose -f "$HERE/docker-compose.yml" stop app
  docker compose -f "$HERE/docker-compose.yml" exec -T db pg_restore -U dawali --clean --if-exists --no-owner -d dawali <"$SRC/database.dump"
fi

# Files: keep the replaced ones aside instead of deleting them.
if [[ -d "$FILES_DIR" ]] && [[ -n "$(ls -A "$FILES_DIR" 2>/dev/null)" ]]; then
  mv "$FILES_DIR" "$FILES_DIR.before-restore-$(date +%Y%m%d%H%M%S)"
fi
mkdir -p "$FILES_DIR"
tar -C "$FILES_DIR" -xzf "$SRC/files.tar.gz"

[[ -n "${DATABASE_URL:-}" ]] || docker compose -f "$HERE/docker-compose.yml" start app
echo "restore ok from $SRC"
