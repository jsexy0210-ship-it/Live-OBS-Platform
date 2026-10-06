#!/usr/bin/env bash
# obs-test 자동 정리 전용. 기본은 목록만 표시한다. Docker/기록/권한 확인 실패 시 아무것도 지우지 않는다.
# 최신 자동 백업 3개, 최근 배포 SHA 3개, 모든 컨테이너가 참조하는 이미지를 보존한다.
set -euo pipefail

mode=dry
case "${1:---dry-run}" in
  --dry-run) ;;
  --apply) mode=apply ;;
  *) echo 'usage: disk-cleanup.sh [--dry-run|--apply]' >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || exit 2
backup_dir="${OBS_BACKUP_DIR:-/opt/obs/backups}"
history="${OBS_HISTORY_FILE:-/opt/obs/deploy-history.log}"
fail() { echo "정리 중단: $*" >&2; exit 1; }
note() { printf '[%s] %s\n' "$mode" "$*"; }

# 실제 서버 권한은 여기서 확인한다. .env를 열거나 sudo로 우회하지 않는다.
if [[ ! -d "$backup_dir" || -L "$backup_dir" || ! -r "$backup_dir" || ! -x "$backup_dir" ]]; then fail '백업 폴더를 읽을 수 없어요.'; fi
[ "$backup_dir" = "$(realpath -e -- "$backup_dir")" ] || fail '백업 경로의 링크·상위 경로 이동은 허용하지 않아요.'
if [[ ! -f "$history" || -L "$history" || ! -r "$history" ]]; then fail '배포 기록을 읽을 수 없어요.'; fi
if [ "$mode" = apply ]; then
  [ -w "$backup_dir" ] || fail '백업 폴더에 쓰기 권한이 없어요.'
  command -v flock >/dev/null || fail 'flock이 없어요.'
fi
command -v docker >/dev/null || fail 'docker가 없어요.'
docker info >/dev/null 2>&1 || fail 'docker 접근 권한이 없어요.'

# 최근 성공 배포 3개를 중복 없이 보존한다. 손상/누락된 기록이면 전체 작업을 중단한다.
history_lines="$(tac -- "$history")" || fail '배포 기록 조회에 실패했어요.'
keep_shas=()
while IFS= read -r line; do
  [ -n "$line" ] || continue
  read -ra fields <<< "$line"
  count=0
  sha=""
  for field in "${fields[@]}"; do
    if [[ "$field" == sha=* ]]; then
      [[ "$field" =~ ^sha=([0-9a-f]{40})$ ]] || fail '배포 기록의 SHA가 손상됐어요.'
      sha="${BASH_REMATCH[1]}"
      count=$((count + 1))
    fi
  done
  [ "$count" = 1 ] || fail '배포 기록에 SHA가 없거나 중복돼요.'
  found=0
  for kept in "${keep_shas[@]}"; do [ "$kept" != "$sha" ] || found=1; done
  if [ "$found" = 0 ] && [ "${#keep_shas[@]}" -lt 3 ]; then keep_shas+=("$sha"); fi
done <<< "$history_lines"
[ "${#keep_shas[@]}" -gt 0 ] || fail '배포 기록에서 보존할 SHA를 찾지 못했어요.'

# Docker 조회 실패를 빈 목록으로 취급하면 안 된다. stopped 컨테이너의 이미지도 보존한다.
running="$(docker ps -q --filter label=com.docker.compose.project=obs-web --filter label=com.docker.compose.service=obs-web-app)" || fail '현재 앱을 조회하지 못했어요.'
[ -n "$running" ] || fail '현재 실행 중인 obs-web 앱을 확인하지 못했어요.'
mapfile -t running_ids <<< "$running"
current_tags="$(docker inspect --format '{{.Config.Image}}' "${running_ids[@]}")" || fail '현재 앱 버전 조회에 실패했어요.'
while read -r tag; do
  [[ "$tag" =~ ^obs-web-app:([0-9a-f]{40})$ ]] || fail '현재 앱 SHA 태그를 확인하지 못했어요.'
  # 실제 현재 버전이 롤백돼 오래된 SHA여도 같은 SHA의 migrator 이미지까지 보존한다.
  keep_shas+=("${BASH_REMATCH[1]}")
done <<< "$current_tags"
containers="$(docker ps -aq)" || fail '컨테이너 목록을 조회하지 못했어요.'
[ -n "$containers" ] || fail '컨테이너 목록이 비어 있어요.'
mapfile -t container_ids <<< "$containers"
in_use="$(docker inspect --format '{{.Image}}' "${container_ids[@]}")" || fail '컨테이너 이미지 조회에 실패했어요.'
[ -n "$in_use" ] || fail '사용 중인 이미지 ID가 비어 있어요.'
while read -r image_id; do
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail '컨테이너 이미지 ID가 올바르지 않아요.'
done <<< "$in_use"
images="$(docker image ls --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}')" || fail '이미지 목록을 조회하지 못했어요.'
[ -n "$images" ] || fail '이미지 목록이 비어 있어요.'
while read -r tag image_id extra; do
  if [[ ! "$image_id" =~ ^sha256:[0-9a-f]{64}$ || -n "$extra" ]]; then fail '이미지 목록 형식이 올바르지 않아요.'; fi
done <<< "$images"
backup_names="$(find "$backup_dir" -maxdepth 1 -type f -printf '%f\n')" || fail '백업 목록을 읽지 못했어요.'
mapfile -t backups < <(printf '%s\n' "$backup_names" | LC_ALL=C sort -r | sed -n '/^obs-[0-9]\{8\}-[0-9]\{6\}-before-[0-9a-f]\{7\}\.dump$/p')

if [ "$mode" = apply ]; then
  exec 9>"$backup_dir/.automatic-cleanup.lock"
  flock -n 9 || fail '다른 자동 정리가 실행 중이에요.'
fi
note "자동 백업 ${#backups[@]}개 중 최신 3개 보존(수동 백업·.part·.env는 대상 아님)"
for ((i=3; i<${#backups[@]}; i++)); do
  note "백업 삭제: ${backups[$i]}"
  if [ "$mode" = apply ]; then rm -- "$backup_dir/${backups[$i]}"; fi
done

while read -r tag image_id extra; do
  [[ "$tag" =~ ^obs-web-(app|migrate):([0-9a-f]{40})$ ]] || continue
  sha="${BASH_REMATCH[2]}"
  preserve=0
  for kept in "${keep_shas[@]}"; do [ "$kept" != "$sha" ] || preserve=1; done
  # Image ID comparison also protects aliases of running/stopped containers.
  if grep -Fxq -- "$image_id" <<< "$in_use"; then preserve=1; fi
  [ "$preserve" = 0 ] || continue
  note "이미지 삭제: $tag"
  # -f를 쓰지 않는다. 조회 뒤 컨테이너가 생겨도 Docker가 사용 중 이미지 삭제를 거부한다.
  if [ "$mode" = apply ]; then docker image rm "$tag" || fail '이미지 삭제가 거부됐어요.'; fi
done <<< "$images"

# 일주일 이상 된 미사용 dangling 이미지·빌드 캐시만. -a/볼륨/컨테이너 정리는 사용하지 않는다.
note '미사용 dangling 이미지·빌드 캐시 중 168시간 지난 것 정리'
if [ "$mode" = apply ]; then
  docker image prune --force --filter until=168h
  docker builder prune --force --filter until=168h
fi
note '정리 완료'
