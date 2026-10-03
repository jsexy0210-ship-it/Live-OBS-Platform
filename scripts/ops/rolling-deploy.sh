#!/usr/bin/env bash
# 가용성 프로파일에서 앱을 하나씩 바꾸는 배포(테스트 서버 전용). 측정(measure.sh)과 함께 돌려 무중단인지 확인한다.
# 사용: scripts/ops/rolling-deploy.sh [커밋 SHA]
#   SHA를 주면 그 버전 이미지(서버에 있어야 함)로, 비우면 지금 체크아웃한 코드를 빌드해 그 커밋 SHA로 바꾼다.
# 순서: (빌드) → 마이그레이션 1회 → obs-web-app 교체·healthy 대기 → obs-web-app-2 교체·healthy 대기 → health version 확인
. "$(dirname "$0")/lib.sh"

require_test_env
availability_on || die "가용성 프로파일이 꺼져 있어요(availability.sh on)."
new="${1:-}"
if [ -z "$new" ]; then
  new="$(git -C "$OPS_ROOT" rev-parse HEAD)"
  log "빌드: $new"
  APP_VERSION="$new" compose build obs-web-app obs-web-migrate
fi
docker image inspect "obs-web-app:$new" >/dev/null 2>&1 || die "obs-web-app:$new 이미지가 없어요."
export APP_VERSION="$new"
log "마이그레이션"
compose up --no-build --no-deps obs-web-migrate
[ "$(docker inspect -f '{{.State.ExitCode}}' "$(container_of obs-web-migrate)")" = 0 ] || die "마이그레이션 실패. 앱은 바꾸지 않았어요."
for svc in obs-web-app obs-web-app-2; do
  log "교체: $svc → $new"
  compose up -d --no-build --no-deps --wait "$svc"
  # 프록시가 교체 중 실패로 기억한 이 앱(fail_duration 5초)을 다시 넣을 때까지 기다린 뒤 다음 앱을 바꾼다.
  # 기다리지 않으면 두 앱이 함께 빠져 장애가 난다(2026-10-04 측정).
  sleep 8
done
wait_health "$new" >/dev/null || die "교체 뒤 health version 확인 실패."
echo "$(kst '+%F %T KST') sha=$new rolling=1 actor=$(id -un)" >> "$HISTORY"
log "무중단 배포 완료: version=$new"
