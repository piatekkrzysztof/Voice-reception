#!/bin/sh
set -eu

backup_dir="${BACKUP_DIR:-/backups}"
restore_database="voice_reception_restore_check"
backup_file="${BACKUP_FILE:-}"

if [ -z "$backup_file" ]; then
  backup_file="$(find "$backup_dir" -maxdepth 1 -type f -name 'voice-reception-*.dump' | sort -r | head -n 1)"
fi

case "$backup_file" in
  "$backup_dir"/voice-reception-*.dump) ;;
  *) echo "BACKUP_FILE musi wskazywać plik .dump w $backup_dir." >&2; exit 2 ;;
esac

if [ ! -f "$backup_file" ]; then
  echo "Nie znaleziono backupu: $backup_file" >&2
  exit 2
fi

if [ -f "${backup_file}.sha256" ]; then
  sha256sum -c "${backup_file}.sha256"
fi

cleanup() {
  dropdb --if-exists "$restore_database" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup
createdb "$restore_database"
pg_restore --exit-on-error --no-owner --no-privileges --dbname "$restore_database" "$backup_file"

tables="$(psql --dbname "$restore_database" --tuples-only --no-align --command "
  SELECT COUNT(*) FROM pg_catalog.pg_tables
  WHERE schemaname = 'public' AND tablename IN ('voice_services','voice_holds','voice_bookings','voice_calls','voice_events','voice_admins','voice_sessions');
")"

if [ "$tables" != "7" ]; then
  echo "Odtworzona baza ma niepełny schemat: $tables/7 tabel." >&2
  exit 1
fi

echo "Backup poprawnie odtworzony w bazie kontrolnej: $backup_file"
