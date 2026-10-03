# 테스트 서버(obs-test) 배포

이슈 #137. 대상은 KakaoCloud VM `obs-web-test`(Ubuntu 24.04, kr-central-2) 한 대예요. 운영(obs-web-prod) 배포는 이 문서 범위가 아니에요.

## 구성

| 파일 | 역할 |
| --- | --- |
| `Dockerfile` | 앱 이미지(Next.js standalone, `node server.js`) + 마이그레이션 이미지(`migrator` 단계) |
| `deploy/docker-compose.yml` | 프로젝트 `obs-web`: DB·마이그레이션·앱·프록시 |
| `deploy/Caddyfile` | 80 포트를 받아 앱으로 넘기는 리버스 프록시 |
| `app/api/health/route.ts` | `GET /api/health` 기동·DB 확인 |

| 서비스 | 내용 | 밖으로 여는 포트 |
| --- | --- | --- |
| `obs-web-db` | PostgreSQL 16. 데이터는 이름 있는 볼륨 `obs-web_obs-web-pgdata`에 보존 | 없음 |
| `obs-web-migrate` | `prisma migrate deploy`를 한 번 실행하고 끝남. 실패하면 앱이 뜨지 않음 | 없음 |
| `obs-web-app` | 앱(3000, compose 네트워크 안에서만). healthcheck가 `/api/health`를 봄 | 없음 |
| `obs-web-proxy` | Caddy. 앱이 healthy가 된 뒤 시작 | 80 |

- 실시간(SSE)은 DB `LISTEN/NOTIFY`로 전달돼요. 앱 컨테이너 하나 기준이고, 여러 개로 늘려도 DB를 통해 전달돼요.
- 이미지는 `obs-web-app:<커밋 SHA>`, `obs-web-migrate:<커밋 SHA>`로 남아요(롤백용).
- 레지스트리·Managed DB 등 유료 자원은 쓰지 않아요.

## `GET /api/health`

- DB에 `SELECT 1`이 되면 `200 {"status":"ok","db":"ok","version":"<커밋 SHA>"}`
- DB 연결이 안 되면 `503 {"status":"error","db":"error","version":...}`. 오류 내용·주소는 응답에 넣지 않아요.
- `version`은 이미지 빌드 때 넣은 `APP_VERSION`(커밋 SHA). 없으면 `null`.

## 배포 방식

### 권고: VM 안의 self-hosted runner

VM에 GitHub Actions runner(라벨 `obs-kakao`)를 설치하고, Actions 화면에서 수동 실행하면 runner가 main을 받아 VM에서 이미지를 빌드·기동하는 방식이에요.

- runner는 GitHub로 나가는 연결만 써요. SSH 22를 인터넷에 열 필요가 없어요.
- 비밀값은 서버의 `/opt/obs/.env`에만 있어요. GitHub Secrets에 DB 비밀번호를 둘 필요가 없어요.
- 레지스트리(GHCR 용량 과금 가능성) 없이 동작해요.
- 주의: runner가 받은 코드를 VM에서 그대로 실행해요. 그래서 배포 워크플로는 `workflow_dispatch`만, main만, Environment `obs-test`로 묶어야 하고, PR·다른 브랜치·fork에서는 절대 runner로 가지 않아야 해요.

**배포 워크플로 파일(`.github/workflows/deploy-obs-test.yml`)은 아직 없어요.** 이 작업 세션에서 작성하려 했지만 세션 권한 검사가 「운영 배포」로 분류해 막았어요. 대표님이 승인 범위를 다시 확인해 주시면 추가해요. 그 전까지는 아래 「수동 배포」로 같은 일을 할 수 있어요.
CI의 「No deploy workflows」 검사도 그대로 두었어요(워크플로를 넣을 때 `deploy-obs-test.yml` 하나만, `workflow_dispatch` 전용일 때만 허용하도록 같이 좁혀요).

### 대안: GitHub 호스팅 러너 + SSH

GitHub 러너가 SSH로 VM에 접속해 같은 compose 명령을 실행하는 방식이에요.

| | self-hosted runner(권고) | SSH |
| --- | --- | --- |
| 인터넷에 여는 포트 | 없음(나가는 연결만) | 22를 GitHub 러너 IP 대역 전체에 열어야 함(대역이 넓고 자주 바뀜) |
| GitHub에 두는 비밀값 | 없음 | SSH 개인키·호스트 키 |
| 서버에 설치할 것 | runner 서비스 | 없음 |
| 빌드 위치 | VM(4GB 메모리로 충분) | VM(동일) 또는 러너에서 빌드 후 이미지 전송 |
| 위험 | runner가 실행하는 워크플로를 엄격히 제한해야 함 | 키 유출 시 서버 접속 가능 |

22를 넓게 여는 게 더 큰 위험이라 runner 방식을 권해요.

## 서버 준비(대표님 조치, 순서대로)

모두 VM에서 대표님 계정으로 실행해요. 토큰·비밀번호는 서버에서 직접 입력하고 저장소·채팅·로그에 남기지 않아요.

### 1. 보안 그룹 `obs-web-sg`(KakaoCloud 콘솔)

| 포트 | 출발지 | 비고 |
| --- | --- | --- |
| 80/tcp | 0.0.0.0/0 | 서비스 |
| 443/tcp | 막음 | 도메인·HTTPS 설정 뒤 0.0.0.0/0 허용 |
| 22/tcp | 대표님 IP/32만 | 서버 관리 |
| 5432, 3000 등 | 막음 | DB·앱은 compose 안에서만 쓰고 호스트에도 열지 않음 |

나가는 연결(443)은 GitHub·Docker Hub·npm 접속에 필요해요.

### 2. Docker 설치

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
docker compose version
```

### 3. 작업 폴더 `/opt/obs`

```bash
sudo useradd -m -s /bin/bash obs            # 배포 전용 계정(runner도 이 계정으로 실행)
sudo usermod -aG docker obs
sudo mkdir -p /opt/obs/backups
sudo chown -R obs:obs /opt/obs
sudo chmod 700 /opt/obs /opt/obs/backups
```

`docker` 그룹은 root와 같은 권한이에요. 이 계정에는 다른 용도를 주지 않아요.

### 4. 서버 `.env`(`/opt/obs/.env`, 권한 600)

```bash
sudo -u obs touch /opt/obs/.env && sudo -u obs chmod 600 /opt/obs/.env
sudo -u obs nano /opt/obs/.env
```

넣을 변수 **이름**(값은 대표님이 직접 입력):

| 변수 | 필수 | 내용 |
| --- | --- | --- |
| `POSTGRES_USER` | 필수 | DB 계정 이름 |
| `POSTGRES_PASSWORD` | 필수 | DB 비밀번호. 접속 주소에 그대로 들어가서 **영문·숫자만** 써요(`openssl rand -hex 24`로 만들면 돼요) |
| `POSTGRES_DB` | 필수 | DB 이름 |
| `IDENTITY_HASH_KEY` | 필수 | 본인확인 CI 해시 키(32자 이상) |
| `BILLING_KEY_SECRET` | 필수 | 빌링키 암호화 키(32자 이상) |
| `BILLING_PROVIDER` | 결정 필요 | 결제 공급자. 실제 업체 연동 전이라 지금 값은 `fake`뿐이에요. 비우면 결제 경로는 오류로 멈춰요 |
| `BUSINESS_STATUS_PROVIDER`, `NTS_BUSINESS_STATUS_API_KEY` | 선택 | 판매자 가입 사업자 상태 점검 |
| `MAIL_ORDER_PROVIDER`, `FTC_MAIL_ORDER_API_KEY` | 선택 | 통신판매업 점검 |
| `PORTONE_API_SECRET`, `PORTONE_STORE_ID`, `PORTONE_IDENTITY_CHANNEL_KEY` | 선택 | 휴대폰 본인확인. 없으면 가입 본인확인은 503 「준비 중」 |

`DATABASE_URL`과 `TRUSTED_PROXY_HOPS`(=1)는 compose가 만들어 넣어요. `.env`에 적지 않아요.
`.env`를 바꾼 뒤에는 재배포(또는 `up -d`)해야 반영돼요.

### 5. runner 등록(배포 워크플로 추가 뒤)

1. GitHub 저장소 → Settings → Actions → Runners → New self-hosted runner → Linux x64. 화면의 다운로드·`config.sh` 명령을 그대로 써요. **토큰은 화면에서 복사해 서버에서만 입력해요.**
2. 서버에서 `obs` 계정으로 `/opt/obs/actions-runner`에 설치하고 등록할 때 라벨 `obs-kakao`를 추가해요.
   ```bash
   sudo -u obs -i
   mkdir -p /opt/obs/actions-runner && cd /opt/obs/actions-runner
   # (GitHub 화면의 다운로드·압축 해제 명령)
   ./config.sh --url https://github.com/jsexy0210-ship-it/Live-OBS-Platform --labels obs-kakao --name obs-web-test --unattended --token <화면의 토큰>
   exit
   cd /opt/obs/actions-runner && sudo ./svc.sh install obs && sudo ./svc.sh start
   ```
3. Settings → Environments → `obs-test` → Deployment branches를 `main`만 허용으로 바꿔요. 필요하면 Required reviewers에 대표님을 넣어요.
4. Settings → Actions → General → Fork pull request workflows는 승인 필요(기본값)로 둬요.

GitHub Secrets·Variables는 이 방식에서 필요 없어요(비밀값은 서버 `.env`에만).

## 수동 배포(서버에서 직접)

```bash
sudo -u obs -i
git clone https://github.com/jsexy0210-ship-it/Live-OBS-Platform.git /opt/obs/src   # 처음 한 번
cd /opt/obs/src && git fetch origin main && git checkout --detach origin/main
export APP_VERSION=$(git rev-parse HEAD)
docker compose -p obs-web -f deploy/docker-compose.yml --env-file /opt/obs/.env up -d --build --wait
curl -s http://127.0.0.1/api/health      # status ok, version = 위 SHA 확인
echo "$(TZ=Asia/Seoul date '+%F %T KST') sha=$APP_VERSION" >> /opt/obs/deploy-history.log
```

배포 전 백업(아래)을 먼저 받아 두세요.

## 백업·복구

```bash
cd /opt/obs/src
C="docker compose -p obs-web -f deploy/docker-compose.yml --env-file /opt/obs/.env"
# 백업
$C exec -T obs-web-db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > /opt/obs/backups/obs-$(TZ=Asia/Seoul date +%Y%m%d-%H%M).dump
chmod 600 /opt/obs/backups/*.dump
# 복구(현재 DB 내용을 백업 시점으로 덮어써요)
$C stop obs-web-app
$C exec -T obs-web-db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < /opt/obs/backups/<파일>.dump
$C start obs-web-app
```

백업 파일은 VM 디스크(30GB)에 쌓이니 주기적으로 VM 밖(대표님 PC 등)으로 옮겨 두고 오래된 것은 직접 정리해요.

## 데이터 보존 확인

- `docker compose ... restart`, `down` 후 `up`, 재배포 모두 볼륨 `obs-web_obs-web-pgdata`는 그대로예요.
- **`down -v`와 `docker volume rm`은 DB를 지워요. 쓰지 않아요.**
- 확인: 재배포 전후로 같은 행 수를 비교해요.
  ```bash
  $C exec -T obs-web-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM \"Seller\""'
  ```

## 롤백

이전 커밋의 이미지가 서버에 남아 있으면 빌드 없이 되돌려요.

```bash
docker image ls obs-web-app                 # 남아 있는 SHA 확인
APP_VERSION=<이전 SHA> $C up -d --no-build --wait
```

- 마이그레이션은 되돌리지 않아요. 새 버전이 DB 구조를 바꿨다면 배포 전 백업으로 복구한 뒤 이전 이미지를 띄워요.
- 근본 수정은 main에 되돌림 PR을 병합한 뒤 다시 배포해요.
- 쌓인 이미지는 `docker image ls`로 보고 필요 없는 SHA만 `docker image rm`으로 지워요.

## 로그

```bash
$C ps                                   # 상태·healthy 여부
$C logs -f --tail 200 obs-web-app       # 앱
$C logs --tail 100 obs-web-migrate      # 마이그레이션 결과
$C logs --tail 100 obs-web-proxy        # 프록시
```

## HTTPS(도메인 확정 뒤)

1. 도메인 DNS A 레코드를 `210.109.15.68`로 지정해요.
2. `deploy/Caddyfile`의 `:80`을 도메인 이름으로 바꾸고, compose 프록시에 `443:443`을 추가하는 PR을 올려요.
3. 보안 그룹에서 443을 열어요. Caddy가 인증서를 자동으로 받아요(무료, `obs-web-caddy-data` 볼륨에 보관).

## 알려진 문제

- **HTTP(IP:80)에서는 로그인이 유지되지 않아요.** 운영 빌드는 로그인 쿠키에 `Secure`를 붙여서 브라우저가 HTTP 주소에서는 저장하지 않아요(`lib/server/http/route.ts`). 화면·API 확인은 되지만 로그인 흐름은 HTTPS(도메인) 뒤에 확인할 수 있어요.
