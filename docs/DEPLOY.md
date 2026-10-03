# 테스트 서버(obs-test) 배포

이슈 #137. 대상은 KakaoCloud VM `obs-web-test`(Ubuntu 24.04, kr-central-2) 한 대예요. 운영(obs-web-prod) 배포는 이 문서 범위가 아니에요.

## 구성

| 파일 | 역할 |
| --- | --- |
| `Dockerfile` | 앱 이미지(Next.js standalone, `node server.js`) + 마이그레이션 이미지(`migrator` 단계) |
| `deploy/docker-compose.yml` | 프로젝트 `obs-web`: DB·마이그레이션·앱·프록시 |
| `deploy/Caddyfile` | 80·443을 받아 앱으로 넘기는 리버스 프록시 |
| `.github/workflows/deploy-obs-test.yml` | 수동 배포 워크플로(VM 안의 self-hosted runner에서 실행) |
| `app/api/health/route.ts` | `GET /api/health` 기동·DB 확인 |

| 서비스 | 내용 | 밖으로 여는 포트 |
| --- | --- | --- |
| `obs-web-db` | PostgreSQL 16. 데이터는 이름 있는 볼륨 `obs-web_obs-web-pgdata`에 보존 | 없음 |
| `obs-web-migrate` | `prisma migrate deploy`를 한 번 실행하고 끝남. 실패하면 앱이 뜨지 않음 | 없음 |
| `obs-web-app` | 앱(3000, compose 네트워크 안에서만). healthcheck가 `/api/health`를 봄 | 없음 |
| `obs-web-proxy` | Caddy. 앱이 healthy가 된 뒤 시작. 주소는 `.env`의 `OBS_SITE_ADDRESS`(기본 `:80`) | 80, 443 |

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

워크플로 `Deploy obs-test`가 하는 일:

1. 입력한 커밋 SHA가 실행 시점의 main과 같은지, `/opt/obs/.env`가 있는지 확인
2. main 체크아웃
3. DB가 있으면 배포 전 백업(`/opt/obs/backups/obs-<KST 시각>-before-<SHA 7자리>.dump`)
4. `docker compose ... up -d --build --wait`(마이그레이션 → 앱 healthy → 프록시)
5. `http://127.0.0.1/api/health`의 `version`이 배포 SHA이고 `db`가 `ok`인지 확인
6. 성공하면 `/opt/obs/deploy-history.log`에 KST 시각·SHA·실행 번호·실행자를 남기고 실행 요약에 표시

CI의 「No deploy workflows」 검사가 self-hosted runner를 이 워크플로 하나에만 허용하고, `workflow_dispatch` 말고 다른 트리거가 생기면 실패해요.

#### 배포 실행 순서

1. 배포할 main 커밋을 확인해요(저장소 첫 화면 또는 Commits에서 맨 위 커밋의 앞 7자리).
2. Actions → **Deploy obs-test** → **Run workflow**를 눌러요.
3. Branch는 **main** 그대로 두고, `confirm_sha`에 1의 앞 7자리를 넣고 실행해요.
   - 다른 브랜치를 고르면 job이 건너뛰어져요. 입력한 SHA가 main과 다르면(그새 병합이 있었으면) 멈춰요.
4. Environment `obs-test`에 Required reviewers가 있으면 **Review deployments → Approve**를 눌러요.
5. 끝나면 실행 요약의 「obs-test 배포 완료」와 커밋을 확인하고, 브라우저로 주소를 열어 봐요.

#### 실패했을 때

- 실행 화면에서 빨간 단계를 열어요. 실패하면 마지막 「Show status on failure」 단계가 컨테이너 상태와 마이그레이션·앱 로그 80줄을 보여 줘요.
- 단계별로 흔한 원인:

| 실패한 단계 | 확인할 것 |
| --- | --- |
| Check target commit | `confirm_sha`가 지금 main 맨 위 커밋과 같은지. `/opt/obs/.env`가 있는지 |
| Waiting for a runner(시작 안 함) | 서버에서 `sudo systemctl status 'actions.runner.*'`. runner가 꺼졌거나 라벨 `obs-kakao`가 없음 |
| Backup / Build and start에서 permission denied | `obs` 계정이 `docker` 그룹인지(`id obs`), 그룹 추가 뒤 runner를 재시작했는지 |
| Build and start | 마이그레이션 실패(`obs-web-migrate` 로그), `.env` 값 누락(`POSTGRES_*`), 디스크 부족(`df -h`) |
| Health check | `db":"error"`면 DB 컨테이너 상태, version이 다르면 이전 컨테이너가 남았는지(`docker ps`) |

- 실패해도 이전 컨테이너가 그대로 떠 있거나 일부만 바뀌었을 수 있어요. 아래 「로그」로 상태를 보고, 필요하면 「롤백」을 따라요.

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
| 443/tcp | HTTPS를 쓸 때 0.0.0.0/0 | 「HTTPS」 단계에서 열어요. 로그인 확인에 필요해요 |
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

- runner가 `obs` 계정으로 `docker compose`를 실행하므로 `docker` 그룹이 꼭 필요해요. 그룹을 추가한 뒤에는 runner 서비스를 다시 시작해야 반영돼요(`sudo systemctl restart 'actions.runner.*'`).
- `docker` 그룹은 서버에서 root와 같은 권한이에요. 이 계정에는 다른 용도를 주지 않고, 비밀번호 로그인·sudo 권한도 주지 않아요.

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
| `BILLING_PROVIDER` | 필수 | obs-test는 **`fake`**(실제 결제 금지, 2026-10-03 결정). **주의**: 지금 코드는 운영 빌드(`NODE_ENV=production`)에서 가짜 결제 공급자 생성을 막아요(`lib/server/billing/provider.ts`). 그래서 obs-test에서는 카드 등록·구독 결제가 오류로 멈춰요(비워도 같음). 실제 결제는 일어나지 않아요. **obs-test에서는 카드 등록·구독 결제가 동작하지 않는 것이 의도예요**(2026-10-03 결정) |
| `OBS_SITE_ADDRESS` | 선택 | 프록시 사이트 주소. 비우면 `:80`(HTTP). HTTPS는 아래 「HTTPS」 |
| `BUSINESS_STATUS_PROVIDER`, `NTS_BUSINESS_STATUS_API_KEY` | 선택 | 판매자 가입 사업자 상태 점검 |
| `MAIL_ORDER_PROVIDER`, `FTC_MAIL_ORDER_API_KEY` | 선택 | 통신판매업 점검 |
| `PORTONE_API_SECRET`, `PORTONE_STORE_ID`, `PORTONE_IDENTITY_CHANNEL_KEY` | 선택 | 휴대폰 본인확인. 없으면 가입 본인확인은 503 「준비 중」 |

`DATABASE_URL`과 `TRUSTED_PROXY_HOPS`(=1)는 compose가 만들어 넣어요. `.env`에 적지 않아요.
`.env`를 바꾼 뒤에는 재배포(또는 `up -d`)해야 반영돼요.

### 5. runner 등록

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
3. Settings → Environments → `obs-test`를 이렇게 설정하길 권해요.
   - Deployment branches and tags: **Selected branches** → `main`만
   - Required reviewers: **대표님** (실행할 때마다 승인 한 번)
4. 서버에서 `sudo systemctl status 'actions.runner.*'`가 active이고, GitHub Runners 화면에 `obs-web-test`가 Idle로 보이면 준비 끝이에요.
5. Settings → Actions → General → Fork pull request workflows는 승인 필요(기본값)로 둬요.

GitHub Secrets·Variables는 이 방식에서 필요 없어요(비밀값은 서버 `.env`에만).

## 서버 명령 준비

아래 섹션의 서버 명령은 `obs` 계정(`sudo -u obs -i`)에서 먼저 이 줄을 실행했다고 보고 `$C`를 써요. 새로 접속할 때마다 다시 실행해요.
`/opt/obs/src`가 아직 없으면(워크플로로만 배포한 경우) 먼저 `git clone https://github.com/jsexy0210-ship-it/Live-OBS-Platform.git /opt/obs/src`로 받아 두고, 쓰기 전에 `git -C /opt/obs/src fetch origin main && git -C /opt/obs/src checkout --detach origin/main`으로 main을 최신으로 맞춰요(compose 파일만 쓰고 이미지는 서버에 남은 것을 써요).

```bash
cd /opt/obs/src && C="docker compose -p obs-web -f deploy/docker-compose.yml --env-file /opt/obs/.env"
```

## 수동 배포(서버에서 직접, 워크플로를 쓸 수 없을 때)

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
cd /opt/obs/src && C="docker compose -p obs-web -f deploy/docker-compose.yml --env-file /opt/obs/.env"
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
  cd /opt/obs/src && C="docker compose -p obs-web -f deploy/docker-compose.yml --env-file /opt/obs/.env"
  $C exec -T obs-web-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM \"Seller\""'
  ```

## 롤백

이전 커밋의 이미지가 서버에 남아 있으면 빌드 없이 되돌려요.

```bash
cd /opt/obs/src && C="docker compose -p obs-web -f deploy/docker-compose.yml --env-file /opt/obs/.env"
docker image ls obs-web-app                 # 남아 있는 SHA 확인
APP_VERSION=<이전 SHA> $C up -d --no-build --wait
```

- 마이그레이션은 되돌리지 않아요. 새 버전이 DB 구조를 바꿨다면 배포 전 백업으로 복구한 뒤 이전 이미지를 띄워요.
- 근본 수정은 main에 되돌림 PR을 병합한 뒤 다시 배포해요.
- 쌓인 이미지는 `docker image ls`로 보고 필요 없는 SHA만 `docker image rm`으로 지워요.

## 로그

```bash
cd /opt/obs/src && C="docker compose -p obs-web -f deploy/docker-compose.yml --env-file /opt/obs/.env"
$C ps                                   # 상태·healthy 여부
$C logs -f --tail 200 obs-web-app       # 앱
$C logs --tail 100 obs-web-migrate      # 마이그레이션 결과
$C logs --tail 100 obs-web-proxy        # 프록시
```

## HTTPS

운영 빌드는 로그인 쿠키에 `Secure`를 붙여요(`lib/server/http/route.ts`). 그래서 **HTTP 주소(`http://210.109.15.68`)에서는 브라우저가 로그인 쿠키를 저장하지 않아 로그인이 유지되지 않아요.** 로그인까지 확인하려면 HTTPS가 필요해요.

### 도메인 구입 전: sslip.io(무료)

`210-109-15-68.sslip.io`처럼 IP를 넣은 이름은 따로 등록하지 않아도 그 IP로 연결돼요(sslip.io 무료 공용 DNS).

1. `/opt/obs/.env`에 `OBS_SITE_ADDRESS=210-109-15-68.sslip.io`를 넣어요.
2. 보안 그룹 `obs-web-sg`에서 443/tcp를 0.0.0.0/0으로 열어요(80도 열려 있어야 해요).
3. 재배포해요(또는 서버에서 「서버 명령 준비」 뒤 `$C up -d obs-web-proxy`). **보안 그룹 443을 열면 Caddy가 Let's Encrypt 무료 인증서를 자동으로 받아요**(`obs-web-caddy-data` 볼륨에 보관, 자동 갱신).
4. `https://210-109-15-68.sslip.io`로 접속해요. `http://`로 들어오면 HTTPS로 넘어가요.

한계:
- sslip.io는 남이 운영하는 공용 서비스예요. 장애가 나면 접속이 안 되고, 같은 상위 도메인을 많은 사람이 써서 인증서 발급 한도에 걸릴 수 있어요. **시험용으로만** 쓰고 실제 판매자·구매자에게 주소를 알리지 않아요.
- 서버 IP가 바뀌면 주소도 바뀌어요.
- 인증서를 받기 전(443이 막혀 있거나 발급 실패)에는 `https://` 접속이 안 돼요. `$C logs obs-web-proxy`에서 발급 결과를 볼 수 있어요.

### 도메인 확정 뒤

1. 도메인 DNS A 레코드를 `210.109.15.68`로 지정해요.
2. `/opt/obs/.env`의 `OBS_SITE_ADDRESS`를 그 도메인으로 바꾸고 재배포해요. 코드·설정 파일은 바꾸지 않아도 돼요.

배포 워크플로의 health check는 서버 안에서 `http://127.0.0.1`로 부르고, Caddyfile에 이 주소를 따로 두어서 사이트 주소를 바꿔도 그대로 동작해요.
