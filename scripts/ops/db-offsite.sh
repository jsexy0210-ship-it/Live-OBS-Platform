#!/usr/bin/env bash
# 운영 DB 백업을 VM 밖(카카오 오브젝트 스토리지, S3 호환)으로 보낸다. 매일 한 번 cron으로 실행한다.
# 새 백업을 만들고(db-backup.sh) 올린 뒤, 올라간 크기가 같은지 확인해야 성공이다. 실패하면 0이 아닌 값으로 끝난다.
# 사용: scripts/ops/db-offsite.sh            (백업 생성 + 업로드)
#       scripts/ops/db-offsite.sh <파일>     (이미 있는 백업 파일만 업로드)
# 필요한 .env 값(이름만, 값은 서버에서 직접 넣는다): BACKUP_S3_ENDPOINT, BACKUP_S3_REGION, BACKUP_S3_BUCKET,
#   BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY. 이미지 버킷과 다른 백업 전용 버킷·키를 쓴다.
# 비밀 키는 명령줄 인자로 넘기지 않는다(ps에 보이지 않게 curl 설정을 표준입력으로 준다).
# 보관 기간(예: 30일 뒤 삭제)은 버킷의 수명 주기 규칙으로 콘솔에서 설정한다. 이 스크립트는 지우지 않는다.
. "$(dirname "$0")/lib.sh"

# .env에서 값 한 개를 읽는다(source하지 않는다. 마지막 줄 우선, 양쪽 따옴표 제거).
envval() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }
endpoint="$(envval BACKUP_S3_ENDPOINT)"; region="$(envval BACKUP_S3_REGION)"; bucket="$(envval BACKUP_S3_BUCKET)"
akid="$(envval BACKUP_S3_ACCESS_KEY_ID)"; secret="$(envval BACKUP_S3_SECRET_ACCESS_KEY)"
for n in endpoint region bucket akid secret; do
  [ -n "${!n}" ] || die "BACKUP_S3_* 값이 .env에 모두 있어야 해요(비어 있는 항목: $n)."
done
case "$endpoint" in https://*) ;; *) die "BACKUP_S3_ENDPOINT는 https:// 주소여야 해요." ;; esac
endpoint="${endpoint%/}"

if [ $# -ge 1 ]; then
  f="$1"; [ -f "$f" ] || die "파일이 없어요: $f"
else
  f="$("$(dirname "$0")/db-backup.sh" daily | tail -n1)"; [ -f "$f" ] || die "백업 파일을 찾지 못했어요."
fi
name="$(basename "$f")"
key="prod/daily/$name"
size="$(stat -c %s "$f")"
sha="$(sha256sum "$f" | cut -d' ' -f1)"
url="$endpoint/$bucket/$key"
sig="aws:amz:$region:s3"

curl_s3() { # curl_s3 <curl 인자...>: 비밀은 설정으로만 준다
  printf 'user = "%s:%s"\n' "$akid" "$secret" | curl -sS --fail-with-body --max-time 600 -K - --aws-sigv4 "$sig" "$@"
}

log "오프사이트 업로드 시작: $key ($size bytes)"
curl_s3 -X PUT -H "x-amz-content-sha256: $sha" -T "$f" -o /dev/null "$url" || die "업로드 실패(주소·키·버킷 권한을 확인해 주세요)."
remote="$(curl_s3 -I -H "x-amz-content-sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" "$url" | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2}')"
[ "$remote" = "$size" ] || die "올린 파일 크기가 달라요(로컬 $size, 원격 ${remote:-확인 불가}). 다시 시도해 주세요."
log "오프사이트 백업 완료: $key"
