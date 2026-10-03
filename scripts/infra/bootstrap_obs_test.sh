#!/usr/bin/env bash
# 지정한 기존 Ubuntu VM에서만 관리자가 직접 실행한다. VM/Managed DB를 만들지 않는다.
set +x
set -euo pipefail
[[ ${EUID} == 0 && ${1:-} == --confirm-obs-web-test ]] || {
  echo 'sudo bash scripts/infra/bootstrap_obs_test.sh --confirm-obs-web-test' >&2; exit 1;
}
. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || { echo 'Ubuntu 24.04 대상만 허용합니다.' >&2; exit 1; }
[[ ! -L /opt/obs ]] || { echo '배포 경로가 심볼릭 링크입니다. 중단합니다.' >&2; exit 1; }
if [[ -e /opt/obs/target ]] && [[ "$(cat /opt/obs/target)" != obs-web-test ]]; then
  echo '기존 배포 대상이 다릅니다. 변경하지 않습니다.' >&2; exit 1
fi
apt-get update
apt-get install -y ca-certificates curl python3 git
install -m 0755 -d /etc/apt/keyrings
curl --fail --silent --show-error https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable\n' "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
id obs >/dev/null 2>&1 || useradd --create-home --shell /bin/bash obs
# Docker 그룹은 사실상 root 권한이다. Public 저장소 runner와 연결하지 않는다.
usermod -aG docker obs
install -d -m 0700 -o obs -g obs /opt/obs /opt/obs/backups /opt/obs/releases /opt/obs/actions-runner
printf 'obs-web-test\n' > /opt/obs/target
cp /etc/machine-id /opt/obs/machine-id
chmod 600 /opt/obs/target /opt/obs/machine-id
chown obs:obs /opt/obs/target /opt/obs/machine-id
if [[ ! -e /opt/obs/.env ]]; then
  umask 077
  python3 - <<'PY'
from pathlib import Path
import os, pwd, secrets
p=Path('/opt/obs/.env')
# 로컬 테스트 DB 사용은 담당자가 파일에서 1로 명시한 뒤에만 허용한다.
s='POSTGRES_USER=obs\nPOSTGRES_DB=obs_test\nOBS_ALLOW_LOCAL_DB=0\n'
s+=''.join(k+'='+secrets.token_hex(32)+'\n' for k in ('POSTGRES_PASSWORD','IDENTITY_HASH_KEY','BILLING_KEY_SECRET'))
with p.open('x') as f: f.write(s)
u=pwd.getpwnam('obs'); os.chown(p,u.pw_uid,u.pw_gid); p.chmod(0o600)
PY
fi
echo '기본 소프트웨어/경로 준비 완료. 비밀값은 출력하지 않았습니다.'
echo '다음: 로컬 테스트 DB 승인, Private 저장소/Environment 확인, runner 대화형 등록, DNS 확인.'
