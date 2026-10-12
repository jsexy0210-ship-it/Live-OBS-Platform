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
docker info >/dev/null 2>&1 || fail DOCKER_UNVERIFIED
all_versions="$(grep -o 'sha=[0-9a-f]\{40\}' "$history" | cut -d= -f2 | sort -u)" || fail HISTORY_UNVERIFIED
protected_versions="$(tac -- "$history" | grep -o 'sha=[0-9a-f]\{40\}' | cut -d= -f2 | awk '!seen[$0]++' | sed -n "1,${keep}p")"
[ -n "$all_versions" ] && [ -n "$protected_versions" ] || fail HISTORY_UNVERIFIED
containers="$(docker ps -aq)" || fail CONTAINERS_UNVERIFIED
protected_ids=""
for container in $containers; do
  id="$(docker inspect --format '{{.Image}}' "$container")" || fail CONTAINERS_UNVERIFIED
  [[ "$id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail CONTAINERS_UNVERIFIED
  protected_ids+="$id"$'\n'
done
tags="$(docker image ls --format '{{.Repository}}:{{.Tag}}')" || fail IMAGES_UNVERIFIED
rows=""; seen=""
while IFS= read -r tag; do
  [[ "$tag" =~ ^obs-web-app:[0-9a-f]{40}$ ]] || continue
  sha="${tag##*:}"
  grep -qxF -- "$sha" <<<"$all_versions" || continue
  grep -qxF -- "$sha" <<<"$protected_versions" && continue
  info="$(docker image inspect --format '{{.Id}}|{{.Size}}|{{range .RepoTags}}{{.}} {{end}}' "$tag")" || fail IMAGES_UNVERIFIED
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
files="$(find "$diag" -maxdepth 1 -type f -mmin +20160 -print)" || fail LOGS_UNVERIFIED
while IFS= read -r file; do
  [ -n "$file" ] || continue
  name="${file##*/}"
  [[ "$name" =~ ^(Runner|Worker)_[A-Za-z0-9_.-]+\.log$ ]] || continue
  [ ! -L "$file" ] && [ "$(realpath -e -- "$file")" = "$diag/$name" ] || continue
  before="$(stat -c '%s:%Y:%i' -- "$file")" || fail LOGS_UNVERIFIED
  digest="$(sha256sum -- "$file")" || fail LOGS_UNVERIFIED
  after="$(stat -c '%s:%Y:%i' -- "$file")" || fail LOGS_UNVERIFIED
  [ "$before" = "$after" ] || fail LOG_CHANGED_DURING_PREVIEW
  rows+="RUNNER_DIAGNOSTIC_LOGS_OLDER_THAN_14_DAYS"$'\t'"$name"$'\t'"${before%%:*}"$'\t'"${digest%% *}"$'\n'
done <<<"$files"
printf 'ONQ_DISK_SAFE_V1\n'
[ -z "$rows" ] || printf '%s' "$rows" | sort
