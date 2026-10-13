#!/usr/bin/env bash
# MA120 전용 두 범주 읽기 원천. 공용 정리 스크립트의 apply/prune를 호출하지 않는다.
set -euo pipefail
export LC_ALL=C
fail() { printf '%s\n' "$1" >&2; exit 1; }
[ "${1:-}" = --preview ] && [ "$#" = 1 ] || fail BRIDGE_EXECUTION_UNCONNECTED
history="${OBS_HISTORY_FILE:-/opt/obs/deploy-history.log}"
runner="${OBS_RUNNER_ROOT:-}"
keep="${OBS_IMAGE_KEEP:-5}"
[[ "$keep" =~ ^[0-9]+$ ]] && ((keep >= 2 && keep <= 50)) || fail INVALID_ROLLBACK_POLICY
[ -n "$history" ] && [ -f "$history" ] && [ ! -L "$history" ] && [ -r "$history" ] || fail HISTORY_UNVERIFIED
[ -n "$runner" ] && [ -d "$runner/_diag" ] && [ ! -L "$runner" ] && [ ! -L "$runner/_diag" ] || fail RUNNER_UNVERIFIED
root="$(realpath -e -- "$runner")"; diag="$(realpath -e -- "$runner/_diag")"
[ "$diag" = "$root/_diag" ] || fail RUNNER_UNVERIFIED
# runner 표시명은 OS 이름의 근거가 아니다. 고정 local socket과 fresh TEST 복합 근거를 확인한다.
[ "${DOCKER_HOST:-unix:///var/run/docker.sock}" = unix:///var/run/docker.sock ] && [ "${DOCKER_CONTEXT:-default}" = default ] || fail DOCKER_ENDPOINT_DENIED
[ -z "${DOCKER_TLS_VERIFY:-}" ] && [ -z "${DOCKER_CERT_PATH:-}" ] || fail DOCKER_ENDPOINT_DENIED
# 값/명령 stderr는 남기지 않고 조회 실패와 귀속 불일치를 구분한다.
if host_name="$(hostname -s 2>/dev/null)"; then
  [ -n "$host_name" ] || fail 'HOSTNAME_MISSING match=false'
else
  host_status=$?; fail "HOSTNAME_QUERY_FAILED exit=$host_status"
fi
d() { (unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH; docker --host unix:///var/run/docker.sock "$@"); }
[ "$(d context inspect default --format '{{.Endpoints.docker.Host}}')" = unix:///var/run/docker.sock ] || fail DOCKER_ENDPOINT_DENIED
if daemon_name="$(d info --format '{{.Name}}' 2>/dev/null)"; then
  [ "$daemon_name" = "$host_name" ] || fail 'DOCKER_DAEMON_MISMATCH match=false'
else
  daemon_status=$?; fail "DOCKER_DAEMON_QUERY_FAILED exit=$daemon_status"
fi
# 과거 artifact/환경 boolean을 신뢰하지 않고 후보 읽기 및 callback 때마다 다시 측정한다.
# 소유 확인한 같은 fd의 전체 history snapshot만 쓰고 pathname을 다시 열지 않는다.
verified_history="$(python3 "$(dirname -- "${BASH_SOURCE[0]}")/disk-optimization-host-diagnostics.py" --verify-preview-history)"
log_exclusion=$'EXCLUDED_CATEGORY\tRUNNER_DIAGNOSTIC_LOGS_OLDER_THAN_14_DAYS\tRUNNER_DIAG_WRITABLE_BY_GROUP_OR_OTHER\tREADONLY_ONLY'
log_enabled=yes; exclusion_rows=""
if [ "${verified_history%%$'\n'*}" = "$log_exclusion" ]; then
  log_enabled=no; exclusion_rows="$log_exclusion"$'\n'
  verified_history="${verified_history#*$'\n'}"
fi
all_versions="$(tr ' ' '\n' <<<"$verified_history" | sort -u)"
protected_versions="$(tac <<<"$verified_history" | tr ' ' '\n' | awk '!seen[$0]++' | sed -n "1,${keep}p")"
[ -n "$all_versions" ] && [ -n "$protected_versions" ] || fail HISTORY_UNVERIFIED
containers="$(d ps -aq)" || fail CONTAINERS_UNVERIFIED
protected_ids=""
for container in $containers; do
  id="$(d inspect --format '{{.Image}}' "$container")" || fail CONTAINERS_UNVERIFIED
  [[ "$id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail CONTAINERS_UNVERIFIED
  protected_ids+="$id"$'\n'
done
tags="$(d image ls --format '{{.Repository}}:{{.Tag}}')" || fail IMAGES_UNVERIFIED
rows=""; seen=""
while IFS= read -r tag; do
  [[ "$tag" =~ ^obs-web-app:[0-9a-f]{40}$ ]] || continue
  sha="${tag##*:}"
  grep -qxF -- "$sha" <<<"$all_versions" || continue
  grep -qxF -- "$sha" <<<"$protected_versions" && continue
  info="$(d image inspect --format '{{.Id}}|{{.Size}}|{{range .RepoTags}}{{.}} {{end}}' "$tag")" || fail IMAGES_UNVERIFIED
  IFS='|' read -r id size aliases <<<"$info"
  [[ "$id" =~ ^sha256:[0-9a-f]{64}$ && "$size" =~ ^[0-9]+$ ]] || fail IMAGES_UNVERIFIED
  grep -qxF -- "$id" <<<"$protected_ids" && continue
  grep -qxF -- "$id" <<<"$seen" && continue
  safe=yes
  for alias in $aliases; do
    if [[ ! "$alias" =~ ^obs-web-app:[0-9a-f]{40}$ ]]; then safe=no; break; fi
    alias_sha="${alias##*:}"
    if ! grep -qxF -- "$alias_sha" <<<"$all_versions" || grep -qxF -- "$alias_sha" <<<"$protected_versions"; then safe=no; break; fi
  done
  [ "$safe" = yes ] && [ -n "$aliases" ] || continue
  rows+="OLD_ONQ_NON_ROLLBACK_IMAGES"$'\t'"$id"$'\t'"$size"$'\t'"${id#sha256:}"$'\n'
  seen+="$id"$'\n'
done <<<"$tags"
if [ "$log_enabled" = yes ]; then
files="$(find "$diag" -maxdepth 1 -type f -mmin +20160 -print)" || fail LOGS_UNVERIFIED
while IFS= read -r file; do
  [ -n "$file" ] || continue
  name="${file##*/}"
  [[ "$name" =~ ^(Runner|Worker)_[A-Za-z0-9_.-]+\.log$ ]] || continue
  [ ! -L "$file" ] && [ "$(realpath -e -- "$file")" = "$diag/$name" ] || continue
  [ "$(stat -c '%u' -- "$file")" = "$(id -u)" ] || continue
  before="$(stat -c '%s:%Y:%i:%u' -- "$file")" || fail LOGS_UNVERIFIED
  digest="$(sha256sum -- "$file")" || fail LOGS_UNVERIFIED
  after="$(stat -c '%s:%Y:%i:%u' -- "$file")" || fail LOGS_UNVERIFIED
  [ "$before" = "$after" ] && [ "${after##*:}" = "$(id -u)" ] || fail LOG_CHANGED_DURING_PREVIEW
  rows+="RUNNER_DIAGNOSTIC_LOGS_OLDER_THAN_14_DAYS"$'\t'"$name"$'\t'"${before%%:*}"$'\t'"${digest%% *}"$'\n'
done <<<"$files"
fi
printf 'ONQ_DISK_SAFE_V1\n'
[ -z "$exclusion_rows" ] || printf '%s' "$exclusion_rows"
[ -z "$rows" ] || printf '%s' "$rows" | sort
