#!/usr/bin/env bash
set -euo pipefail
umask 077
export PGPASSWORD="$(cat "${PGPASSWORD_FILE:?}")"
: "${RESTIC_REPOSITORY:?Set RESTIC_REPOSITORY in .env}"
: "${RESTIC_PASSWORD_FILE:?}"
mkdir -p /backup /restore
# A shared volume lock also prevents manual/cron jobs from racing on the dump.
exec 9>/backup/job.lock
flock -n 9 || { printf '%s\n' 'Another backup/recovery operation is running.' >&2; exit 1; }

number_setting() {
  local name="$1" default="$2" minimum="$3" maximum="$4" value
  value="${!name:-$default}"
  if [[ ! "$value" =~ ^[0-9]{1,9}$ ]]; then
    printf '%s must be an integer between %s and %s.\n' "$name" "$minimum" "$maximum" >&2
    return 1
  fi
  value=$((10#$value))
  if (( value < minimum || value > maximum )); then
    printf '%s must be an integer between %s and %s.\n' "$name" "$minimum" "$maximum" >&2
    return 1
  fi
  printf '%s\n' "$value"
}

free_kib() {
  local available
  available="$(LC_ALL=C df -Pk -- /backup | awk 'NR == 2 { print $4 }')" || return 1
  [[ "$available" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$available"
}

backup_dump_pid=''
backup_watcher_pid=''
backup_guard_marker=''
cleanup_dump() {
  if [[ -n "$backup_watcher_pid" ]]; then kill "$backup_watcher_pid" 2>/dev/null || true; wait "$backup_watcher_pid" 2>/dev/null || true; fi
  if [[ -n "$backup_dump_pid" ]]; then kill "$backup_dump_pid" 2>/dev/null || true; wait "$backup_dump_pid" 2>/dev/null || true; fi
  rm -f -- "$dump" "$backup_guard_marker"
}

guarded_dump() {
  local reserve_mib maximum_mib poll_seconds reserve_kib available dump_limit_kib database_bytes
  local status=0
  reserve_mib="$(number_setting BACKUP_MIN_FREE_MIB 20480 1 999999999)"
  maximum_mib="$(number_setting BACKUP_MAX_DUMP_MIB 0 0 999999999)"
  poll_seconds="$(number_setting BACKUP_DISK_POLL_SECONDS 1 1 60)"
  reserve_kib=$((reserve_mib * 1024))
  available="$(free_kib)" || { printf '%s\n' 'Cannot determine free backup filesystem space; backup refused.' >&2; return 1; }
  if (( available <= reserve_kib + 1024 )); then
    printf 'Backup refused: filesystem free space must exceed the %s MiB reserve plus dump space.\n' "$reserve_mib" >&2
    return 1
  fi
  # Leave an additional MiB for file/block rounding and this job's tiny metadata.
  dump_limit_kib=$((available - reserve_kib - 1024))
  if (( maximum_mib > 0 && maximum_mib * 1024 < dump_limit_kib )); then
    dump_limit_kib=$((maximum_mib * 1024))
  fi
  database_bytes="$(psql -X --tuples-only --no-align --set=ON_ERROR_STOP=1 \
    -c 'SELECT pg_database_size(current_database())')"
  [[ "$database_bytes" =~ ^[0-9]+$ ]] || { printf '%s\n' 'Cannot determine database size; backup refused.' >&2; return 1; }
  printf 'Database physical size: %s MiB; compressed dump limit: %s MiB; filesystem reserve: %s MiB.\n' \
    "$(((database_bytes + 1048575) / 1048576))" "$((dump_limit_kib / 1024))" "$reserve_mib" >&2
  # Physical DB size is informational: indexes/TOAST and compression mean that
  # neither it nor an assumed compression ratio can guarantee logical dump size.
  backup_guard_marker="$(mktemp /backup/disk-guard.XXXXXXXX)"
  trap cleanup_dump EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  (
    trap - EXIT INT TERM
    # Bash uses 1024-byte file-limit units outside POSIX mode. Restrict only the
    # pg_dump child, not restic or later restore commands.
    unset POSIXLY_CORRECT
    set +o posix
    ulimit -S -f "$dump_limit_kib"
    exec pg_dump --format=custom --compress=gzip:6 --no-owner --no-privileges --file="$dump"
  ) &
  backup_dump_pid=$!
  (
    trap - EXIT INT TERM
    while kill -0 "$backup_dump_pid" 2>/dev/null; do
      if ! available="$(free_kib)" || (( available <= reserve_kib )); then
        printf '%s\n' 'Backup aborted: filesystem reserve reached or free-space measurement failed.' >&2
        # Terminate even if another writer exhausted space before this marker.
        printf '%s\n' failed > "$backup_guard_marker" || true
        kill -TERM "$backup_dump_pid" 2>/dev/null || true
        exit 1
      fi
      sleep "$poll_seconds"
    done
  ) &
  backup_watcher_pid=$!
  wait "$backup_dump_pid" || status=$?
  backup_dump_pid=''
  kill "$backup_watcher_pid" 2>/dev/null || true
  wait "$backup_watcher_pid" 2>/dev/null || true
  backup_watcher_pid=''
  if (( status != 0 )) || [[ -s "$backup_guard_marker" ]]; then
    printf '%s\n' 'No backup uploaded: the dump failed or exceeded a disk guard. Partial dump removed.' >&2
    return 1
  fi
  available="$(free_kib)" || { printf '%s\n' 'Cannot recheck free space; no backup uploaded.' >&2; return 1; }
  if (( available <= reserve_kib )); then
    printf '%s\n' 'Filesystem reserve reached after the dump; no backup uploaded.' >&2
    return 1
  fi
  pg_restore --list "$dump" >/dev/null
  rm -f -- "$backup_guard_marker"
  # Keep cleanup active through restic upload, including upload failures/signals.
}

case "${1:-backup}" in
  init)
    exec restic init
    ;;
  backup)
    dump="/backup/oneshot.dump"
    guarded_dump
    restic backup --host oneshot-db --tag postgres "$dump"
    # A separate weekly prune limits repeated R2 operations on every backup.
    ;;
  prune)
    restic forget --host oneshot-db --tag postgres --group-by host,tags \
      --keep-daily 7 --keep-weekly 4 --keep-monthly 3 --prune
    restic check
    ;;
  snapshots)
    exec restic snapshots --host oneshot-db --tag postgres
    ;;
  check)
    exec restic check --read-data-subset=5%
    ;;
  restore)
    snapshot="${2:?Usage: restore SNAPSHOT_ID NEW_DATABASE_NAME}"
    target="${3:?Usage: restore SNAPSHOT_ID NEW_DATABASE_NAME}"
    if [[ ! "$snapshot" =~ ^[a-fA-F0-9]{8,64}$ ]]; then
      printf '%s\n' 'Use an explicit snapshot ID from snapshots, not latest.' >&2; exit 1
    fi
    if [[ ! "$target" =~ ^oneshot_restore_[a-z0-9_]{1,40}$ ]]; then
      printf '%s\n' 'Restore DB name must start oneshot_restore_ and contain lowercase letters, numbers or underscores.' >&2; exit 1
    fi
    directory="$(mktemp -d /restore/recovery.XXXXXXXX)"
    restic restore "$snapshot" --target "$directory"
    dump="$directory/backup/oneshot.dump"
    pg_restore --list "$dump" >/dev/null
    # createdb fails if the destination exists. Never drop or overwrite a DB.
    createdb --owner=oneshot "$target"
    pg_restore --exit-on-error --single-transaction --no-owner --no-privileges --role=oneshot \
      --dbname="$target" "$dump"
    psql --set=ON_ERROR_STOP=1 --dbname="$target" \
      -c 'SELECT namespace, count(*) FROM b20_app_records GROUP BY namespace ORDER BY namespace'
    printf 'Restored into separate database %s. Dump retained under %s.\n' "$target" "$directory"
    ;;
  *)
    printf '%s\n' 'Commands: init | backup | prune | snapshots | check | restore SNAPSHOT_ID NEW_DATABASE_NAME' >&2
    exit 1
    ;;
esac
