#!/usr/bin/env bash
# Daily backup of Dawali Medical (R6a, ADR-036): the database (pg_dump custom format)
# and the private patient files, into deploy/backups/YYYY-MM-DD_HHMM/.
# Keeps KEEP_DAYS days locally; if OFFSITE_DIR is set (external disk / NAS / synced
# folder) the backup is also copied there, encrypted with GPG when
# BACKUP_GPG_RECIPIENT is set.
#
# Run from cron, e.g.:  30 2 * * *  /opt/dawali/deploy/backup.sh >> /var/log/dawali-backup.log 2>&1
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BACKUP_ROOT="${BACKUP_ROOT:-$HERE/backups}"
FILES_DIR="${FILES_DIR:-$HERE/data/files}"
KEEP_DAYS="${KEEP_DAYS:-30}"
STAMP="$(date +%Y-%m-%d_%H%M)"
DEST="$BACKUP_ROOT/$STAMP"
mkdir -p "$DEST"

# Database: through the running db container, or directly when DATABASE_URL is set.
if [[ -n "${DATABASE_URL:-}" ]]; then
  pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" --file="$DEST/database.dump"
else
  docker compose -f "$HERE/docker-compose.yml" exec -T db pg_dump -U dawali --format=custom --no-owner dawali >"$DEST/database.dump"
fi

# Patient files (write-once, so a plain archive is enough).
tar -C "$FILES_DIR" -czf "$DEST/files.tar.gz" .

( cd "$DEST" && sha256sum database.dump files.tar.gz >SHA256SUMS )
# Refuse to call it a backup if the dump cannot be read back.
pg_restore --list "$DEST/database.dump" >/dev/null
echo "backup ok: $DEST ($(du -sh "$DEST" | cut -f1))"

if [[ -n "${OFFSITE_DIR:-}" ]]; then
  mkdir -p "$OFFSITE_DIR"
  if [[ -n "${BACKUP_GPG_RECIPIENT:-}" ]]; then
    tar -C "$BACKUP_ROOT" -cf - "$STAMP" | gpg --batch --yes --encrypt --recipient "$BACKUP_GPG_RECIPIENT" --output "$OFFSITE_DIR/dawali_$STAMP.tar.gpg"
  else
    cp -r "$DEST" "$OFFSITE_DIR/"
  fi
  echo "offsite copy ok: $OFFSITE_DIR"
fi

# Local retention.
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} +
