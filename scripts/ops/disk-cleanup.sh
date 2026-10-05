#!/usr/bin/env bash
# 테스트 서버 디스크 점검·정리. 서버(obs-web-test)에서 obs 계정(docker 그룹)으로 실행한다. 절차: docs/DEPLOY.md 「디스크 정리」.
# 사용: scripts/ops/disk-cleanup.sh            → 무엇을 지울지만 보여 줌(아무것도 지우지 않음)
#       scripts/ops/disk-cleanup.sh --apply    → 실제로 정리
#       scripts/ops/disk-cleanup.sh --check    → 남은 용량만 검사(기준 미만이면 0이 아닌 코드). 배포 전에 워크플로가 부른다
# 정리 대상(이 네 가지만, 나머지는 건드리지 않는다):
#  1) 배포 전 자동 백업(obs-<날짜>-<시각>-before-<커밋7자리>.dump): 최근 OBS_BACKUP_KEEP개(기본 10)만 남김.
#     수동 백업·복원 안전 백업(다른 이름표)은 지우지 않는다. 쓰다 만 .dump.part는 하루가 지나면 지운다.
#  2) 앱·마이그레이션 이미지(obs-web-app:<SHA>, obs-web-migrate:<SHA>): 배포 기록의 최근 OBS_IMAGE_KEEP개(기본 5) 버전과
#     지금 컨테이너가 쓰는 것은 남김(롤백용). 이름 없는(dangling) 이미지도 지움. 기록을 읽지 못하면 이미지는 하나도 지우지 않는다.
#  3) 빌드 캐시: 마지막으로 쓴 지 OBS_BUILDER_KEEP_H시간(기본 24)이 지난 것만 지움.
#  4) 러너 진단 로그(_diag/Runner_*.log, Worker_*.log): OBS_DIAG_KEEP_DAYS일(기본 14)이 지난 것만 지움.
# 절대 하지 않는 것: docker 볼륨(DB 데이터) 삭제, docker system prune, 컨테이너 삭제, 수동 백업 삭제.
set -euo pipefail

MODE=dry
case "${1:-}" in
  --apply) MODE=apply ;;
  --check) MODE=check ;;
  ""|--dry-run) ;;
  *) echo "사용법: disk-cleanup.sh [--check | --apply]   (아무 옵션 없으면 지울 목록만 보여 줘요)" >&2; exit 2 ;;
esac

kst() { TZ=Asia/Seoul date "$@"; }
log() { printf '%s %s\n' "$(kst '+%F %T KST')" "$*"; }
warn() { log "주의: $*" >&2; }

BACKUP_DIR="${OBS_BACKUP_DIR:-/opt/obs/backups}"
HISTORY="${OBS_HISTORY_FILE:-/opt/obs/deploy-history.log}"

# 숫자 설정은 범위를 검사한다(잘못된 값으로 너무 많이 지우지 않게).
num() { # $1=이름 $2=기본 $3=최소 $4=최대
  local v="${!1:-$2}"
  [[ "$v" =~ ^[0-9]+$ ]] && [ "$v" -ge "$3" ] && [ "$v" -le "$4" ] || { echo "$1 는 $3 이상 $4 이하 정수여야 해요(받은 값: $v)." >&2; exit 2; }
  printf '%s' "$v"
}
MIN_FREE_GB="$(num OBS_MIN_FREE_GB 5 1 1000)"
KEEP_BACKUPS="$(num OBS_BACKUP_KEEP 10 3 365)"
KEEP_VERSIONS="$(num OBS_IMAGE_KEEP 5 2 50)"
BUILDER_KEEP_H="$(num OBS_BUILDER_KEEP_H 24 1 8760)"
DIAG_KEEP_DAYS="$(num OBS_DIAG_KEEP_DAYS 14 3 365)"

human() { awk -v b="$1" 'BEGIN { s = "B KB MB GB TB"; split(s, u, " "); i = 1; while (b >= 1024 && i < 5) { b /= 1024; i++ } printf (i == 1 ? "%d%s" : "%.1f%s"), b, u[i] }'; }

docker_root() {
  local d=""
  if command -v docker >/dev/null 2>&1; then d="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"; fi
  printf '%s' "${d:-/var/lib/docker}"
}

# 러너 폴더(_diag가 있는 곳): 직접 지정 > 러너가 준 RUNNER_TEMP(.../_work/_temp)에서 거슬러 올라감 > 홈
runner_root() {
  if [ -n "${OBS_RUNNER_ROOT:-}" ]; then printf '%s' "$OBS_RUNNER_ROOT"
  elif [ -n "${RUNNER_TEMP:-}" ]; then dirname "$(dirname "$RUNNER_TEMP")"
  else printf '%s' "${HOME:-/}"; fi
}

# 검사할 경로의 (남은 KiB, 마운트 지점)
avail_of() { # $1=경로 → "KiB 마운트"
  local p="$1"; while [ ! -e "$p" ] && [ "$p" != "/" ]; do p="$(dirname "$p")"; done
  df -Pk -- "$p" | awk 'NR == 2 { print $4, $6 }'
}

check_disk() {
  local need_kib=$((MIN_FREE_GB * 1024 * 1024)) bad=0 seen="" label path line kib mnt
  for label_path in "도커 이미지·빌드 캐시|$(docker_root)" "DB 백업|$BACKUP_DIR" "러너 작업 폴더|$(runner_root)"; do
    label="${label_path%%|*}"; path="${label_path#*|}"
    line="$(avail_of "$path" 2>/dev/null || true)"
    [ -n "$line" ] || { warn "$label($path) 용량을 읽지 못했어요."; continue; }
    kib="${line%% *}"; mnt="${line#* }"
    case " $seen " in *" $mnt "*) continue ;; esac   # 같은 디스크는 한 번만
    seen="$seen $mnt"
    if [ "$kib" -lt "$need_kib" ]; then
      printf '  - %s (%s): 남은 %s — 필요 %sGB 이상\n' "$label" "$mnt" "$(human $((kib * 1024)))" "$MIN_FREE_GB"; bad=1
    else
      printf '  - %s (%s): 남은 %s\n' "$label" "$mnt" "$(human $((kib * 1024)))"
    fi
  done
  if [ "$bad" = 1 ]; then
    cat <<EOF

서버 디스크 여유가 부족해서 배포를 시작하지 않았어요. 이대로 배포하면 빌드 도중 디스크가 가득 차 러너가 멈출 수 있어요.
서버에 접속해서 먼저 정리해 주세요(DB 데이터·수동 백업·최근 버전 이미지는 지우지 않아요):
  cd /opt/obs/src && scripts/ops/disk-cleanup.sh            ← 무엇을 지울지만 보기
  cd /opt/obs/src && scripts/ops/disk-cleanup.sh --apply    ← 정리하기
정리가 끝나면 배포를 다시 실행해 주세요. 자세한 설명: docs/DEPLOY.md 「디스크 정리」
EOF
    return 1
  fi
  return 0
}

if [ "$MODE" = check ]; then
  log "디스크 여유 점검(기준 ${MIN_FREE_GB}GB)"
  check_disk
  exit $?
fi

say() { if [ "$MODE" = apply ]; then log "$*"; else log "[지울 후보] $*"; fi; }
total_freed=0

# 1) 배포 전 자동 백업
prune_backups() {
  if [ ! -d "$BACKUP_DIR" ]; then log "백업 폴더($BACKUP_DIR)가 없어 건너뛰어요."; return 0; fi
  local re='.*/obs-[0-9]{8}-[0-9]{6}-before-[0-9a-f]{7}\.dump' names n del i f sz sum=0
  mapfile -t names < <(find "$BACKUP_DIR" -maxdepth 1 -type f -regextype posix-extended -regex "$re" -printf '%f\n' | sort)
  n=${#names[@]}; del=$((n - KEEP_BACKUPS))
  log "배포 전 자동 백업 ${n}개 중 최근 ${KEEP_BACKUPS}개를 남겨요."
  if [ "$del" -gt 0 ]; then
    for ((i = 0; i < del; i++)); do
      f="${names[$i]}"; sz="$(stat -c %s -- "$BACKUP_DIR/$f" 2>/dev/null || echo 0)"
      say "백업 삭제: $f ($(human "$sz"))"
      if [ "$MODE" = apply ]; then rm -f -- "$BACKUP_DIR/$f" || { warn "$f 를 지우지 못했어요."; continue; }; fi
      sum=$((sum + sz))
    done
    total_freed=$((total_freed + sum))
  fi
  # 쓰다 만 파일(하루 넘게 그대로)
  while IFS= read -r f; do
    sz="$(stat -c %s -- "$f" 2>/dev/null || echo 0)"
    say "쓰다 만 백업 삭제: $(basename "$f") ($(human "$sz"))"
    if [ "$MODE" = apply ]; then rm -f -- "$f" || continue; fi
    total_freed=$((total_freed + sz))
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'obs-*.dump.part' -mmin +1440 2>/dev/null)
  # 자동으로 지우지 않는 백업(수동·복원 안전 백업)은 크기만 알려 준다
  local other
  other="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.dump' -printf '%s %f\n' | grep -Ev " obs-[0-9]{8}-[0-9]{6}-before-[0-9a-f]{7}\.dump$" | awk '{ s += $1; c++ } END { printf "%d %d", c + 0, s + 0 }' || true)"
  log "자동으로 지우지 않는 백업(수동·복원 안전 백업): ${other%% *}개, $(human "${other##* }") — 필요 없으면 직접 정리해 주세요."
}

# 2~3) 도커 이미지·빌드 캐시
prune_docker() {
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then log "docker를 쓸 수 없어 이미지 정리는 건너뛰어요."; return 0; fi
  local keep_shas="" in_use tag sha removed=0 keepn=0 dangling
  if [ -r "$HISTORY" ]; then
    keep_shas="$(tac -- "$HISTORY" | grep -o 'sha=[0-9a-f]\{40\}' | cut -d= -f2 | awk '!seen[$0]++' | head -n "$KEEP_VERSIONS" || true)"
  fi
  if [ -z "$keep_shas" ]; then
    warn "배포 기록($HISTORY)에서 남길 버전을 찾지 못해 앱·마이그레이션 이미지는 하나도 지우지 않아요."
  else
    in_use="$(docker ps -a --format '{{.Image}}' | sort -u || true)"
    while IFS= read -r tag; do
      [ -n "$tag" ] || continue
      sha="${tag##*:}"
      if grep -qx -- "$sha" <<<"$keep_shas" || grep -qxF -- "$tag" <<<"$in_use"; then keepn=$((keepn + 1)); continue; fi
      say "이미지 삭제: $tag"
      if [ "$MODE" = apply ]; then docker rmi "$tag" >/dev/null 2>&1 && removed=$((removed + 1)) || warn "$tag 를 지우지 못했어요(쓰는 중일 수 있어요)."; else removed=$((removed + 1)); fi
    done < <(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E '^obs-web-(app|migrate):[0-9a-f]{40}$' || true)
    log "앱·마이그레이션 이미지: 남김 ${keepn}개(최근 ${KEEP_VERSIONS}개 버전·실행 중), 정리 ${removed}개."
  fi
  dangling="$(docker image ls -f dangling=true -q | wc -l | tr -d ' ')"
  say "이름 없는(dangling) 이미지 ${dangling}개"
  if [ "$MODE" = apply ]; then docker image prune -f >/dev/null || warn "dangling 이미지를 정리하지 못했어요."; fi
  say "빌드 캐시(마지막으로 쓴 지 ${BUILDER_KEEP_H}시간 넘은 것)"
  if [ "$MODE" = apply ]; then docker builder prune -f --filter "until=${BUILDER_KEEP_H}h" >/dev/null || warn "빌드 캐시를 정리하지 못했어요."; fi
  log "도커 사용량:"; docker system df 2>/dev/null | sed 's/^/    /' || true
}

# 4) 러너 진단 로그
prune_runner_logs() {
  local diag cnt=0 sum=0 f sz
  diag="$(runner_root)/_diag"
  if [ ! -d "$diag" ]; then log "러너 진단 로그 폴더($diag)가 없어 건너뛰어요."; return 0; fi
  while IFS= read -r f; do
    sz="$(stat -c %s -- "$f" 2>/dev/null || echo 0)"; cnt=$((cnt + 1)); sum=$((sum + sz))
    if [ "$MODE" = apply ]; then rm -f -- "$f" || true; fi
  done < <(find "$diag" -maxdepth 1 -type f \( -name 'Runner_*.log' -o -name 'Worker_*.log' \) -mtime "+$DIAG_KEEP_DAYS" 2>/dev/null)
  say "러너 진단 로그 ${cnt}개 (${DIAG_KEEP_DAYS}일 넘은 것, $(human "$sum"))"
  total_freed=$((total_freed + sum))
}

log "디스크 정리 시작(모드: $([ "$MODE" = apply ] && echo 실제 정리 || echo 목록만 보기))"
before="$(avail_of "$(docker_root)" 2>/dev/null | cut -d' ' -f1 || echo 0)"
prune_backups || warn "백업 정리 중 문제가 있었어요."
prune_docker || warn "도커 정리 중 문제가 있었어요."
prune_runner_logs || warn "러너 로그 정리 중 문제가 있었어요."
after="$(avail_of "$(docker_root)" 2>/dev/null | cut -d' ' -f1 || echo 0)"
if [ "$MODE" = apply ]; then
  log "끝. 도커 디스크 남은 용량: $(human $((before * 1024))) → $(human $((after * 1024)))"
else
  log "끝(아무것도 지우지 않았어요). 실제로 정리하려면 --apply 를 붙여 주세요."
fi
