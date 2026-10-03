#!/usr/bin/env bash
# 배포 진행 표시 켜기·끄기. 감시 수집기는 표시가 있는 동안(15분 이내) 버전 불일치 경고를 미룬다.
# 여러 단계에 걸친 배포(Deploy obs-test 워크플로 등)가 한 줄씩 부르도록 만든 것이다.
# 사용: scripts/ops/deploy-mark.sh on "<사유>"   # 배포 시작 전
#       scripts/ops/deploy-mark.sh off            # 배포 끝(성공·실패 모두. 워크플로에서는 if: always() 단계)
# 표시가 15분 넘게 남으면 감시가 deploy_mark_stale로 따로 알리고 표시는 무시한다.
. "$(dirname "$0")/lib.sh"

case "${1:-}" in
  on) deploy_mark_set "${2:-deploy}"; log "배포 표시 켬: $DEPLOY_MARK" ;;
  off) deploy_mark_clear; log "배포 표시 끔" ;;
  *) die "사용법: deploy-mark.sh on \"<사유>\" | off" ;;
esac
