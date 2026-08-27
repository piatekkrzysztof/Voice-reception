#!/bin/sh
set -eu

umask 077
backup_dir="${BACKUP_DIR:-/backups}"
retention_days="${BACKUP_RETENTION_DAYS:-14}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="${backup_dir}/voice-reception-${timestamp}.dump"
temporary="${target}.partial"

case "$retention_days" in
  *[!0-9]*|'') echo "BACKUP_RETENTION_DAYS musi być dodatnią liczbą całkowitą." >&2; exit 2 ;;
esac
if [ "$retention_days" -lt 1 ]; then
  echo "BACKUP_RETENTION_DAYS musi wynosić co najmniej 1." >&2
  exit 2
fi

mkdir -p "$backup_dir"
trap 'rm -f "$temporary"' EXIT

pg_dump --format=custom --compress=6 --no-owner --no-privileges --file "$temporary"
pg_restore --list "$temporary" >/dev/null
mv "$temporary" "$target"
sha256sum "$target" > "${target}.sha256"
find "$backup_dir" -type f \( -name 'voice-reception-*.dump' -o -name 'voice-reception-*.dump.sha256' \) -mtime "+${retention_days}" -delete

echo "Backup utworzony i sprawdzony: $target"
