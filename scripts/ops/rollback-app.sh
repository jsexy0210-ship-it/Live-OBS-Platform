#!/usr/bin/env bash
# 앱만 직전 릴리스로 되돌린다(DB·마이그레이션은 그대로, 빌드 없음). DB를 되돌리는 것은 db-restore.sh로 따로 한다.
# 사용: scripts/ops/rollback-app.sh [되돌릴 커밋 SHA 전체]
#   SHA를 비우면 deploy-history.log에서 지금 버전 바로 앞에 성공한 배포 SHA를 쓴다.
. "$(dirname "$0")/lib.sh"

cur="$(current_version)"
want="${1:-}"
if [ -z "$want" ]; then
  [ -f "$HISTORY" ] || die "$HISTORY 이 없어요. 되돌릴 SHA를 직접 넣어 주세요(docker image ls obs-web-app)."
  want="$(grep -o 'sha=[0-9a-f]\{40\}' "$HISTORY" | cut -d= -f2 | awk -v cur="$cur" '$0 != cur' | tail -n1)"
  [ -n "$want" ] || die "기록에서 이전 배포 SHA를 찾지 못했어요."
fi
[ "$want" != "$cur" ] || die "이미 $want 버전이에요."
docker image inspect "obs-web-app:$want" >/dev/null 2>&1 || die "obs-web-app:$want 이미지가 서버에 없어요(docker image ls obs-web-app)."

# 되돌릴 버전이 모르는 마이그레이션이 DB에 있으면 경고한다(구버전 코드가 새 스키마와 맞지 않을 수 있음).
db="$(db_container)"
if [ -n "$db" ] && docker image inspect "obs-web-migrate:$want" >/dev/null 2>&1; then
  known="$(docker run --rm --entrypoint ls "obs-web-migrate:$want" prisma/migrations | grep -v '\.toml$' | sort)"
  applied="$(docker exec "$db" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -XAtq -c "SELECT migration_name FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL"' | sort)"
  newer="$(comm -13 <(echo "$known") <(echo "$applied") | grep -v '^$' || true)"
  if [ -n "$newer" ]; then
    log "경고: 되돌릴 버전이 모르는 마이그레이션이 DB에 있어요:"; echo "$newer" | sed 's/^/  - /'
    log "구버전 앱이 이 스키마에서 오류를 낼 수 있어요. 문제가 생기면 배포 전 백업으로 db-restore.sh를 실행해요."
  fi
fi

log "앱 롤백: ${cur:-없음} → $want (DB 그대로)"
for svc in $(app_services); do
  APP_VERSION="$want" compose up -d --no-build --no-deps --wait "$svc"
  # 앱 2개(가용성 프로파일)면 프록시가 교체 중 실패로 기억한 이 앱(5초)을 다시 넣을 때까지 기다린 뒤 다음 앱을 바꾼다(rolling-deploy.sh와 같은 이유).
  if availability_on; then sleep 8; fi
done
wait_health "$want" >/dev/null || die "롤백 뒤 health 확인 실패(version=$want)."
echo "$(kst '+%F %T KST') sha=$want rollback_from=${cur:-none} actor=$(id -un)" >> "$HISTORY"
log "롤백 완료: health ok, version=$want"
