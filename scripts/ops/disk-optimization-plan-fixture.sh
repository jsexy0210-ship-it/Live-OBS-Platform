#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
tmp="$(mktemp -d)"
trap 'command rm -rf -- "$tmp"' EXIT
export tmp
mkdir -p "$tmp/protected/runner/_diag" "$tmp/protected/backup" "$tmp/protected/cache"
export OBS_RUNNER_ROOT="$tmp/protected/runner" OBS_HISTORY_FILE="$tmp/protected/history" OBS_IMAGE_KEEP=5
for n in 1 2 3 4 5 6; do printf 'sha=%040d\n' "$n"; done > "$OBS_HISTORY_FILE"
printf preserved > "$tmp/protected/backup/manual.dump"
printf preserved > "$tmp/protected/cache/shared-builder"
printf preserved > "$tmp/protected/rollback-image"
printf old > "$OBS_RUNNER_ROOT/_diag/Worker_owned.log"
printf recent > "$OBS_RUNNER_ROOT/_diag/Runner_recent.log"
printf unrelated > "$OBS_RUNNER_ROOT/_diag/customer.log"
touch -d '16 days ago' "$OBS_RUNNER_ROOT/_diag/Worker_owned.log" "$OBS_RUNNER_ROOT/_diag/customer.log"
ln -s "$tmp/protected/backup/manual.dump" "$OBS_RUNNER_ROOT/_diag/Worker_link.log"
hashes() { find "$tmp/protected" -type f -exec sha256sum {} + | sort; }
before="$(hashes)"
export CASE_MODE=normal
docker() {
  local tag sha id
  case "$1 ${2:-}" in
    'info ') return 0 ;;
    'ps -aq') printf 'owned-container\n' ;;
    'inspect --format') printf 'sha256:%064d\n' 2 ;;
    'image ls') for n in 1 2 3 4 5 6; do printf 'obs-web-app:%040d\n' "$n"; done; printf 'obs-web-migrate:%040d\n' 1; printf 'other:latest\n' ;;
    'image inspect')
      tag="${@: -1}"; sha="${tag##*:}"; id="sha256:$(printf '%064d' "$(sed "s/^0*//" <<<"$sha")")"
      # 고정 old tag가 다른 소유 별명 또는 사용 중 ID를 가지면 후보에서 제외한다.
      if [ "$CASE_MODE" = in_use ] && [ "$sha" = "$(printf '%040d' 1)" ]; then id="sha256:$(printf '%064d' 2)"; fi
      printf '%s|100|%s' "$id" "$tag"
      [ "$CASE_MODE" != alias ] || printf ' other:latest'
      printf '\n' ;;
    *) printf '%s\n' "$*" >> "$tmp/mutation"; return 91 ;;
  esac
}
export -f docker
script="$(cd -- "$(dirname -- "$0")" && pwd)/disk-optimization-plan.sh"
bash "$script" --preview > "$tmp/normal.tsv"
[ "$(grep -c '^OLD_ONQ_NON_ROLLBACK_IMAGES' "$tmp/normal.tsv")" = 1 ]
[ "$(grep -c '^RUNNER_DIAGNOSTIC_LOGS_OLDER_THAN_14_DAYS' "$tmp/normal.tsv")" = 1 ]
grep -q $'^RUNNER_DIAGNOSTIC_LOGS_OLDER_THAN_14_DAYS\tWorker_owned.log\t3\t' "$tmp/normal.tsv"
! grep -qE 'backup|cache|migrate|recent|customer|link' "$tmp/normal.tsv"
export CASE_MODE=alias
bash "$script" --preview > "$tmp/alias.tsv"
! grep -q '^OLD_ONQ_NON_ROLLBACK_IMAGES' "$tmp/alias.tsv"
export CASE_MODE=in_use
bash "$script" --preview > "$tmp/in-use.tsv"
! grep -q '^OLD_ONQ_NON_ROLLBACK_IMAGES' "$tmp/in-use.tsv"
if bash "$script" --execute > "$tmp/execute.tsv" 2> "$tmp/execute.err"; then exit 1; fi
grep -qx BRIDGE_EXECUTION_UNCONNECTED "$tmp/execute.err"
if OBS_HISTORY_FILE="$tmp/missing" bash "$script" --preview > "$tmp/missing.tsv" 2> "$tmp/missing.err"; then exit 1; fi
grep -qx HISTORY_UNVERIFIED "$tmp/missing.err"
[ ! -e "$tmp/mutation" ] && [ "$(hashes)" = "$before" ]
printf 'disk optimization preview fixture PASS (two categories, rollback/alias/in-use/backup/cache/log preservation, unconnected execute rejected)\n'
