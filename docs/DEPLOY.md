# 테스트 서버(obs-test) 배포

이슈 #137. 대상은 KakaoCloud VM `obs-web-test`(Ubuntu 24.04, kr-central-2) 한 대예요. 운영(obs-web-prod) 배포는 이 문서 범위가 아니에요.

## 구성

| 파일 | 역할 |
| --- | --- |
| `Dockerfile` | 앱 이미지(Next.js standalone, `node server.js`) + 마이그레이션 이미지(`migrator` 단계) |
| `deploy/docker-compose.yml` | 프로젝트 `obs-web`: DB·마이그레이션·앱·프록시 |
| `deploy/Caddyfile` | 80·443을 받아 앱으로 넘기는 리버스 프록시 |
| `.github/workflows/deploy-obs-test.yml` | main push의 CI 성공 뒤 자동 배포·수동 재배포 워크플로(VM 안의 self-hosted runner에서 실행) |
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

VM에 GitHub Actions runner(라벨 `obs-kakao`)를 **상시 서비스로 등록**해 두고, main에 push(일반 커밋·PR 병합)가 생기고 **같은 SHA의 CI 전체가 성공하면** 해당 커밋을 VM에서 빌드·기동해요(2026-10-06 대표님 자동 배포 지시). 수동 실행은 긴급 재배포용으로 남겨요. 기존 테스트 VM만 사용하고 새 유료 인프라는 추가하지 않아요(아래 「runner 보안」). **먼저 꼭 할 설정**: Settings → Actions → General → 「Approval for running fork pull request workflows from contributors」를 **Require approval for all external contributors**로 바꿔요(이 설정 없이 runner를 등록하지 않아요).

- runner는 GitHub로 나가는 연결만 써요. SSH 22를 인터넷에 열 필요가 없어요.
- 비밀값은 서버의 `/opt/obs/.env`에만 있어요. GitHub Secrets에 DB 비밀번호를 둘 필요가 없어요.
- 레지스트리(GHCR 용량 과금 가능성) 없이 동작해요.
- 주의: runner가 받은 코드를 VM에서 그대로 실행해요. 그래서 배포 워크플로는 main push의 CI 성공을 받는 `workflow_run`과 main `workflow_dispatch`만 배포 job으로 들어가도록 제한하고, 이 저장소·Environment `obs-test`로 묶어요. 주간 `schedule`은 Environment 없이 별도 정리 job만 실행해요. 배포·정리 모두 PR·다른 브랜치·fork에서는 절대 runner로 가지 않아야 해요.

워크플로 `Deploy obs-test`가 하는 일:

1. GitHub 호스팅 gate가 CI의 실제 저장소·main push·성공 결과를 확인. CI가 검사한 SHA가 현재 main인지, 그 SHA의 최신 CI가 성공했는지 확인(수동 실행도 같은 검사·`confirm_sha` 확인)
2. VM에서 main·CI를 다시 확인한 뒤 `/opt/obs/.env` 존재 확인. gate를 통과한 SHA를 고정해 체크아웃
3. DB가 있으면 배포 전 백업(`/opt/obs/backups/obs-<KST 시각>-before-<SHA 7자리>.dump`)
4. `docker compose ... up -d --build --wait`(마이그레이션 → 앱 healthy → 프록시)
5. `http://127.0.0.1/api/health`의 `version`이 배포 SHA이고 `db`가 `ok`인지 확인
6. 성공하면 `/opt/obs/deploy-history.log`에 KST 시각·SHA·실행 번호·실행자를 남기고 실행 요약에 표시

CI의 「No deploy workflows」 검사는 승인된 self-hosted 워크플로만 허용해요. 자동 실행 예외는 `deploy-obs-test.yml`의 main push CI 성공 `workflow_run` 배포와 월요일 03:00 KST의 별도 정리 job뿐이고, 시험 데이터·디스크 정리·운영 배포는 계속 수동 실행만 허용해요. CI 성공·main push·CI 원본 저장소 조건과 gate 의존 관계, 배포 job의 저장소·main 조건과 `obs-kakao` 라벨·`obs-test` Environment도 검사해요.

#### 자동 배포와 승인 상태

runner 등록은 처음 한 번만 해요(「서버 준비」 5번). 이 변경이 main에 병합되면 그 병합 push의 CI 성공부터 자동 배포 대상이에요. `CI` 워크플로가 완료되면 배포 워크플로 실행이 만들어지고, 성공한 이 저장소의 main push만 gate로 들어가요. CI 실패·취소, PR CI·fork·다른 브랜치·태그·예약 실행은 VM **배포** job을 시작하지 않아요. 예약 실행은 아래의 별도 디스크 정리 job만 시작해요. 앱 변경 경로 필터가 없어 문서만 바뀐 main push도 CI가 성공하면 대상이에요. main 병합 전 CI·검수 기준도 그대로 지켜요.

**자동 실행 생성과 무인 배포 완료는 달라요.** 기존 Environment `obs-test`와 보호 규칙을 유지해요. Required reviewers(기존 기록: 대표님), 대기 시간 또는 다른 배포 보호 규칙이 있으면 runner 실행 전에 기다려요. Required reviewers가 적용되는 한 **승인 없이 끝나는 무인 자동 배포는 아직 완료가 아니에요.** 2026-10-06 이 변경 작업에서 Environment API 조회는 Forbidden으로 실패해 실제 보호 설정을 확인하지 못했어요. 설정 변경·API 승인 우회·시험 배포는 하지 않았어요. 무인 배포를 마치려면 저장소 관리자가 `obs-test`의 Required reviewers 설정 변경과 다른 보호 규칙을 검토해야 해요. main만 허용하는 배포 브랜치 제한과 외부 기여자 PR 승인 설정은 유지해요.

- main push → 같은 SHA의 **CI** 전체 성공 → **Deploy obs-test**의 GitHub 호스팅 gate가 현재 main·최신 CI 성공 확인 → Environment 보호 규칙 통과 → VM에서 main·CI 재확인 → 같은 SHA 배포 → 실행 요약과 health 확인 순서예요.
- gate 시점에 main이 바뀐 오래된 SHA는 VM runner로 가지 않아요. gate를 통과한 뒤 승인·runner 대기 중 main이 바뀌면 VM 첫 검사에서 배포를 멈춰요. VM 재검사 뒤 main이 바뀌는 짧은 경합까지 막는 원자적 잠금은 없고, 이미 시작한 배포는 중단하지 않아요.
- 배포는 동시에 한 건만 돌아요(`cancel-in-progress: false`). 진행 중인 배포를 새 push가 중단하지 않아요. 대기 실행이 여러 개면 GitHub concurrency가 기존 대기 실행을 새 것으로 바꿀 수 있어 중간 커밋 모두가 배포되지는 않아요.
- 자동 실행에서는 성공한 CI의 SHA를 쓰므로 `confirm_sha`를 입력할 필요가 없고, 선택 사항인 이미지 버킷 조회도 하지 않아요.
- 실패한 배포는 자동 재시도하지 않아요. 원인을 해결한 뒤 해당 Actions 실행을 재실행하거나 아래 수동 재배포를 사용해요.

#### 수동 재배포 순서

1. 배포할 main 커밋과 같은 SHA의 **CI** 성공을 확인해요(저장소 첫 화면 또는 Commits에서 맨 위 커밋의 앞 7자리). CI가 실패·진행 중이면 수동 실행도 VM에 들어가지 않아요.
2. Actions → **Deploy obs-test** → **Run workflow**를 눌러요. Branch는 **main**으로 두고, `confirm_sha`에 1의 앞 7자리를 넣고 실행해요.
   - 다른 브랜치를 고르면 job이 건너뛰어져요. 입력한 SHA가 실행 대상 main 커밋과 다르면 멈춰요.
3. Environment `obs-test`에 Required reviewers가 있으면 **Review deployments → Approve**를 눌러요.
4. 끝나면 실행 요약의 「obs-test 배포 완료」와 커밋을 확인하고, 브라우저로 주소를 열어 봐요.

#### 실패했을 때

- 실행 화면에서 빨간 단계를 열어요. 실패하면 마지막 「Show status on failure」 단계가 컨테이너 상태와 마이그레이션·앱 로그 80줄을 보여 줘요.
- 단계별로 흔한 원인:

| 실패한 단계 | 확인할 것 |
| --- | --- |
| Verify current main and exact-SHA CI / Recheck main and CI before deploy | 실행 대상 SHA가 현재 main인지, 같은 SHA의 최신 CI가 완료·성공했는지 |
| Check target commit | 수동 실행이면 `confirm_sha`가 실행 대상 main 커밋과 같은지. `/opt/obs/.env`가 있는지 |
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
| `OBS_ENVIRONMENT` | 필수(obs-test) | **`test`**. 장애 주입·가용성 프로파일·무중단 배포 스크립트는 이 줄이 있을 때만 돌아요. 운영 서버에는 넣지 않아요 |
| `IMAGE_STORAGE` | 선택 | 이미지 저장 위치. 비우면 지금처럼 DB에 저장해요. `kakao`면 카카오 Object Storage 버킷에 저장해요(드라이버 `lib/server/storage/kakao.ts`는 들어 있지만, **과금이 생기므로 전환은 보류 중이에요(2026-10-04 대표님 지시). `kakao`로 바꾸지 마세요.**). 아래 「이미지 서버(카카오 Object Storage)」 |
| `IMAGE_S3_ENDPOINT` | `IMAGE_STORAGE=kakao`일 때 | 버킷의 S3 호환 주소(비밀이 아니에요) |
| `IMAGE_S3_REGION` | 위와 같음 | 리전(`kr-central-2`) |
| `IMAGE_S3_BUCKET` | 위와 같음 | 버킷 이름(`live-obs-platform`) |
| `IMAGE_S3_ACCESS_KEY_ID`, `IMAGE_S3_SECRET_ACCESS_KEY` | 위와 같음 | 이 버킷 전용 S3 액세스 키. **비밀값이에요.** `.env`에만 넣고 채팅·문서·저장소에는 붙이지 않아요 |
| `NICEPAY_CLIENT_KEY`, `NICEPAY_SECRET_KEY` | 선택(카드 결제 시험) | 나이스페이 **샌드박스** 키(테스트 서버 전용). 없으면 결제 시작이 「결제 준비 중」으로 거절돼요. **비밀값이에요.** 코드가 샌드박스 주소만 불러 운영 결제는 나가지 않아요. 운영 키는 결제대행사 계약 뒤 운영 서버에서 따로 정해요 |
| `YOUTUBE_API_KEY` | 선택 | YouTube Data API 키(방송·실시간 채팅 조회, 무료 한도 안에서만). 없으면 YouTube 기능이 꺼져요. **비밀값이에요.** |
| `GEMINI_API_KEY` | 선택 | 도우미(Gemini) API 키(월 1만 원 한도 안에서만, 한도·모델은 마스터 관리자 도우미 설정). 없으면 도우미는 「준비 중」이에요. 테스트 서버는 배포 때 GitHub Secret `GEMINI_API_KEY`에서 반영해요. **비밀값이에요.** |
| `OBS_MONITOR_TLS_HOST` | 선택 | 서버 감시가 인증서 만료일을 볼 주소(obs-test는 `test.on-aircue.com`) |
| `OBS_ALERT_URL` | 선택 | 장애 알림을 받을 주소(웹훅). 알림 채널이 정해지기 전에는 비워 둬요(기록만 남아요) |
| `OBS_MONITOR_INTERVAL_S` | 선택 | 감시 간격(기본 15초, 1~60초. 범위 밖이거나 숫자가 아니면 감시가 시작하지 않고 로그에 이유를 남겨요) |
| `OBS_MONITOR_KEEP_DAYS` | 선택 | 일별 표본 파일(`samples-YYYYMMDD.jsonl`)을 오늘 포함 며칠 치 남길지(기본 14, 1~3650). 지난 파일은 날짜가 바뀔 때 지워요. 상태·사건·heartbeat 파일은 지우지 않아요 |
| `OBS_MONITOR_DIR`·`OBS_HISTORY_FILE` | 선택 | 감시 폴더(기본 `/opt/obs/monitor`)·배포 기록 파일(기본 `/opt/obs/deploy-history.log`). 운영 스크립트는 `docker compose config`가 감시 서비스에 실제로 마운트하는 경로를 그대로 써요(`.env` 해석은 compose에 맡김) |

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
4. Settings → Environments → `obs-test`의 기존 보호 설정을 확인해요.
   - Deployment branches and tags: **Selected branches** → `main`만 유지
   - Required reviewers: 기존 기록은 **대표님**(실행할 때마다 승인). 이 규칙이 남아 있으면 자동 실행도 승인 대기해요. 무인 자동 배포 전환에는 관리자의 설정 검토·변경이 필요해요(위 「자동 배포와 승인 상태」). 이 작업은 설정을 바꾸지 않아요.

GitHub Secrets·Variables는 이 방식에서 필요 없어요(비밀값은 서버 `.env`에만).

## 이미지 서버(카카오 Object Storage) — 대표님 조치

2026-10-05 대표님이 만든 버킷: 이름 `live-obs-platform`, 리전 `kr-central-2`, Standard, 기본 암호화(서비스 관리형 키), 퍼블릭 액세스 차단, CORS 미적용, 수명 주기 정책 없음. 지금 앱은 이미지를 DB에 저장해요. 버킷에 저장하는 코드(드라이버)는 후속 PR로 올라오고, 아래 조치가 끝나기 전에는 아무것도 바뀌지 않아요.

원칙:
- **퍼블릭 차단은 그대로 둬요.** 버킷을 공개로 바꾸지 않아요.
- 이미지는 **서버를 거쳐** 내려가요(권한 검사를 그대로 유지). 필요하면 **짧은 서명 URL**(수십~수백 초)로 바꿔요. 어느 쪽을 쓸지는 드라이버 PR에서 정해요.
- 수명 주기 정책(자동 삭제)은 넣지 않아요. 이미지가 의도치 않게 지워질 수 있어요.

공식 문서는 검색으로 확인했어요([S3 API 사용](https://docs.kakaocloud.com/en/tutorial/storage/object-storage-s3-api), [버킷 권한 관리](https://docs.kakaocloud.com/en/service/bss/object-storage/how-to-guides/object-storage-manage-permission), [버킷 CORS 정책](https://docs.kakaocloud.com/service/bss/object-storage/how-to-guides/object-storage-cors)). 이 세션에서는 문서 페이지를 직접 열지 못했어요. **콘솔 화면의 메뉴 이름이 아래와 다르면 화면이 우선이고, 다른 점을 알려 주세요.**

### A. 이 버킷 전용 사용자 만들기(최소 권한)

권한은 **버킷 단위로만** 줄 수 있어요(파일·폴더 단위는 안 돼요). 그래서 이 버킷만 쓰는 전용 사용자를 만들고, 그 사용자의 S3 액세스 키를 서버에 넣는 게 원칙이에요. 대표님 본인 계정의 키는 프로젝트 전체 권한이 따라와서 권고하지 않아요. **테스트 서버(obs-test)는 지금 등록된 키로 진행하고(2026-10-05 대표님 결정), 운영 서버로 가기 전에 전용 사용자 키로 교체해요.** 아래 「운영 전환 때」에 같은 항목이 있어요.

1. 콘솔 → IAM에서 서버 전용 사용자를 만들어요(예: `obs-image-app`). 프로젝트 역할은 **주지 않거나 가장 낮은 것**만 줘요.
2. 콘솔 → Object Storage → 버킷 `live-obs-platform` → 권한(버킷 권한 관리) → 사용자 추가 → 위 사용자에 **스토리지 편집자**를 줘요. 읽기·쓰기·삭제가 필요해요(삭제는 이미지 교체·삭제에 써요).
3. 확인할 것(문서만으로는 못 정했어요): ⓐ 프로젝트 역할이 없는 사용자도 S3 액세스 키를 만들 수 있는지, ⓑ 스토리지 편집자에 객체 삭제가 포함되는지. 안 되면 가장 좁은 대안(서비스 계정 또는 프로젝트 역할 최소)을 골라 알려 주세요. 선택지를 정리해 드릴게요.

### B. S3 액세스 키 발급(위 사용자로 로그인한 상태에서)

1. 콘솔 로그인(버킷이 있는 프로젝트 선택).
2. 오른쪽 위 **프로필 아이콘 → 자격 증명**.
3. **S3 액세스 키** 탭 → **S3 액세스 키 생성** → 이름 입력(예: `obs-test-image`) → **생성**.
4. 나온 **액세스 키**와 **보안 액세스 키**를 복사해 **GitHub 저장소 Secrets**에만 넣어요: 저장소 → Settings → Secrets and variables → Actions → `KAKAO_S3_ACCESS_KEY`(액세스 키), `KAKAO_S3_SECRET_KEY`(보안 액세스 키). 2026-10-05에 대표님이 등록하셨어요. 서버 `.env`에는 직접 넣지 않아요(아래 C). **보안 액세스 키는 이 화면에서만 볼 수 있다고 가정**하고, 놓치면 새로 만들어요.
5. 프로젝트당 키는 **최대 2개**예요. 서버용 1개만 쓰고, 나머지 1개는 교체용으로 비워 둬요.

### C. 서버 `.env`에는 배포 워크플로가 넣어요

위 「4. 서버 `.env`」 표의 `IMAGE_STORAGE`, `IMAGE_S3_ENDPOINT`, `IMAGE_S3_REGION`, `IMAGE_S3_BUCKET`, `IMAGE_S3_ACCESS_KEY_ID`, `IMAGE_S3_SECRET_ACCESS_KEY`예요. **Deploy obs-test 워크플로의 `Sync image storage env` 단계**가 배포 때마다 GitHub Secrets 값과 고정값(엔드포인트 `https://objectstorage.kr-central-2.kakaocloud.com`, 리전 `kr-central-2`, 버킷 `live-obs-platform`)을 `/opt/obs/.env`에 반영해요. 직접 입력하지 않아도 돼요.

- 값은 로그에 나오지 않아요. `.env`의 다른 줄은 그대로 두고, 임시 파일에 만든 뒤 한 번에 바꿔요.
- **`IMAGE_STORAGE`는 없을 때만 `db`로 넣어요.** 이미 있으면 덮어쓰지 않아요. 그래서 처음에는 키만 들어가고 이미지는 계속 DB에 저장돼요. **카카오로 바꾸는 일은 이 단계가 하지 않아요.** 드라이버가 병합되고 이전을 승인한 뒤, 서버 `.env`의 `IMAGE_STORAGE`를 `kakao`로 직접 바꾸고 재배포해요.
- Secret이 비어 있거나 `.env`에 그대로 쓸 수 없는 문자가 있으면 경고만 남기고 키를 넣지 않아요. 이 단계가 실패해도 배포는 막지 않아요.
- **버킷 연결 확인(선택)**: 배포를 실행할 때 `check_image_bucket`을 켜면 배포 뒤 버킷 목록 조회를 **딱 한 번**(쓰기 없음) 해요. 성공이면 로그에 「목록 조회 성공」, 실패면 HTTP 코드와 오류 코드(예: `SignatureDoesNotMatch`, `AccessDenied`)가 나와요. 실패해도 배포 결과는 바뀌지 않아요.
- `.env`를 바꾼 뒤에는 재배포(또는 `up -d`)해야 앱에 반영돼요.

### D. 요금 확인

콘솔의 Object Storage 요금 안내에서 **Standard 저장 용량(GB·월), 요청 수, 외부 전송량** 단가를 확인해 주세요. 이 문서에는 단가를 적지 않았어요(공식 단가를 직접 확인하지 못했어요). 이미지 수와 크기는 DB → 버킷 이전 스크립트가 건수·총 용량을 먼저 보여 줄 거예요. 그 숫자로 월 요금을 어림할 수 있어요.

### E. CORS(지금은 적용하지 않아요)

이미지를 **서버 경유로 보여 주거나 서명 URL을 `<img>`로 읽는 데는 CORS가 필요 없어요.** 브라우저가 서명 URL로 버킷에 **직접 업로드**(PUT)할 때만 필요해요. 그때는 허용 출처를 `https://test.on-aircue.com` 하나로, 메서드는 `PUT`만, 필요한 헤더만 열도록 제안드릴게요. 적용은 대표님 승인 뒤에만 해요.

### 하지 않는 것

- 버킷 공개 전환, 키를 저장소·채팅·로그에 붙이기, 수명 주기 정책 추가, 대표님 본인 계정 키 사용.
- DB → 버킷 이전 실행: 스크립트와 계획이 올라온 뒤 대표님 승인 뒤에만 해요(테스트 서버 먼저, 되돌릴 수 있게).

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
마스터 관리자(최고관리자) 시험 계정도 함께 또는 따로 만들 수 있어요(대표님 지시 2026-10-04): 「Seed obs-test」의 `admin_login`·`admin_password`(서버에서는 `SEED_ADMIN_LOGIN`·`SEED_ADMIN_PASSWORD`)를 넣으면 최고관리자 계정을 만들고, 같은 아이디가 이미 있으면 만들지 않아요. 판매자 아이디·비밀번호와 관리자 아이디·비밀번호는 각각 선택이지만 둘 중 한 쌍은 꼭 넣어요. 판매자가 이미 있으면 판매자 부분만 건너뛰고 관리자는 계속 만들어요.
로그인 아이디·비밀번호는 실행할 때 직접 입력해요(저장소·문서·로그에 남지 않아요). 이 명령에서만 아이디 형식·비밀번호 8자 규칙을 건너뛰어요(대표님 허용 2026-10-03, 운영 규칙은 그대로).
**서버에 접속하지 않고 GitHub에서 넣기(권장):** Actions → 「Seed obs-test」 → Run workflow에서 아이디·비밀번호를 넣고 실행해요(main 기준, Environment `obs-test` 승인 대상). 비밀번호는 실행 로그에서 가려져요. 앱이 한 번 배포된 뒤에만 돌아요.

서버에서 직접 넣을 때는 위 「서버 명령 준비」 줄을 먼저 실행하고, 아래를 붙여 넣은 뒤 아이디·비밀번호를 입력해요.

```bash
# 판매자 쌍과 관리자 쌍은 각각 선택(Enter만 치면 건너뜀)이고, 둘 중 한 쌍은 꼭 넣어요. 비밀번호는 화면에 나오지 않아요.
read -p "판매자 아이디(없으면 Enter): " SEED_SELLER_LOGIN && read -s -p "판매자 비밀번호: " SEED_SELLER_PASSWORD && echo && read -p "관리자 아이디(없으면 Enter): " SEED_ADMIN_LOGIN && read -s -p "관리자 비밀번호: " SEED_ADMIN_PASSWORD && echo && export SEED_SELLER_LOGIN SEED_SELLER_PASSWORD SEED_ADMIN_LOGIN SEED_ADMIN_PASSWORD && OBS_TEST_MODE="$(sed -n 's/^OBS_TEST_MODE=//p' /opt/obs/.env)" IDENTITY_HASH_KEY="$(sed -n 's/^IDENTITY_HASH_KEY=//p' /opt/obs/.env)" $C run --rm --no-deps -e OBS_TEST_MODE -e SEED_SELLER_LOGIN -e SEED_SELLER_PASSWORD -e SEED_ADMIN_LOGIN -e SEED_ADMIN_PASSWORD -e IDENTITY_HASH_KEY obs-web-migrate node scripts/seed-obs-test.mjs; unset SEED_SELLER_LOGIN SEED_SELLER_PASSWORD SEED_ADMIN_LOGIN SEED_ADMIN_PASSWORD
```

- 마이그레이션 이미지(`obs-web-migrate`)를 써요. 이 기능이 들어간 버전으로 한 번 배포한 뒤에 실행해요.
- 테스트 모드 여부는 이 서버의 `/opt/obs/.env`에 적힌 `OBS_TEST_MODE` 값을 그대로 넘겨요(명령에 1을 박아 두지 않아요). 운영 서버처럼 `.env`에 `OBS_TEST_MODE=1`이 없으면 명령이 아무것도 넣지 않고 실패해요.
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

## 디스크 정리

테스트 서버 디스크가 가득 차 배포가 멈추는 것을 막기 위한 장치입니다. 자동 정리는 `deploy/maintenance/disk-cleanup.sh`, 기존 수동 점검·정리는 `scripts/ops/disk-cleanup.sh`를 사용합니다.

| 시점 | 동작 |
| --- | --- |
| 배포 시작(Checkout 직후) | 기존 용량 검사로 남은 공간이 5GB 미만이면 배포를 멈춥니다. |
| 배포 성공 뒤 | 자동 정리 스크립트를 실행합니다. 정리 실패는 배포 결과를 바꾸지 않습니다. |
| 매주 월요일 03:00 KST | `Deploy obs-test`의 별도 `maintenance` job이 자동 정리합니다(UTC 일요일 18:00, cron `0 18 * * 0`). GitHub 예약 실행은 지연될 수 있습니다. |

주간 정리 job은 이 저장소의 main 예약 실행만 받으며, main SHA를 고정해 checkout한 뒤 정리 스크립트만 실행합니다. **Environment를 연결하지 않아 배포 승인자를 기다리지 않습니다.** secrets·서버 `.env`를 읽거나 배포·마이그레이션·seed를 호출하지 않습니다. 배포 job의 Environment 보호는 그대로 유지합니다. 기존 배포·seed·수동 정리와 같은 concurrency 그룹으로 한 번에 한 작업만 실행합니다.

자동 보존 정책은 고정입니다.

- 배포 전 자동 백업(`obs-YYYYMMDD-HHMMSS-before-<7자리 소문자 SHA>.dump`)은 파일명 시각 기준 **최신 3개**만 남깁니다. 수동·복원 안전 백업·`.part`·symlink는 지우지 않습니다.
- 성공 배포 기록 `/opt/obs/deploy-history.log`에서 **최근 서로 다른 SHA 3개**의 앱·마이그레이션 이미지를 남깁니다(현재 버전과 이전 2개가 기본). 실제 현재 버전이 이전 SHA로 롤백됐다면 해당 SHA의 앱·마이그레이션 이미지도 추가로 남깁니다. 모든 실행 중·중지된 컨테이너가 참조하는 이미지 ID와 그 별칭도 보존합니다.
- 나머지 이미지 삭제는 `obs-web-app:<40자리 SHA>`·`obs-web-migrate:<40자리 SHA>` 태그만 허용하며 강제 삭제하지 않습니다. `postgres:16`·프록시·다른 저장소의 태그는 대상이 아닙니다.
- 미사용 dangling 이미지와 빌드 캐시는 **168시간 이상 지난 것**만 Docker의 필터로 정리합니다. 이 두 prune은 **연결된 Docker daemon 전체 범위**이며 `obs-web` 프로젝트나 이미지 태그로 제한되지 않습니다. 다른 저장소의 오래된 미사용 dangling 이미지·빌드 캐시도 대상이 될 수 있습니다. `-a`·`docker system prune`·볼륨/컨테이너 삭제는 사용하지 않습니다.
- PostgreSQL named volume·실행 중 컨테이너·`.env`·러너 파일/로그는 건드리지 않습니다. 남은 이미지 밖으로 롤백하려면 다시 빌드해야 합니다.

권한 근거는 서버 준비 절차의 `obs` 소유 `/opt/obs`·backups(700), runner의 `obs` 계정·docker 그룹입니다. 실제 VM 권한은 이번 작업에서 확인하지 않았습니다. 스크립트는 Docker 조회, 현재 앱 SHA, 배포 기록, 백업 폴더 접근·쓰기 권한을 **삭제 전에 확인**하며 기록 손상·누락, 조회 실패, 경로 symlink·상위 이동 또는 권한 부족이면 전체 정리를 중단합니다. sudo·권한 설정 변경으로 우회하지 않습니다.

호스트 범위의 근거는 이 문서의 대상 VM `obs-web-test`와 `PROJECT_STATUS.md` 「인프라 방향」의 **시험 앱과 시험 PostgreSQL을 한 대에 올리는 구성**입니다. 서버 준비 절차는 배포 전용 `obs` 계정에 다른 용도를 주지 않도록 정하고, 해당 계정으로 runner 서비스를 등록합니다. 자동 정리는 이 서비스의 테스트용으로 지정된 VM·Docker daemon을 대상으로 합니다. 이는 저장소의 구성·소유권 기록이며 실제 호스트의 다른 workload 부재를 조사한 결과는 아닙니다. 다른 서비스와 daemon을 공유하는 호스트로 runner를 옮길 때는 daemon 전체 prune을 제거하거나 별도 builder로 범위를 제한한 뒤 사용해야 합니다.

서버에서 자동 정책의 후보를 확인하려면(기본 dry-run, 삭제 없음):

```bash
cd /opt/obs/src && deploy/maintenance/disk-cleanup.sh --dry-run
cd /opt/obs/src && deploy/maintenance/disk-cleanup.sh --apply
```

기존 `Disk cleanup obs-test` 수동 워크플로는 `mode=list`로 후보를 먼저 확인한 뒤 `mode=apply`로 실행합니다. 그 수동 스크립트의 기본 정책은 자동 백업 10개·최근 이미지 5개, 빌드 캐시 24시간·진단 로그 14일이며 입력으로 조정할 수 있습니다. 자동 정리 이후에는 이미 지운 이전 버전이 복원되지는 않습니다.

검증은 `python3 deploy/maintenance/test_disk_cleanup.py`로 임시 폴더와 가짜 Docker만 사용합니다. CI에도 같은 시험을 연결했습니다. 이번 작업에서는 실제 VM에 접속하거나 정리를 실행하지 않았습니다. 컨테이너 로그는 기존 compose의 서비스별 10MB×3개 제한을 유지합니다.

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
| `db-restore.sh <파일>` | 파일 검사 → 지금 DB 안전 백업 → 앱 중지 → DB 다시 만들기 → 복원 → **지금 버전 마이그레이션 적용**(백업이 더 오래된 스키마여도 앱과 맞춤) → 앱 시작 → 앱마다 healthy 확인(가용성 on이면 2개 모두) → health. 도는 동안 배포 진행 표시를 둬 감시가 장애로 알리지 않아요. **DB 이름을 직접 입력해야 진행** | 아니요 |
| `rollback-app.sh [SHA] [--force-unchecked]` | 앱만 이전 이미지로(DB 그대로, 빌드 없음). 되돌릴 버전이 모르는 마이그레이션이 DB에 있으면 경고 → health version 확인 → 배포 기록에 남김. 그 버전의 migrate 이미지가 없으면 스키마 호환을 확인할 수 없어 멈추고, `--force-unchecked`일 때만 경고 후 진행 | 아니요 |
| `availability.sh on\|off\|status` | 가용성 프로파일 켜기·끄기 | 예 |
| `deploy-mark.sh on <키> ["<사유>"] [유효 초]\|off <키>` | 배포 진행 표시 켜기·끄기(감시가 표시가 있는 동안 새 장애·버전 불일치 경고를 미룸). 여러 단계 배포가 한 줄씩 부르는 용도. 이 표시는 갱신하는 프로세스가 없어 만료 시각(기본 3600초, 1~86400)까지 유효해요(40분 걸리는 워크플로도 덮음). 표시는 키마다 따로라 `off`는 같은 키만 지워요(겹쳐 도는 복원 등의 표시는 그대로). 키는 실행마다 달라야 해서, 같은 키의 살아 있는 표시가 있으면 `on`은 덮어쓰지 않고 멈춰요(확인과 생성은 폴더 잠금 `flock` 안에서 해 동시에 들어와도 하나만 켜져요. util-linux `flock`이 필요해요). 키는 영문·숫자·`.-_`(예: `workflow-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT`). **Deploy obs-test 워크플로가 이미 부르고 있어요**(체크아웃 뒤 `on workflow-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT`, 끝에 `if: always()`로 `off` 같은 키). 서버에 `flock`이 없거나 표시를 못 켜도 배포는 막지 않고 경고만 남겨요 | 아니요 |
| `rolling-deploy.sh [SHA]` | 가용성 프로파일에서 앱을 하나씩 교체 | 예 |
| `chaos.sh ...` | 장애 주입(앱 멈춤·강제 종료·충돌·얼림, DB 얼림·재시작) | 예 |
| `measure.sh <이름표> [초] [초당 요청]` | 가용률·오류율·p50/p95/p99·장애 구간·복구 시간 측정(JSON). 초는 0 초과 600 이하, 초당 요청은 0 초과 200 이하(벗어나면 요청 없이 종료 코드 2) | 예 |
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
- 배포 워크플로(Deploy obs-test)는 기본 정의만 써요. 실험이 끝나면 `availability.sh off`로 돌려 두고 배포해요. **켜 둔 채 배포하면** 프록시가 앱 1개만 가리키고 app2는 옛 이미지로 남아요. 배포 뒤 `availability.sh on`을 다시 실행하면 새 버전으로 앱 2개를 다시 맞춰요.
- `on`·`off`는 이미 그 상태여도 실제 구성을 다시 적용하고(`compose up -d --remove-orphans`, on은 기본+가용성 정의, off는 기본 정의) 확인해요: on은 프록시가 두 앱을 가리키는지·app2가 app과 같은 이미지인지, off는 app2가 없고 프록시가 app2를 가리키지 않는지. 맞추지 못하면 0이 아닌 코드로 끝나요. 이때는 표시를 그대로 두니 같은 명령을 다시 실행하면 돼요(전환과 달리 되돌리지 않아요).
- `on`·`off`가 도는 동안(되돌리기 포함)에는 배포 진행 표시를 둬, 앱·프록시가 다시 만들어지는 사이 감시가 장애를 열지 않아요. 성공·실패·중단 어느 쪽으로 끝나도 표시는 지워져요.
- `on`·`off`가 실패하거나 도중에 끊기면(Ctrl+C·SSH 끊김·SIGTERM) 원래 구성(on 실패 → 앱 1개, off 실패 → 앱 2개)으로 실제로 되돌리고 표시도 그에 맞춰요. 되돌리기까지 실패하면 표시를 지우고 「구성이 불확실해요」로 끝나니, `status`로 실제 컨테이너를 확인해 주세요.
- 감시 수집기가 있으면 `on`·`off`가 끝날 때(이미 그 상태일 때도) 감시를 다시 만들어 대상(앱 1개·2개)을 맞춰요. 감시가 healthy가 될 때까지(최대 90초) 기다리고, 설정 오류 등으로 시작 직후 죽으면 이 단계만 실패해 0이 아닌 코드로 끝나니 원인을 고친 뒤 같은 명령을 다시 실행하면 돼요. 멈춰 있는 감시 컨테이너도 다시 켜지므로, 감시를 끄려면 `docker compose ... --profile monitor rm -sf obs-web-monitor`로 지워요.

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
- 연속 3번 실패 → `incident_open`(critical), 다시 성공 → `incident_close`(지속 시간). 배포 진행 표시가 있는 동안에는 새 장애를 열지 않고(실패 횟수는 셈), 표시가 사라진 뒤에도 실패가 이어지면 다음 틱에 열어요. 표시는 작업마다 자기 파일 하나(`/opt/obs/monitor/deploy-in-progress.d/<종류>-<pid>-<시작 시각>`, 내용은 사유·만료 시각)라, 복원과 가용성 전환처럼 겹쳐 돌아도 먼저 끝난 작업은 자기 표시만 지워요. 유효한 표시가 하나라도 있으면 배포 중이에요. 스크립트가 도는 동안 갱신하는 표시는 15분 안에 갱신됐고 만료 전이어야 하고, `deploy-mark.sh on`으로 만든 표시(갱신 없음)는 만료 시각만 봐요. 감시는 표시를 탐침 전·후에 모두 읽어, 탐침 도중 배포가 끝나도 그 회차 실패로 장애를 열지 않아요. 표시를 끌 때는 바로 지우지 않고 끝난 시각을 적은 기록(`.ended-<키>`)으로 바꿔, 탐침하는 사이 시작해 끝난 짧은 작업도 반영해요. 끝난 지 탐침 시간 제한 + 감시 간격(기본 20초)이 지난 기록은 감시가 지워요. 복원·롤링 배포·롤백·가용성 전환 스크립트는 도는 동안 자기 표시 시각을 1분마다 갱신해, 15분을 넘겨도 표시가 유효해요. 만료는 시작 뒤 최대 1시간(`OBS_DEPLOY_MARK_MAX_S`)이고, 그때 갱신도 멈추고 로그를 남겨요. 스크립트가 멈춰 있어도 만료 뒤에는 감시가 다시 장애를 판단해요. 스크립트가 TERM·INT·HUP으로 끝나면 자기 표시를 지우고, 강제 종료(SIGKILL)되면 갱신이 멈춰 15분 뒤 고아 표시로 처리돼요. 만료되거나 갱신이 끊긴 표시는 감시가 `deploy_mark_stale`로 한 번 알리고 지워요. 예전 단일 파일(`deploy-in-progress`)도 계속 읽어요. 느림(1초 초과)·배포 기록과 실행 버전 불일치(연속 3번. 배포 진행 표시가 있는 동안은 미룸)·인증서 14일 미만 → warn(같은 경고는 한 번만). 알림은 틱 끝에 모아 동시 5건씩, 틱마다 간격의 1/3(기본 5초) 안에서만 보내고 못 보낸 것은 다음 틱으로 넘겨요. 받는 쪽이 응답을 미뤄도 감시 주기와 heartbeat는 밀리지 않아요.
- 감시 상태(대상별 연속 실패 횟수·열린 장애와 시작 시각·버전 불일치 연속 횟수·경고 쿨다운·시간당 알림 한도·보내지 못한 알림)는 `monitor-state.json` 하나에 남겨, 감시를 다시 만들어도(가용성 on/off·재시작) 이어져요. 장애 중에 다시 만들면 `incident_open`을 또 내지 않고, 복구되면 `incident_close`를 한 번 내요. 파일이 깨졌으면 로그를 한 줄 남기고 빈 상태로 시작해요. 가용성 off로 감시 대상에서 빠진 앱(app2)의 상태는 지우고, 열린 장애는 `incident_close`(`reason: target_removed`)로 닫아요.
- 기록(`/opt/obs/monitor`): `samples-YYYYMMDD.jsonl`(표본), `events.jsonl`(사건), `monitor-state.json`(감시 상태), `status.json`(마지막 상태), `heartbeat.json`(감시 자체의 마지막 시각 → 감시 끊김 판단). 컨테이너 healthcheck도 heartbeat가 2분 넘게 멈추면 unhealthy예요.
- 알림: 채널 미정(`PRODUCT_SCOPE.md` 「미확정」)이라 **인터페이스만** 있어요. `OBS_ALERT_URL`을 넣으면 경고·장애·복구를 JSON으로 POST하고, 시간당 10건까지만 보내요. 한도에 걸린 알림은 버리지 않고 기다렸다가 한도가 열리면 보내고, 아직 못 보낸 장애 시작 알림은 같은 대상의 복구 알림과 하나로 합쳐요(`openNotSent: true`). 보낼 목록(50건)이 넘치면 복구 알림이 아닌 오래된 것부터 버려요. 알림톡·메일·텔레그램이 정해지면 그 주소(또는 중계 함수)만 넣으면 돼요.
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

## 운영 배포

운영 서버(`obs-web-prod`)는 테스트 서버와 **별도 VM·DB**입니다(대표님 결정 2026-10-05: A안, 단일 VM 1단계). 앱 2대·로드밸런서·DB 복제는 승인 범위 밖입니다. 워크플로: `.github/workflows/deploy-obs-prod.yml`(수동 실행).

**월 비용 추정(A안, 단가는 공개 페이지 기준이라 콘솔과 다르면 콘솔 우선)**

| 항목 | 단가 | 월 |
| --- | --- | ---: |
| VM t1i.medium(2 vCPU·4GB) | 시간당 44.2원 | 31,824원 |
| 데이터 디스크 SSD 100GiB | 0.16원/GiB·시간 | 11,520원 |
| OS 디스크 SSD 30GiB(실제 크기로 다시 계산) | 같음 | 3,456원 |
| 공인 IP 1개 | 시간당 5.5원 | 3,960원 |
| 백업 보관 Object Storage 10GiB | 0.0375원/GiB·시간 | 약 270원 |
| 합계 | | 약 51,000원 |

부가세와 월 30GiB 초과 아웃바운드 트래픽(90원/GiB)은 별도입니다. 7만 원을 넘는 구성이 되면 만들기 전에 보고합니다.

**누가 실행·승인하나**: `deploy-obs-prod` 실행(workflow_dispatch)과 `production` 환경 배포 승인은 **대표님만** 합니다(2026-10-05 대표님 결정). Claude 세션을 포함한 다른 누구도 실행·승인하지 않습니다.

**서버 준비(대표님 콘솔 작업 — 자원 생성은 이 저장소의 워크플로가 하지 않습니다). 순서를 지켜 주십시오.**

1. **가장 먼저**: GitHub 저장소 설정에서 Environment `production`을 만들고 **Required reviewers에 대표님**, 배포 브랜치는 `main`만 허용합니다. 환경이 없는 채로 워크플로가 돌면 보호 규칙 없이 환경이 자동으로 만들어지므로, 러너를 등록하기 전에 이 설정을 끝냅니다.
2. VM·디스크·공인 IP·보안그룹: 인바운드 80·443은 모두, SSH(22)는 허용 IP만. VM은 Ubuntu 24.04, 데이터 디스크는 `/opt/obs`로 마운트.
3. 운영 도메인(`on-aircue.com` 하위)의 A 레코드를 공인 IP로 연결. 인증서는 Caddy가 자동 발급합니다(80·443 열려 있어야 함).
4. `/opt/obs/.env`는 서버에서 직접 만듭니다(권한 600). 값은 **테스트와 다른 새 값**을 쓰고 저장소·채팅에 붙이지 않습니다. 이 워크플로는 비밀값을 `.env`로 옮기지 않습니다. 필수: `POSTGRES_USER`·`POSTGRES_PASSWORD`·`POSTGRES_DB`·`IDENTITY_HASH_KEY`·`BILLING_KEY_SECRET`·`OBS_SITE_ADDRESS`(운영 도메인)·**`OBS_ENVIRONMENT=prod`**. **`OBS_TEST_MODE`는 넣지 않습니다**(워크플로가 막습니다). 나이스페이는 결제대행사 운영 계약 뒤에 운영 키를 따로 정합니다(지금 코드는 샌드박스 주소만 부릅니다).
5. **마지막**: 서버에 Docker를 설치하고 GitHub Actions runner를 **라벨 `obs-prod`**로 등록(테스트 러너 `obs-kakao`와 다른 VM). 러너가 등록되면 워크플로를 실행할 수 있게 되므로 1~4가 끝난 뒤에 합니다.

**배포 순서(실패하면 그 자리에서 멈춤)**: 확인 문구·40자 SHA가 실행 시점 main과 같은지 → `.env`가 운영 표시이고 테스트 값이 없는지 → 이 커밋의 CI 두 작업(Typecheck and build, Unit and integration tests) 성공 → 남은 디스크 10GB 이상 → 감시 알림 억제 → DB 백업과 백업 파일 읽기 검증 → 빌드·마이그레이션·앱 교체(마이그레이션이 실패하면 앱은 바뀌지 않음) → `/api/health` 버전·DB 확인(`testMode`가 켜져 있으면 실패) → 기록·디스크 정리.

**실패·되돌리기**: 앱 기동(`up --wait`)이나 헬스 체크가 실패했을 때, 지금 떠 있는 앱이 이번에 배포한 버전이면 앱만 직전 배포 버전으로 자동 되돌립니다(`rollback-app.sh`). 마이그레이션이 실패해 앱이 바뀌지 않았다면 되돌리지 않습니다(더 옛 버전으로 내려가는 것을 막음). DB는 되돌리지 않고, 되돌려야 하면 배포 전 백업으로 사람이 `db-restore.sh`를 실행합니다. 마이그레이션은 앞으로만 가므로 컬럼 삭제 같은 파괴적 변경은 두 번에 나눠 배포합니다(먼저 코드가 새 스키마와 옛 스키마를 모두 견디게 하고, 다음 배포에서 삭제).

**운영에서 막혀 있는 것**: 장애 주입(`chaos.sh`)은 `OBS_ENVIRONMENT=test`가 없으면 거부합니다. 테스트 데이터 입력·시드(`seed-obs-test`)는 `OBS_TEST_MODE=1`이 있어야만 돌아서 운영에서는 실행되지 않습니다. 이 워크플로는 이 둘을 호출하지 않습니다.

## 운영 DB 일일 오프사이트 백업

운영 VM 밖(카카오 오브젝트 스토리지)에 매일 DB 백업을 보냅니다. `scripts/ops/db-offsite.sh`가 `db-backup.sh`로 새 백업을 만들고 `prod/daily/<파일명>`으로 올린 뒤 원격 크기가 같은지 확인합니다. 실패하면 0이 아닌 값으로 끝납니다. 추가 설치는 없습니다(`curl` 8.x의 SigV4 사용).

대표님 콘솔·서버 작업(순서대로):
1. 오브젝트 스토리지에 **운영 백업 전용 버킷**을 만듭니다(이미지 버킷과 분리). 버킷 수명 주기 규칙으로 30일 뒤 삭제를 설정합니다(스크립트는 지우지 않습니다).
2. 그 버킷에만 「스토리지 편집자」를 준 전용 사용자를 만들고 S3 액세스 키를 발급합니다(테스트 키와 다른 새 키).
3. 서버 `/opt/obs/.env`(권한 600)에 `BACKUP_S3_ENDPOINT`(`https://objectstorage.kr-central-2.kakaocloud.com`)·`BACKUP_S3_REGION`(`kr-central-2`)·`BACKUP_S3_BUCKET`·`BACKUP_S3_ACCESS_KEY_ID`·`BACKUP_S3_SECRET_ACCESS_KEY`를 직접 넣습니다. 값은 저장소·채팅에 붙이지 않습니다.
4. 서버에서 한 번 직접 실행해 올라가는지 확인합니다: `scripts/ops/db-offsite.sh`
5. 매일 실행 등록(예: `/etc/cron.d/obs-offsite-backup`, 한국 시간 새벽 3시 30분):

```
CRON_TZ=Asia/Seoul
30 3 * * * obs /opt/obs/app/scripts/ops/db-offsite.sh >> /opt/obs/offsite-backup.log 2>&1
```

경로는 러너가 체크아웃한 실제 위치로 바꿉니다. 로그 마지막 줄이 「오프사이트 백업 완료」인지 확인합니다. 복구는 내려받은 `.dump`로 `db-restore.sh`를 사람이 실행합니다. 실제 카카오 버킷에는 아직 시험하지 못했습니다(운영 버킷·키가 없음). 첫 실행은 사람이 지켜봅니다.

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
- **이미지 버킷 키를 전용 사용자 키로 교체해요**(운영 서버 전환 전 필수). 테스트 서버는 대표님 계정에서 발급한 키로 시작해서 프로젝트 전체 권한이 따라와요. 위 「이미지 서버」 A·B 순서로 전용 사용자를 만들고 버킷 `live-obs-platform`에만 「스토리지 편집자」를 준 뒤, 새 S3 액세스 키로 GitHub Secrets `KAKAO_S3_ACCESS_KEY`·`KAKAO_S3_SECRET_KEY`를 바꾸고 배포해요(`check_image_bucket`을 켜서 연결 확인). 확인된 뒤 옛 키는 콘솔에서 삭제해요. 운영 서버용 버킷·키를 테스트와 따로 둘지도 이때 정해요.

배포 워크플로의 health check는 서버 안에서 `http://127.0.0.1`로 부르고, Caddyfile에 이 주소를 따로 두어서 사이트 주소를 바꿔도 그대로 동작해요.
