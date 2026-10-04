#!/usr/bin/env bash
# 영속 데이터 보존 확인용 스냅숏(읽기 전용). 표마다 행 수, 적용된 마이그레이션 수, DB 볼륨 생성 시각을 남긴다.
# 재시작·재배포·VM 재부팅 전후에 한 번씩 찍고 diff로 비교한다(docs/DEPLOY.md 「#137 검증 절차」).
# 사용: scripts/ops/data-snapshot.sh [이름표]   → /opt/obs/checks/snapshot-<KST>-<이름표>.txt
. "$(dirname "$0")/lib.sh"

tag="${1:-check}"
db="$(db_container)"; [ -n "$db" ] || die "DB 컨테이너가 없어요."
docker start "$db" >/dev/null
for i in $(seq 1 30); do
  docker exec "$db" sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1 && break
  [ "$i" -eq 30 ] && die "DB가 준비되지 않았어요."
  sleep 2
done
mkdir -p "$CHECK_DIR"
out="$CHECK_DIR/snapshot-$(kst +%Y%m%d-%H%M%S)-$tag.txt"
{
  echo "# volume obs-web_obs-web-pgdata created=$(docker volume inspect obs-web_obs-web-pgdata --format '{{.CreatedAt}}' 2>/dev/null || echo 없음)"
  docker exec -i "$db" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -XAtq -F " "' <<'SQL'
SELECT 'migrations', count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;
SELECT 'table ' || table_name,
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name;
SQL
} > "$out"
log "스냅숏: $out ($(grep -c '^table ' "$out")개 표)"
echo "$out"
