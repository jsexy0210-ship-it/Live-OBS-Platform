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
| `BILLING_PROVIDER` | 선택 | obs-test는 비워도 돼요(아래 `OBS_TEST_MODE=1`이면 가짜 결제 공급자를 써요). 운영 빌드에서 `fake`만 넣으면 가짜 결제 공급자 생성이 막혀 카드 등록·구독 결제가 오류로 멈춰요 |
| `OBS_TEST_MODE` | **obs-test만** | `1`이면 테스트 서버 모드예요(대표님 지시 2026-10-03). 휴대폰 본인확인은 가짜 공급자(인증번호 `000000`, 문자·과금 없음, 포트원 설정이 있어도 테스트 모드가 우선), 구독 결제는 가짜 결제 공급자(실제 돈 이동 없음, 결제 번호 `fake-pay-…`)로 처리하고, 「시험 데이터 넣기」 명령을 쓸 수 있어요. 켜지면 서버 로그에 경고 한 줄이 남고 `GET /api/health`에 `"testMode": true`가 붙어요. **운영 서버에는 절대 넣지 않아요** |
| `OBS_SITE_ADDRESS` | 필수(HTTPS) | obs-test는 `test.on-aircue.com`. 비우면 `:80`(HTTP만, 로그인 유지 안 됨). 아래 「HTTPS」 |
| `BUSINESS_STATUS_PROVIDER`, `NTS_BUSINESS_STATUS_API_KEY` | 선택 | 판매자 가입 사업자 상태 점검 |
| `MAIL_ORDER_PROVIDER`, `FTC_MAIL_ORDER_API_KEY` | 선택 | 통신판매업 점검 |
| `PORTONE_API_SECRET`, `PORTONE_STORE_ID`, `PORTONE_IDENTITY_CHANNEL_KEY` | 선택 | 휴대폰 본인확인. 없으면 가입 본인확인은 503 「준비 중」 |

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

## 시험 데이터 넣기(obs-test 전용)

테스트 서버에 시험 판매자(대표자) 계정 1개, 시험 쇼핑몰(`/shop/test-shop`) 1개, 상품 3개를 넣어요(`scripts/seed-obs-test.mjs`). 판매자가 이미 있으면 아무것도 하지 않아요(다시 실행해도 중복 없음). 실제 결제·문자는 없어요.
로그인 아이디·비밀번호는 실행할 때 직접 입력해요(저장소·문서·로그에 남지 않아요). 이 명령에서만 아이디 형식·비밀번호 8자 규칙을 건너뛰어요(대표님 허용 2026-10-03, 운영 규칙은 그대로).
위 「서버 명령 준비」 줄을 먼저 실행하고, 아래를 붙여 넣은 뒤 아이디·비밀번호를 입력해요.

```bash
read -p "아이디: " SEED_SELLER_LOGIN && read -s -p "비밀번호: " SEED_SELLER_PASSWORD && echo && export SEED_SELLER_LOGIN SEED_SELLER_PASSWORD && IDENTITY_HASH_KEY="$(sed -n 's/^IDENTITY_HASH_KEY=//p' /opt/obs/.env)" $C run --rm --no-deps -e OBS_TEST_MODE=1 -e SEED_SELLER_LOGIN -e SEED_SELLER_PASSWORD -e IDENTITY_HASH_KEY obs-web-migrate node scripts/seed-obs-test.mjs; unset SEED_SELLER_LOGIN SEED_SELLER_PASSWORD
```

- 마이그레이션 이미지(`obs-web-migrate`)를 써요. 이 기능이 들어간 버전으로 한 번 배포한 뒤에 실행해요.
- 끝나면 파트너스 로그인 화면에서 넣은 아이디·비밀번호로 로그인해요.
- 대표자 본인확인 정보는 시험용 인물로 채워요. 비밀번호 찾기에서 이름 「테스트대표」, 생년월일 1990년 1월 1일(남), 아무 휴대폰번호, 인증번호 `000000`을 넣으면 대표자로 확인돼요. 서버의 `IDENTITY_HASH_KEY`로 해시를 만들어서 이 값이 없으면 명령이 실패해요. `obs-web-migrate` 컨테이너에는 DB 주소만 들어가므로, 위 줄이 `/opt/obs/.env`의 `IDENTITY_HASH_KEY` 값을 읽어 이 명령에만 넘겨요(화면·명령 기록에 값이 남지 않아요). `.env`에서 이 값은 따옴표 없이 적어 둬요.

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
