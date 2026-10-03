#!/usr/bin/env bash
# 배포 진행 표시 켜기·끄기. 감시 수집기는 표시가 있는 동안(15분 이내) 버전 불일치 경고를 미룬다.
# 여러 단계에 걸친 배포(Deploy obs-test 워크플로 등)가 한 줄씩 부르도록 만든 것이다.
# 표시는 작업(키)마다 따로 둔다. off는 같은 키의 표시만 지운다(겹쳐 도는 복원·가용성 전환 등의 표시는 그대로).
# 사용: scripts/ops/deploy-mark.sh on <키> ["<사유>"]   # 배포 시작 전. 키 예: workflow-$GITHUB_SHA
#       scripts/ops/deploy-mark.sh off <키>             # 배포 끝(성공·실패 모두. 워크플로에서는 if: always() 단계)
# 키는 영문·숫자로 시작하고 영문·숫자·.-_만 쓴다. 표시가 15분 넘게 갱신되지 않거나 만료(OBS_DEPLOY_MARK_MAX_S, 기본 1시간)가 지나면
# 감시가 deploy_mark_stale로 따로 알리고 그 표시를 지운다.
. "$(dirname "$0")/lib.sh"

usage="사용법: deploy-mark.sh on <키> [\"<사유>\"] | off <키>"
key="${2:-}"
[ -n "$key" ] || die "$usage"
deploy_mark_key_ok "$key" || die "배포 표시 키는 영문·숫자로 시작하고 영문·숫자·.-_만 쓸 수 있어요(받은 값: $key). $usage"
case "${1:-}" in
  on) deploy_mark_set "$key" "${3:-$key}"; log "배포 표시 켬: $DEPLOY_MARK_DIR/$key" ;;
  off) deploy_mark_clear "$key"; log "배포 표시 끔: $key" ;;
  *) die "$usage" ;;
esac
