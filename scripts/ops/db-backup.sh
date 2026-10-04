#!/usr/bin/env bash
# DB 백업(코드 롤백과 별개). 지금 있는 DB 컨테이너를 그대로 깨워 pg_dump한다.
# 끝까지 성공했을 때만 .dump 이름이 된다(중간 실패 시 잘린 파일이 백업처럼 남지 않음).
# 사용: scripts/ops/db-backup.sh [이름표]   → /opt/obs/backups/obs-<KST>-<이름표>.dump
. "$(dirname "$0")/lib.sh"

tag="${1:-manual}"
db="$(db_container)"; [ -n "$db" ] || die "DB 컨테이너가 없어요. docs/DEPLOY.md 「백업·복구」의 「DB 컨테이너가 없으면」을 따라 주세요."
docker start "$db" >/dev/null
for i in $(seq 1 30); do
  docker exec "$db" sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1 && break
  [ "$i" -eq 30 ] && die "DB가 준비되지 않았어요."
  sleep 2
done
mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
f="$BACKUP_DIR/obs-$(kst +%Y%m%d-%H%M%S)-$tag.dump"
umask 077
if ! docker exec "$db" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$f.part"; then
  rm -f "$f.part"; die "pg_dump 실패. 백업 파일을 만들지 않았어요."
fi
# 목록을 읽을 수 있는지(파일이 온전한지) 확인한 뒤에만 이름을 바꾼다.
if ! docker exec -i "$db" pg_restore -l < "$f.part" > /dev/null; then
  rm -f "$f.part"; die "백업 파일 검사(pg_restore -l) 실패."
fi
mv "$f.part" "$f"
log "백업: $f ($(stat -c %s "$f") bytes)"
echo "$f"
