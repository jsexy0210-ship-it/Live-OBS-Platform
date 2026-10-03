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

VM에 GitHub Actions runner(라벨 `obs-kakao`)를 **상시 서비스로 등록**해 두고, Actions 화면에서 수동 실행하면 runner가 main을 받아 VM에서 이미지를 빌드·기동하는 방식이에요(2026-10-03 대표님 결정, 아래 「runner 보안」). **먼저 꼭 할 설정**: Settings → Actions → General → 「Approval for running fork pull request workflows from contributors」를 **Require approval for all external contributors**로 바꿔요(이 설정 없이 runner를 등록하지 않아요).

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

runner는 처음 한 번 상시 서비스로 등록해 둬요(「서버 준비」 5번). 그 뒤 배포할 때마다 이 순서를 따라요.

1. 배포할 main 커밋을 확인해요(저장소 첫 화면 또는 Commits에서 맨 위 커밋의 앞 7자리).
2. Actions → **Deploy obs-test** → **Run workflow**를 눌러요. Branch는 **main** 그대로 두고, `confirm_sha`에 1의 앞 7자리를 넣고 실행해요.
   - 다른 브랜치를 고르면 job이 건너뛰어져요. 입력한 SHA가 main과 다르면(그새 병합이 있었으면) 멈춰요.
3. Environment `obs-test`에 Required reviewers가 있으면 **Review deployments → Approve**를 눌러요.
4. 끝나면 실행 요약의 「obs-test 배포 완료」와 커밋을 확인하고, 브라우저로 주소를 열어 봐요.

#### 실패했을 때

- 실행 화면에서 빨간 단계를 열어요. 실패하면 마지막 「Show status on failure」 단계가 컨테이너 상태와 마이그레이션·앱 로그 80줄을 보여 줘요.
- 단계별로 흔한 원인:

| 실패한 단계 | 확인할 것 |
| --- | --- |
| Check target commit | `confirm_sha`가 지금 main 맨 위 커밋과 같은지. `/opt/obs/.env`가 있는지 |
| Waiting for a runner(시작 안 함) | 서버에서 `sudo bash -c 'cd /home/obs && ./svc.sh status'`가 active인지, GitHub Runners 화면에 `obs-web-test`가 Idle인지, 등록 때 라벨 `obs-kakao`를 넣었는지 |
| Backup / Build and start에서 permission denied | `obs` 계정이 `docker` 그룹인지(`id obs`). 그룹을 추가한 뒤에는 runner 서비스를 다시 시작해야 해요(`sudo ./svc.sh stop && sudo ./svc.sh start`) |
| Build and start | 마이그레이션 실패(`obs-web-migrate` 로그), `.env` 값 누락(`POSTGRES_*`), 디스크 부족(`df -h`) |
| Health check | `db":"error"`면 DB 컨테이너 상태, version이 다르면 이전 컨테이너가 남았는지(`docker ps`) |

- 실패해도 이전 컨테이너가 그대로 떠 있거나 일부만 바뀌었을 수 있어요. 아래 「로그」로 상태를 보고, 필요하면 「롤백」을 따라요.

#### runner 보안: 공개 저장소 + 상시 runner(남은 위험을 알고 쓰기로 함)

워크플로의 `if`(main만)와 Environment `obs-test`는 **배포 워크플로 job만** 막아요. 다른 워크플로가 `runs-on: [self-hosted, obs-kakao]`를 쓰면 같은 runner로 갈 수 있어요. 예를 들어 PR이 `ci.yml`(pull_request로 실행)을 고쳐 이 라벨을 고르면, 그 PR 코드가 VM에서 `obs` 계정(docker 그룹 = root와 같은 권한)으로 실행돼 `/opt/obs/.env`를 읽을 수 있어요. CI의 「No deploy workflows」 검사도 PR이 함께 고칠 수 있어서 막지 못해요. 개인 계정 저장소라 runner를 특정 워크플로에만 묶는 runner 그룹도 쓸 수 없어요.

**2026-10-03 대표님 결정: 저장소는 공개로 두고 runner는 상시 등록해요. 위 위험은 알고 받아들였어요.** 대신 아래를 꼭 지켜요.

- **필수 설정**: Settings → Actions → General → 「Approval for running fork pull request workflows from contributors」 = **Require approval for all external contributors**. 외부 기여자의 PR 워크플로는 승인 전에는 실행되지 않아요.
- 외부 기여자 PR의 워크플로를 승인하기 전에 그 PR이 `.github/workflows/`를 바꿨는지, 특히 `runs-on`에 `self-hosted`·`obs-kakao`를 넣었는지 **반드시** 확인해요. 바꿨으면 승인하지 않아요.
- 저장소에 쓰기 권한자(Collaborator)를 늘리지 않아요. 쓰기 권한자의 브랜치 PR은 승인 없이 실행돼요.
- GitHub Runners 화면에서 runner가 받은 job 기록을 가끔 확인해요(배포 워크플로 말고 다른 job이 있으면 아래 「이상할 때」).

이상할 때(배포가 아닌 job을 runner가 받았을 때):
1. 서버에서 `sudo bash -c 'cd /home/obs && ./svc.sh stop'`으로 멈추고, GitHub Runners 화면에서 `obs-web-test`를 지워요.
2. 그 job의 실행 화면을 열어 어느 워크플로·PR인지 기록해 MASTER에 알려요.
3. `/opt/obs/.env`의 비밀값(DB 비밀번호·키)을 바꾸는 것을 검토해요(DB 비밀번호는 「서버 .env」의 변경 절차).

#### 대안: 배포할 때만 1회용 runner(위험을 더 줄이고 싶을 때)

상시 runner를 지우고(`sudo ./svc.sh stop && sudo ./svc.sh uninstall`, `./config.sh remove --token <제거 토큰>`), 배포할 때마다 등록해요.

1. Settings → Actions → Runners → **New self-hosted runner**에서 등록 토큰을 복사해요(1시간 유효, 서버에서만 입력).
2. 서버에서:
   ```bash
   sudo -u obs -i
   cd /opt/obs/actions-runner
   ./config.sh --url https://github.com/jsexy0210-ship-it/Live-OBS-Platform --labels obs-kakao --name obs-web-test --ephemeral --unattended --token <토큰>
   ./run.sh      # job 하나를 받아 끝나면 스스로 종료돼요
   ```
3. `Listening for Jobs`가 보이면 바로 Run workflow를 실행하고, 서버 창에 `Running job: Deploy to obs-test`가 보이는지 확인해요(다른 job이면 `Ctrl+C`).
4. 끝난 뒤 `run.sh`가 종료되고 Runners 화면에서 `obs-web-test`가 사라졌는지 확인해요.

### 대안: GitHub 호스팅 러너 + SSH

GitHub 러너가 SSH로 VM에 접속해 같은 compose 명령을 실행하는 방식이에요.

| | 상시 self-hosted runner(채택) | SSH |
| --- | --- | --- |
| 인터넷에 여는 포트 | 없음(나가는 연결만) | 22를 GitHub 러너 IP 대역 전체에 열어야 함(대역이 넓고 자주 바뀜) |
| GitHub에 두는 비밀값 | 없음 | SSH 개인키·호스트 키 |
| 서버에 설치할 것 | runner 서비스(상시) | 없음 |
| 빌드 위치 | VM(4GB 메모리로 충분) | VM(동일) 또는 러너에서 빌드 후 이미지 전송 |
| 위험 | 다른 워크플로가 runner를 잡을 수 있음(외부 PR 승인 설정·승인 전 확인으로 줄임) | 키 유출 시 서버 접속 가능 |

22를 넓게 여는 게 더 큰 위험이라 self-hosted runner 방식을 택했고, 대표님 결정으로 상시 runner로 운영해요(2026-10-03).

## 서버 준비(대표님 조치, 순서대로)

모두 VM에서 대표님 계정으로 실행해요. 토큰·비밀번호는 서버에서 직접 입력하고 저장소·채팅·로그에 남기지 않아요.

### 1. 보안 그룹 `obs-web-sg`(KakaoCloud 콘솔)

| 포트 | 출발지 | 비고 |
| --- | --- | --- |
| 80/tcp | 0.0.0.0/0 | 서비스 |
| 443/tcp | 0.0.0.0/0 | HTTPS(`test.on-aircue.com`). 로그인 확인과 인증서 발급에 필요해요 |
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

- runner가 `obs` 계정으로 `docker compose`를 실행하므로 `docker` 그룹이 꼭 필요해요. 그룹은 새로 접속할 때 반영되니, 추가한 뒤에는 runner 서비스를 다시 시작해요(`sudo ./svc.sh stop && sudo ./svc.sh start`).
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
| `OBS_SITE_ADDRESS` | 필수(HTTPS) | obs-test는 `test.on-aircue.com`. 비우면 `:80`(HTTP만, 로그인 유지 안 됨). 아래 「HTTPS」 |
| `BUSINESS_STATUS_PROVIDER`, `NTS_BUSINESS_STATUS_API_KEY` | 선택 | 판매자 가입 사업자 상태 점검 |
| `MAIL_ORDER_PROVIDER`, `FTC_MAIL_ORDER_API_KEY` | 선택 | 통신판매업 점검 |
| `PORTONE_API_SECRET`, `PORTONE_STORE_ID`, `PORTONE_IDENTITY_CHANNEL_KEY` | 선택 | 휴대폰 본인확인. 없으면 가입 본인확인은 503 「준비 중」 |
| `OBS_ENVIRONMENT` | 필수(obs-test) | **`test`**. 장애 주입·가용성 프로파일·무중단 배포 스크립트는 이 줄이 있을 때만 돌아요. 운영 서버에는 넣지 않아요 |
| `OBS_MONITOR_TLS_HOST` | 선택 | 서버 감시가 인증서 만료일을 볼 주소(obs-test는 `test.on-aircue.com`) |
| `OBS_ALERT_URL` | 선택 | 장애 알림을 받을 주소(웹훅). 알림 채널이 정해지기 전에는 비워 둬요(기록만 남아요) |
| `OBS_MONITOR_INTERVAL_S` | 선택 | 감시 간격(기본 15초) |

`DATABASE_URL`과 `TRUSTED_PROXY_HOPS`(=1)는 compose가 만들어 넣어요. `.env`에 적지 않아요.
`.env`를 바꾼 뒤에는 재배포(또는 `up -d`)해야 반영돼요.

**`POSTGRES_USER`·`POSTGRES_PASSWORD`·`POSTGRES_DB`는 첫 배포 때 DB를 만들 때만 쓰여요.** 그 뒤에 `.env` 값만 바꾸면 DB 안의 계정은 그대로라서 앱과 마이그레이션이 접속에 실패해요. 비밀번호를 바꿀 때는 DB 안의 비밀번호를 먼저 바꾸고 `.env`를 맞춰요(아래 「서버 명령 준비」를 먼저 실행).

```bash
$C exec obs-web-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
# psql 안에서: \password <POSTGRES_USER 값>   ← 새 비밀번호를 두 번 입력(화면·기록에 남지 않음), 끝나면 \q
nano /opt/obs/.env      # POSTGRES_PASSWORD를 같은 새 값으로
$C up -d --wait         # 같은 버전 그대로, 앱·마이그레이션이 새 비밀번호로 접속
```

계정 이름·DB 이름은 바꾸지 않아요(바꾸려면 백업 → 새 DB로 복구가 필요해요).

### 5. runner 등록(처음 한 번, 상시 서비스)

**먼저** Settings → Actions → General → 「Approval for running fork pull request workflows from contributors」를 **Require approval for all external contributors**로 바꿔요(「runner 보안」). 이 설정 전에는 runner를 등록하지 않아요.

1. GitHub 저장소 → Settings → Actions → Runners → **New self-hosted runner** → Linux x64 화면을 열어요. **등록 토큰은 서버에서만 입력하고 채팅·문서에 남기지 않아요.**
2. 서버에서 `obs` 계정으로 설치·등록해요.
   ```bash
   sudo -u obs -i
   mkdir -p /opt/obs/actions-runner && cd /opt/obs/actions-runner
   # (GitHub 화면의 다운로드·압축 해제 명령)
   ./config.sh --url https://github.com/jsexy0210-ship-it/Live-OBS-Platform --labels obs-kakao --name obs-web-test --unattended --token <화면의 토큰>
   exit
   ```
3. 서비스로 등록하고 시작해요(관리자 계정에서). `/opt/obs`는 `obs` 계정만 열 수 있어서 `sudo bash -c`로 들어가요.
   ```bash
   sudo bash -c 'cd /opt/obs/actions-runner && ./svc.sh install obs && ./svc.sh start && ./svc.sh status'   # active (running)이면 돼요
   ```
   - 지금 obs-test 서버(obs-web-test)의 runner는 `/home/obs`에 설치돼 있어요(2026-10-03). 그 서버에서는 위·아래 명령의 `/opt/obs/actions-runner`를 `/home/obs`로 바꿔 써요.
   GitHub Runners 화면에 `obs-web-test`가 **Idle**로 보이면 끝이에요.
4. Settings → Environments → `obs-test`를 이렇게 설정하길 권해요.
   - Deployment branches and tags: **Selected branches** → `main`만
   - Required reviewers: **대표님** (실행할 때마다 승인 한 번)

GitHub Secrets·Variables는 이 방식에서 필요 없어요(비밀값은 서버 `.env`에만).

## 서버 명령 준비

아래 섹션의 서버 명령은 `obs` 계정(`sudo -u obs -i`)에서 먼저 이 줄을 실행했다고 보고 `$C`를 써요. 새로 접속할 때마다 다시 실행해요.
`/opt/obs/src`가 아직 없으면(워크플로로만 배포한 경우) 먼저 `git clone https://github.com/jsexy0210-ship-it/Live-OBS-Platform.git /opt/obs/src`로 받아 두고, 쓰기 전에 `git -C /opt/obs/src fetch origin main && git -C /opt/obs/src checkout --detach origin/main`으로 main을 최신으로 맞춰요(compose 파일만 쓰고 이미지는 서버에 남은 것을 써요).

```bash
cd /opt/obs/src && C="docker compose -p obs-web -f deploy/docker-compose.yml --env-file /opt/obs/.env"
# 지금 떠 있는 앱 이미지의 커밋 SHA. 이 값이 있어야 `$C up`이 새로 빌드하지 않고 같은 이미지를 다시 써요.
export APP_VERSION=$(docker ps -a --filter label=com.docker.compose.project=obs-web --filter label=com.docker.compose.service=obs-web-app --format '{{.Image}}' | head -1 | cut -d: -f2)
echo "현재 버전: ${APP_VERSION:-없음}"
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

DB 컨테이너가 없으면(`down` 뒤 등, 배포 워크플로가 「DB 컨테이너가 없어요」로 멈췄을 때) 먼저 `/opt/obs/src`를 **지금 서버에 떠 있던 버전**으로 맞추고(`git -C /opt/obs/src checkout --detach <이전 배포 SHA>`, `/opt/obs/deploy-history.log` 마지막 줄) `$C up -d --wait obs-web-db`로 DB만 띄운 뒤 백업해요.

```bash
cd /opt/obs/src && C="docker compose -p obs-web -f deploy/docker-compose.yml --env-file /opt/obs/.env"
# 백업
# 끝까지 성공했을 때만 .dump 이름으로 바꿔요(중간에 실패하면 잘린 파일이 백업처럼 남지 않게)
f=/opt/obs/backups/obs-$(TZ=Asia/Seoul date +%Y%m%d-%H%M).dump
(umask 077; $C exec -T obs-web-db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$f.part") && mv "$f.part" "$f" && echo "백업: $f" || { rm -f "$f.part"; echo "백업 실패"; }
# 복구(현재 DB를 지우고 백업 시점으로 다시 만들어요. 백업 뒤에 생긴 표·데이터도 남지 않아요)
$C stop obs-web-app
$C exec -T obs-web-db sh -c 'psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE \"$POSTGRES_DB\" WITH (FORCE)" -c "CREATE DATABASE \"$POSTGRES_DB\""'
$C exec -T obs-web-db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < /opt/obs/backups/<파일>.dump
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

- 스크립트로 하면 더 간단해요: `scripts/ops/rollback-app.sh [이전 SHA]`(「운영 스크립트」). SHA를 비우면 배포 기록에서 바로 앞 버전을 골라요.
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

## 운영 스크립트(`scripts/ops/`)

서버에서 `obs` 계정으로 `/opt/obs/src`(「서버 명령 준비」로 main에 맞춘 상태)에서 실행해요. 비밀값은 출력하지 않아요. 결과는 `/opt/obs/checks`, 백업은 `/opt/obs/backups`에 남아요.

| 스크립트 | 하는 일 | 테스트 서버 전용 |
| --- | --- | --- |
| `data-snapshot.sh [이름표]` | 표마다 행 수·적용된 마이그레이션 수·DB 볼륨 생성 시각을 파일로 남겨요(읽기만) | 아니요 |
| `db-backup.sh [이름표]` | 지금 DB를 그대로 깨워 백업. 끝까지 성공하고 파일 검사(`pg_restore -l`)를 통과해야 `.dump`가 돼요 | 아니요 |
| `db-restore.sh <파일>` | 파일 검사 → 지금 DB 안전 백업 → 앱 중지 → DB 다시 만들기 → 복원 → **지금 버전 마이그레이션 적용**(백업이 더 오래된 스키마여도 앱과 맞춤) → 앱 시작 → health. **DB 이름을 직접 입력해야 진행** | 아니요 |
| `rollback-app.sh [SHA] [--force-unchecked]` | 앱만 이전 이미지로(DB 그대로, 빌드 없음). 되돌릴 버전이 모르는 마이그레이션이 DB에 있으면 경고 → health version 확인 → 배포 기록에 남김. 그 버전의 migrate 이미지가 없으면 스키마 호환을 확인할 수 없어 멈추고, `--force-unchecked`일 때만 경고 후 진행 | 아니요 |
| `availability.sh on\|off\|status` | 가용성 프로파일 켜기·끄기 | 예 |
| `rolling-deploy.sh [SHA]` | 가용성 프로파일에서 앱을 하나씩 교체 | 예 |
| `chaos.sh ...` | 장애 주입(앱 멈춤·강제 종료·충돌·얼림, DB 얼림·재시작) | 예 |
| `measure.sh <이름표> [초] [초당 요청]` | 가용률·오류율·p50/p95/p99·장애 구간·복구 시간 측정(JSON) | 예 |
| `monitor.mjs` | 서버 감시 수집기(「서버 감시」). compose `--profile monitor`로 띄워요 | 아니요 |

「테스트 서버 전용」은 `.env`에 `OBS_ENVIRONMENT=test`가 없으면 실행을 거부해요. 웹 주소로는 노출하지 않고, 서버에서 docker 권한이 있는 사람만 실행할 수 있어요.

## #137 남은 검증 절차(대표님이 서버에서 실행)

이슈 #137의 남은 확인 항목 세 가지예요. 코드 롤백(앱 이미지)과 DB 복원은 **따로** 해요. 실행 결과(출력 마지막 줄·파일 이름)를 MASTER에 보내 주시면 이슈에 기록해요.

준비(한 번):
```bash
sudo -u obs -i
git clone https://github.com/jsexy0210-ship-it/Live-OBS-Platform.git /opt/obs/src 2>/dev/null || true
cd /opt/obs/src && git fetch origin main && git checkout --detach origin/main
C="docker compose -p obs-web -f deploy/docker-compose.yml --env-file /opt/obs/.env"
export APP_VERSION=$(docker ps -a --filter label=com.docker.compose.project=obs-web --filter label=com.docker.compose.service=obs-web-app --format '{{.Image}}' | head -1 | cut -d: -f2)
```

**1. 재시작·재배포·재부팅 뒤 영속 데이터 보존**
```bash
a=$(scripts/ops/data-snapshot.sh before | tail -1)
$C restart                                          # ① 컨테이너 재시작
b=$(scripts/ops/data-snapshot.sh after-restart | tail -1); diff "$a" "$b" && echo "재시작: 같음"
# ② Actions → Deploy obs-test로 재배포(같은 main SHA도 됨)한 뒤
c=$(scripts/ops/data-snapshot.sh after-redeploy | tail -1); diff "$a" "$c" && echo "재배포: 같음"
# ③ sudo reboot → 다시 접속해 `cd /opt/obs/src` 뒤
d=$(ls -t /opt/obs/checks/snapshot-*-before.txt | head -1)
e=$(scripts/ops/data-snapshot.sh after-reboot | tail -1); diff "$d" "$e" && echo "재부팅: 같음"
```
- 「같음」이면 통과예요. 그 사이 시험 서버에 누가 가입·주문했다면 그 표만 늘어날 수 있어요(첫 줄의 볼륨 생성 시각은 같아야 해요).
- 재부팅 뒤 컨테이너는 `restart: unless-stopped`로 자동으로 떠요. `curl -s http://127.0.0.1/api/health`로 확인해요.

**2. 직전 릴리스로 앱 롤백(DB 그대로)**
```bash
docker image ls obs-web-app                         # 이전 SHA 이미지가 있어야 해요(최소 2번 배포한 뒤)
scripts/ops/rollback-app.sh                         # 배포 기록에서 바로 앞 버전으로. 「롤백 완료: health ok, version=…」
scripts/ops/rollback-app.sh <원래 SHA>              # 다시 최신으로(또는 Actions에서 main 재배포)
```

**3. DB 백업·복원(코드 롤백과 별개)**
```bash
f=$(scripts/ops/db-backup.sh verify | tail -1)      # 백업
a=$(scripts/ops/data-snapshot.sh before-restore-test | tail -1)
scripts/ops/db-restore.sh "$f"                      # DB 이름을 입력하면 진행. 끝에 「복원 완료 … health ok」
b=$(scripts/ops/data-snapshot.sh after-restore-test | tail -1); diff "$a" "$b" && echo "복원: 같음"
```
- 시험 서버에서 백업한 그 파일로 바로 되돌리는 것이라 데이터는 그대로예요. 복원 직전 상태도 `before-restore` 백업으로 따로 남아요.

이 컨테이너(로컬 Docker)에서 같은 스크립트로 돌린 결과(2026-10-04, 실제 서버 결과 아님): 재시작·down→up·Docker 데몬 재시작 뒤 스냅숏 차이 없음 / 롤백 → health version 바뀜·다시 최신으로 / 모르는 마이그레이션 경고 표시 / 복원 뒤 백업 이후 추가한 행·표 사라짐, health ok / DB 이름을 틀리면 중단.

## 가용성 프로파일(테스트 환경 전용, ONQ 단계 8)

`deploy/compose.availability.yml` + `deploy/Caddyfile.availability`. 기본 정의 위에 덧붙여요.

- 앱 2개(`obs-web-app`, `obs-web-app-2`), health 기반 프록시(Caddy: 2초마다 `/api/health`, 응답 헤더 2초 제한, 실패한 앱 5초 제외, GET은 다른 앱으로 재시도), 자원 제한(DB 1 vCPU·1GB, 앱 각 0.75 vCPU·768MB, 프록시 0.25·128MB).
- **같은 VM 안의 복제 프로세스예요. 앱 프로세스 장애와 무중단 배포는 시험할 수 있지만 VM(호스트)·디스크·DB 장애 내성은 증명하지 않아요.** DB는 하나라 단일 장애 지점이에요.
- **worker는 아직 없어요.** 앱에 작업 큐·worker 프로세스가 생기면(기반·자동연결 세션, ONQ 단계 4·5) 같은 방식으로 `obs-web-worker` 2개를 더해요. 그 전에는 「worker 2개 이상」을 시험할 수 없어요.
- 켜고 끌 때 자원 제한이 바뀌어 DB·앱 컨테이너가 다시 만들어져요(수 초 끊김). 데이터는 그대로예요.
- 배포 워크플로(Deploy obs-test)는 기본 정의만 써요. 실험이 끝나면 `availability.sh off`로 돌려 두고 배포해요.
- 감시 수집기가 떠 있으면 `on`·`off` 때 함께 다시 만들어 감시 대상(app2 포함 여부)을 맞춰요.

```bash
scripts/ops/availability.sh on                      # 지금 버전으로 앱 2개
scripts/ops/measure.sh baseline 60 20               # 기준선
scripts/ops/measure.sh kill1 60 20 & sleep 10; scripts/ops/chaos.sh kill-app 1 10; wait
scripts/ops/measure.sh pause1 60 20 & sleep 10; scripts/ops/chaos.sh pause-app 1 15; wait
scripts/ops/measure.sh rolling 90 20 & sleep 10; scripts/ops/rolling-deploy.sh <SHA>; wait
scripts/ops/measure.sh pausedb 60 20 & sleep 10; scripts/ops/chaos.sh pause-db 5; wait
scripts/ops/availability.sh off
```
`chaos.sh`는 다른 앱이 healthy가 아니면(둘 다 내려가는 경우) 실행을 거부하고, 중간에 끊겨도(Ctrl+C·오류) 얼리거나 멈춘 컨테이너를 반드시 되돌려요. 결과 JSON의 `availabilityPct`·`errorRatePct`·`latencyMs`·`outages[].recoveryS`를 봐요. 큐 적체는 작업 큐가 생기면 함께 재요.

이 컨테이너(로컬 Docker, 4 vCPU, 자원 제한 적용)에서 잰 값(2026-10-04, 초당 20건 GET `/api/health`, 시험 숫자이지 서버 용량 보장 아님):

| 시나리오 | 요청 | 가용률 | p95 / p99(ms) | 장애 구간·복구 |
| --- | ---: | ---: | --- | --- |
| 기준선(앱 2개) | 801 | 100% | 7 / 12 | 없음 |
| 앱 1 강제 종료 10초 후 재시작 | 802 | 100% | 7 / 13 | 없음(다시 healthy까지 6초) |
| 앱 2 프로세스 충돌(자동 재시작) | 802 | 100% | 7 / 10 | 없음(5초) |
| 앱 1 얼림 15초(응답 멈춤) | 801 | 100% | 8 / 2,257 | 없음. 멈춘 앱에 간 요청은 2초 뒤 다른 앱으로 재시도돼 느려짐 |
| 앱 2 정지 20초 | 801 | 100% | 7 / 8 | 없음 |
| 무중단 배포(앱 하나씩 교체, 70초 측정) | 1,401 | 100% | 7 / 12 | 없음 |
| DB 얼림 5초 | 801 | 84.5% | 1,262 / 2,517 | 1회, 복구 6.2초(DB는 단일 장애 지점) |
| 비교: 앱 1개 구성에서 프로세스 충돌 | 802 | 98.8% | 8 / 179 | 1회, 복구 0.6초(502 10건) |

고치기 전 설정에서는 이랬어요: GET 재시도가 없을 때 앱 얼림 94.5%(4.4초 동안 절반 실패), 실패 앱 30초 제외일 때 무중단 배포 중 15초 장애·DB 5초 얼림 뒤 30초 넘게 미복구. 지금 값(GET 재시도·응답 헤더 2초 제한·5초 제외·교체 간격 8초)으로 고친 뒤 위 결과가 나왔어요.

## 서버 감시(ONQ 단계 6 인프라 몫)

화면을 닫아도 서버 감시가 계속 돌도록 **앱과 따로 도는 감시 수집기**를 둬요.

- 실행: `docker compose -p obs-web -f deploy/docker-compose.yml --env-file /opt/obs/.env --profile monitor up -d obs-web-monitor` (가용성 프로파일이면 `-f deploy/compose.availability.yml`도). 처음 한 번 `mkdir -p /opt/obs/monitor && touch /opt/obs/deploy-history.log`.
- 기본 배포(워크플로)에는 뜨지 않아요(`profiles: monitor`). `.env`는 넘기지 않아요.
- 15초마다(`OBS_MONITOR_INTERVAL_S`): 앱·프록시 `/api/health`의 상태·응답 시간(DB `SELECT 1` 시간 포함)·db·version, 배포 기록의 마지막 SHA와 실행 버전 비교, 인증서 남은 일수(`OBS_MONITOR_TLS_HOST`).
- 연속 3번 실패 → `incident_open`(critical), 다시 성공 → `incident_close`(지속 시간). 느림(1초 초과)·배포 기록과 실행 버전 불일치(연속 3번. `rolling-deploy.sh`·`rollback-app.sh`가 배포 중 `/opt/obs/monitor/deploy-in-progress` 표시를 두는 동안은 미룸, 표시가 15분 넘게 남으면 따로 경고하고 그 표시는 무시)·인증서 14일 미만 → warn(같은 경고는 한 번만). 알림은 틱 끝에 한 번 모아 보내고, 시간당 한도 기록(`alert-window.json`)은 감시를 다시 만들어도 이어져요.
- 기록(`/opt/obs/monitor`): `samples-YYYYMMDD.jsonl`(표본), `events.jsonl`(사건), `status.json`(마지막 상태), `heartbeat.json`(감시 자체의 마지막 시각 → 감시 끊김 판단). 컨테이너 healthcheck도 heartbeat가 2분 넘게 멈추면 unhealthy예요.
- 알림: 채널 미정(`PRODUCT_SCOPE.md` 「미확정」)이라 **인터페이스만** 있어요. `OBS_ALERT_URL`을 넣으면 경고·장애·복구를 JSON으로 POST하고, 시간당 10건까지만 보내요. 알림톡·메일·텔레그램이 정해지면 그 주소(또는 중계 함수)만 넣으면 돼요.
- 로컬 확인(2026-10-04): 2초 간격으로 앱을 12초 멈췄을 때 6초 안에 `incident_open`, 다시 켠 뒤 `incident_close`(8초) 기록. 알림 주소로 `version_mismatch` POST 수신.

아직 못 재는 것과 필요한 앱 쪽 훅(앱 코드 `lib/server/**`는 기반 세션 소유, MASTER 요청):

| 항목 | 필요한 것 | 제안 |
| --- | --- | --- |
| DB pool 사용량·대기 | 앱이 Prisma 연결 수·대기 수를 내보내는 곳 | 관리자 전용 `GET /api/admin/ops/metrics`(마스터 「조회 전용」 이상), 공개 `/api/health`에는 넣지 않음 |
| worker·scheduler heartbeat | worker·정기 실행이 마지막으로 돈 시각을 DB에 남김 | `ops_heartbeat(name, at, detail)` 표에 정기 실행마다 기록 → 감시가 「N분 넘게 안 돎」 판단 |
| 작업 큐 적체 | 큐가 생기면 대기·처리 중·실패 수 | 위 metrics에 포함 → `measure.mjs`·감시가 함께 읽음 |
| 감시 기록을 화면에서 보기 | 마스터 콘솔이 `status.json`·`events.jsonl`을 읽을 방법 | 감시가 DB 표(`ops_event`)에도 쓰게 하거나 앱이 읽기 전용으로 마운트(기반·화면 세션과 정함) |

기존 앱 안 정기 실행(`lib/server/jobs/scheduler.ts`, `feat/rejoin-restriction` 브랜치, 아직 main 아님) 검토:
- 정리 작업처럼 **앱 안에서 해도 되는 일**에는 재사용할 수 있어요(1시간 간격, 작업별 advisory lock으로 여러 앱 중 하나만 실행, 실패 격리). heartbeat 기록 작업을 여기에 하나 더 넣는 것도 적합해요.
- **감시 자체에는 쓰지 않아요.** 앱이 죽거나 멈추면 같은 프로세스 안의 scheduler도 함께 멈춰서 장애를 알릴 수 없기 때문이에요. 그래서 감시는 앱 밖(위 수집기)에 두고, scheduler는 「앱이 살아 있다는 신호(heartbeat)를 남기는 쪽」으로만 써요.

## 다중 서버·DB 고가용성 구성안과 월 비용(산정만, 생성 금지·대표님 승인 사항)

지금 obs-test는 VM 1대에 앱·DB·프록시가 함께 있어요. 호스트·DB 장애에도 버티려면 아래가 필요해요. **아무것도 만들지 않았고, 만들려면 대표님 승인이 필요해요.**

| 구성 요소 | 수량 | 역할 | 단가(공개 자료) | 월 비용 |
| --- | ---: | --- | --- | --- |
| 앱 VM(t1i.medium, 2 vCPU·4GB) | 2 | 앱·worker, 서로 다른 가용 영역 | 시간당 44.2원(카카오클라우드 2023-09 출시 공지, 현재가 콘솔 확인 필요) | 약 64,500원(2대 × 730시간) |
| 로드밸런서 | 1 | 앱 VM 둘로 분배·health 검사 | 콘솔 확인 필요 | 확인 필요 |
| 관리형 DB(PostgreSQL, 주·대기 복제) 또는 DB VM 2대 + 복제 | 1세트 | DB 장애 시 자동 전환 | 콘솔 확인 필요 | 확인 필요 |
| 블록 스토리지(DB·VM 디스크) | 용량별 | 데이터 | 콘솔 확인 필요 | 확인 필요 |
| 백업 보관(오브젝트 스토리지) | 용량별 | VM 밖 백업 보관 | 콘솔 확인 필요 | 확인 필요 |
| 공인 IP·트래픽 | - | - | 콘솔 확인 필요 | 확인 필요 |

- 무료 크레딧 잔액과 지금 월 비용은 대표님 콘솔 확인 항목이에요(다른 프로젝트와 공유).
- 최소 단계 제안: ① 지금 VM에서 백업을 VM 밖(오브젝트 스토리지)으로 매일 보내기(비용 작음) → ② DB 복제 → ③ 앱 VM 2대 + 로드밸런서. 각 단계 비용을 콘솔 가격표로 채운 뒤 승인받아요.

## HTTPS

운영 빌드는 로그인 쿠키에 `Secure`를 붙여요(`lib/server/http/route.ts`). 그래서 **HTTP 주소(`http://210.109.15.68`)에서는 브라우저가 로그인 쿠키를 저장하지 않아 로그인이 유지되지 않아요.** 로그인까지 확인하려면 HTTPS가 필요해요.

### 시험 서버 주소: `test.on-aircue.com`

도메인 `on-aircue.com`은 Cloudflare에 등록돼 있고 DNS도 Cloudflare에서 관리해요.

1. Cloudflare → `on-aircue.com` → DNS → Records에서 레코드를 추가해요.
   - Type `A`, Name `test`, IPv4 address `210.109.15.68`
   - Proxy status: **DNS only(회색 구름)**. Caddy가 Let's Encrypt 인증서를 직접 받아야 해서예요. 주황 구름(Proxied)으로 두면 Cloudflare가 중간에서 TLS를 끊어 인증서 발급이 꼬이거나 리디렉션이 반복될 수 있고, 실시간(SSE) 연결이 끊기거나 늦게 올 수 있어요.
2. 확인: `dig +short test.on-aircue.com`이 `210.109.15.68`을 돌려줘요.
3. 보안 그룹 `obs-web-sg`에서 80/tcp·443/tcp를 0.0.0.0/0으로 열어요. 인증서 발급과 자동 갱신에 둘 다 필요해요.
4. `/opt/obs/.env`에 `OBS_SITE_ADDRESS=test.on-aircue.com`을 넣어요.
5. 재배포해요(또는 서버에서 「서버 명령 준비」 뒤 `$C up -d obs-web-proxy`). Caddy가 Let's Encrypt 무료 인증서를 자동으로 받아요(`obs-web-caddy-data` 볼륨에 보관, 자동 갱신).
6. `https://test.on-aircue.com`으로 접속해요. `http://`로 들어오면 HTTPS로 넘어가요.

인증서를 받기 전(DNS가 아직 안 퍼졌거나 80·443이 막혀 있을 때)에는 `https://` 접속이 안 돼요. `$C logs obs-web-proxy`에서 발급 결과를 볼 수 있어요. 실패를 반복하면 Let's Encrypt 발급 한도에 걸릴 수 있으니 DNS·보안 그룹을 먼저 확인한 뒤 다시 띄워요.

### 대안: sslip.io(도메인에 문제가 있을 때만)

`210-109-15-68.sslip.io`처럼 IP를 넣은 이름은 등록 없이 그 IP로 연결돼요(무료 공용 DNS). 위 4번에서 `OBS_SITE_ADDRESS=210-109-15-68.sslip.io`로 바꾸면 같은 방식으로 HTTPS가 돼요. 남이 운영하는 공용 서비스라 장애·발급 한도 위험이 있어 **시험용 임시 대안**으로만 써요.

### 운영 전환 때(지금은 하지 않음)

운영 주소(`on-aircue.com`, `www`, `admin`, 와일드카드 `*.on-aircue.com`)는 운영 서버(obs-web-prod) 전환 때 별도 단계로 정해요.

- 하위 주소 전체를 한 번에 받는 와일드카드 인증서(`*.on-aircue.com`)는 Let's Encrypt DNS 인증이 필요해요. Caddy에 Cloudflare DNS 플러그인과 Cloudflare DNS API 토큰(해당 영역 DNS 편집 권한만)이 있어야 해요. 토큰은 비밀값이라 서버 `.env`에만 둬요.
- 운영 전환 계획을 세울 때 함께 정해요: Caddy 이미지(플러그인 포함), 운영 DNS 레코드, 주황 구름 사용 여부.

배포 워크플로의 health check는 서버 안에서 `http://127.0.0.1`로 부르고, Caddyfile에 이 주소를 따로 두어서 사이트 주소를 바꿔도 그대로 동작해요.
