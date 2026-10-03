#!/usr/bin/env bash
# DB 복원(코드 롤백과 별개). 현재 DB를 지우고 백업 시점으로 다시 만든다. 백업 뒤에 생긴 표·데이터는 남지 않는다.
# 순서: 백업 파일 검사 → 지금 DB를 안전 백업 → 앱 중지 → DROP/CREATE → pg_restore → 지금 버전 마이그레이션 → 앱 시작 → health
# 사용: scripts/ops/db-restore.sh /opt/obs/backups/<파일>.dump
#   실행 중 DB 이름을 직접 입력해야 진행한다(OBS_RESTORE_CONFIRM=<DB 이름>으로도 확인 가능).
. "$(dirname "$0")/lib.sh"

file="${1:?사용법: db-restore.sh <백업 파일>}"
[ -s "$file" ] || die "백업 파일이 없거나 비어 있어요: $file"
db="$(db_container)"; [ -n "$db" ] || die "DB 컨테이너가 없어요."
docker start "$db" >/dev/null
name="$(db_name "$db")"
docker exec -i "$db" pg_restore -l < "$file" > /dev/null || die "백업 파일을 읽을 수 없어요(pg_restore -l 실패)."

confirm="${OBS_RESTORE_CONFIRM:-}"
if [ -z "$confirm" ]; then
  printf '현재 DB(%s)를 지우고 %s 로 되돌려요. 계속하려면 DB 이름을 입력하세요: ' "$name" "$(basename "$file")"
  read -r confirm
fi
[ "$confirm" = "$name" ] || die "DB 이름이 달라 멈췄어요."

# 복원하는 동안 앱이 내려가 있으므로 감시가 장애로 알리지 않게 배포 표시를 둔다(끝나면 지움).
mark_deploying "db-restore $(basename "$file")"
log "복원 전 안전 백업"
"$(dirname "$0")/db-backup.sh" before-restore >/dev/null

log "앱 중지: $(app_services)"
compose stop $(app_services)
docker exec "$db" sh -c 'psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -q -c "DROP DATABASE \"$POSTGRES_DB\" WITH (FORCE)" -c "CREATE DATABASE \"$POSTGRES_DB\""'
docker exec -i "$db" sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < "$file"
# 백업이 지금 앱보다 오래된 스키마일 수 있으니, 지금 버전의 마이그레이션을 먼저 적용한다(health는 SELECT 1만 봐서 스키마 차이를 못 잡음).
log "마이그레이션(지금 버전 ${APP_VERSION:-?})"
compose up --no-build --no-deps obs-web-migrate
[ "$(docker inspect -f '{{.State.ExitCode}}' "$(container_of obs-web-migrate)")" = 0 ] || die "복원 뒤 마이그레이션 실패. 앱은 멈춘 채로 두었어요(복원 전 상태는 before-restore 백업)."
log "앱 시작"
compose start $(app_services)
# 앱이 2개면 프록시 health는 하나만 살아도 통과하므로, 앱마다 컨테이너 healthcheck를 따로 확인한다.
wait_services_healthy $(app_services) || die "복원 뒤 앱이 healthy가 되지 않았어요(availability.sh status로 확인, 복원 전 상태는 before-restore 백업)."
wait_health "" >/dev/null
log "복원 완료: $(basename "$file"), health ok"
