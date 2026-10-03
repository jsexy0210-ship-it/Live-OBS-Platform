#!/usr/bin/env bash
# 배포 진행 표시 켜기·끄기. 감시 수집기는 표시가 있는 동안 새 장애·버전 불일치 경고를 미룬다.
# 여러 단계에 걸친 배포(Deploy obs-test 워크플로 등)가 한 줄씩 부르도록 만든 것이다.
# 표시는 작업(키)마다 따로 둔다. off는 같은 키의 표시만 지운다(겹쳐 도는 복원·가용성 전환 등의 표시는 그대로).
# 사용: scripts/ops/deploy-mark.sh on <키> ["<사유>"] [유효 초]   # 배포 시작 전. 키 예: workflow-$GITHUB_SHA
#       scripts/ops/deploy-mark.sh off <키>                       # 배포 끝(성공·실패 모두. 워크플로에서는 if: always() 단계)
# 키는 영문·숫자로 시작하고 영문·숫자·.-_만 쓴다. 이 표시는 갱신하는 프로세스가 없어 만료 시각(기본 3600초, 1~86400)까지 유효하다.
# off 없이 만료가 지나면 감시가 deploy_mark_stale로 따로 알리고 그 표시를 지운다.
. "$(dirname "$0")/lib.sh"

usage="사용법: deploy-mark.sh on <키> [\"<사유>\"] [유효 초] | off <키>"
key="${2:-}"
[ -n "$key" ] || die "$usage"
deploy_mark_key_ok "$key" || die "배포 표시 키는 영문·숫자로 시작하고 영문·숫자·.-_만 쓸 수 있어요(받은 값: $key). $usage"
case "${1:-}" in
  on)
    ttl="${4:-3600}"
    [[ "$ttl" =~ ^[1-9][0-9]*$ ]] && [ "$ttl" -le 86400 ] || die "유효 초는 1~86400 정수여야 해요(받은 값: $ttl). $usage"
    deploy_mark_set "$key" "${3:-$key}" detached "$ttl"; log "배포 표시 켬: $DEPLOY_MARK_DIR/$key(${ttl}초 뒤 만료)" ;;
  off) deploy_mark_clear "$key"; log "배포 표시 끔: $key" ;;
  *) die "$usage" ;;
esac
