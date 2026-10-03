# obs-test 배포·HTTPS 운영 절차

이슈 #137, PR #145의 Docker 기반 후속 구성. 아래는 **구현과 실행 절차**이며 실제 VM 배포 성공 보고가 아니다.

## 대상과 최신 확인 수준

| 항목 | 기준 | 근거 |
| --- | --- | --- |
| 저장소 | `jsexy0210-ship-it/Live-OBS-Platform` | GitHub 확인 |
| KakaoCloud 프로젝트 | `lifeleft` 유지 | 사용자 지시 |
| 테스트 VM | `obs-web-test`, Ubuntu 24.04 / 2 vCPU·4GiB / SSD 30GB | 사용자 콘솔 보고, Active |
| 공인 IP | `210.109.15.68` | 사용자 콘솔 보고, In Use |
| 네트워크 | `obs-public-sn1`, `obs-web-sg` | 사용자 보고 |
| 대표·허용 호스트 | `on-aircue.com` | 사용자 등록 완료 보고 |
| DNS | Cloudflare Registrar, 루트 A → VM IP, DNS-only | 사용자 보고, 이 세션 독립 조회 미완료 |
| www | 없음. 인증서·허용 호스트·리다이렉트에 추가하지 않음 | 사용자 지시 |
| GitHub Environment | `obs-test` | 생성 완료 사용자 보고 |
| SSH / runner | 접속·등록·Online 확인 미완료 | 실행 증거 필요 |

이전 DuckDNS 이름은 활성 배포 대상에서 제외한다. Git 이력이나 실제 DNS/클라우드 자원은 삭제하지 않는다. 실제 서비스 브랜드 변경은 이번 도메인 구성과 별개다.

2026-10-03 KST GitHub 조회에서 저장소는 **Public**이다. 상주 VM runner를 Public 저장소에 연결하지 않는 안전장치를 이 배포안에 적용한다. 공개 범위는 임의로 바꾸지 않는다. GitHub의 전면적 기능 금지가 아니라, 이번 상주 runner 배포의 안전 정책이다.

## 구성

- `Dockerfile`: Next.js standalone 앱과 Prisma migrator 이미지(PR #145 기반).
- `deploy/docker-compose.yml`: **기존 VM 내부** PostgreSQL 16, 앱, Caddy. 새로운 Managed DB·VM·클라우드 볼륨·버킷은 만들지 않는다. Docker의 이름 있는 볼륨은 기존 30GB 디스크를 사용한다.
- DB/앱 포트 5432/3000은 외부·호스트에 게시하지 않는다. Caddy만 80/443 사용. 각 서비스는 `unless-stopped`, 로그 10MB × 3개 제한.
- `proxy.ts` / `lib/infra/host-policy.ts`: 이 테스트 배포에서 `OBS_ENFORCE_HOST_POLICY=1`, `OBS_ALLOWED_HOSTS=on-aircue.com`. 루트 호스트 외에는 421. 컨테이너 내부 루프백은 GET/HEAD `/api/health`, `/api/live`만 허용.
- Caddy도 호스트를 제한하고 Host/X-Forwarded-Host를 canonical 도메인으로 전달한다. 외부 `Forwarded`는 제거한다. DNS-only이므로 앱은 Caddy 한 단계만 신뢰한다. Cloudflare 프록시를 나중에 켤 때는 신뢰 IP·프록시 설정을 별도 검토한다.
- `/api/live`: DB와 무관한 프로세스 생존. `/api/health`: DB `SELECT 1`, 이미지에 기록한 배포 SHA, no-store, 내부 오류 비노출. liveness 200만으로 배포 성공 판정 금지.
- 실제 결제·본인확인·메일 키는 앱에 주입하지 않는다. 기존 미설정 시 실패 정책을 유지한다. 유료 연동·테스트용 fake 결제 자동 활성화 금지.
- 이미지 버킷·실결제·인증·실고객 메일 동작은 인프라 기동과 별도 검증이다. Resend 선택은 유지하되 이번 인프라 PR에서 별도 공급자 구현이나 키 변경을 하지 않는다.

기존 VM 요금·네트워크 전송·Actions 사용량은 기존 계정 과금에 따른다. 별도 유료 자원을 만들지 않는다고 실행 비용 전체가 0원이 되는 것은 아니다.

## 배포 차단 조건

1. 상주 runner를 사용할 저장소의 Private 전환은 소유자가 결정한다. Public을 유지하려면 별도 격리 배포 경로를 검토한다. 현재 워크플로는 Public 상태에서는 **호스팅 authorize 단계에서 중단**한다. runner 레이블·main 가드만으로 악성 PR이 격리된다고 가정하지 않는다.
2. SSH는 새 VM의 호스트 키 지문을 콘솔/안전한 경로와 대조한다. 같은 IP를 재사용했어도 과거 호스트 키를 그대로 믿거나 `StrictHostKeyChecking=no`로 우회하지 않는다.
3. 로컬 테스트 DB 사용을 확인하고 `/opt/obs/.env`의 `OBS_ALLOW_LOCAL_DB=1` 지정. 다른 서비스 DB를 연결하지 않는다.
4. `obs-test` Environment는 main만 배포 허용. 사용 가능한 보호 기능으로 승인자를 지정하고 저장소 쓰기 권한을 제한한다. runner가 대상 VM에서 Online/Idle인지 확인한다.
5. DNS 조회 결과, 80/443 인바운드, Caddy 인증서 저장 볼륨을 준비한다. **도메인 구매·A 레코드 입력과 인증서 발급 성공은 다른 상태다.**

## VM 초기 준비

관리자가 승인된 커밋의 스크립트를 대상 VM에 전달해 실행한다. 다른 서버에서 실행하지 않는다.

```bash
sudo bash scripts/infra/bootstrap_obs_test.sh --confirm-obs-web-test
```

Docker·Python·Git, `obs` 계정과 `/opt/obs`를 준비한다. 최초에만 난수 비밀값을 파일에 생성하고 출력하지 않는다. 기존 `.env`는 덮어쓰지 않는다. 대상 표식과 machine-id를 기록한다. Docker 그룹은 사실상 root 권한이므로 다른 프로젝트·비밀정보와 공유하지 않는다.

`/opt/obs/.env`는 obs 소유, 600 또는 400 권한. 변수 이름:
`POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_PASSWORD`, `IDENTITY_HASH_KEY`, `BILLING_KEY_SECRET`, `OBS_ALLOW_LOCAL_DB`.
비밀값은 32자 이상 영문·숫자·밑줄의 따옴표 없는 KEY=VALUE 형식이다. 배포 실행은 값을 검증하고 허용 목록만 자식 프로세스에 전달한다. `source`, `set -x`, `.env` 출력, 전체 `docker compose config` 출력은 하지 않는다. 설정 검사는 `config --quiet`만 사용한다.

### 네트워크

| 포트 | 허용 범위 |
| --- | --- |
| 22/tcp | 관리자 접속 IP/32 |
| 80/tcp | HTTP ACME challenge와 HTTPS 리다이렉트에 필요한 접근 |
| 443/tcp | 인증서 발급 시도 **이전부터** 인터넷 접근 |
| 3000/5432·Docker API·관리 포트 | 외부 비공개 |

보안 그룹과 VM 방화벽 모두 확인한다. GitHub·Docker Hub·인증기관·DNS-over-HTTPS 등에 대한 아웃바운드 연결도 필요하다. 이 문서는 방화벽 변경 완료를 의미하지 않는다.

## runner 등록

Private/격리 정책을 해결한 뒤 GitHub Settings → Actions → Runners → New self-hosted runner → Linux x64 안내를 따른다. `/opt/obs/actions-runner`에 `obs` 계정으로 설치한다. 토큰은 코드·이슈·명령 히스토리에 넣지 않고 대화형 입력으로 전달한다.

```bash
# obs 계정, runner 디렉터리에서 실행. token 플래그를 사용하지 않는다.
./config.sh --url https://github.com/jsexy0210-ship-it/Live-OBS-Platform \
  --name obs-web-test --labels obs-kakao,obs-test
# 등록 완료 후 관리자 계정에서 서비스 설치·시작
sudo ./svc.sh install obs
sudo ./svc.sh start
```

Linux/X64 기본 레이블과 추가 obs-kakao/obs-test 모두 필요하다. Environment는 `obs-test`. 이 구성은 VM 내부에서 로컬 배포하므로 워크플로에 SSH 개인키를 전달하지 않는다.

## DNS 및 HTTPS

사용자가 Cloudflare에서 루트 A를 이미 VM IP에 연결했다고 보고했다. **DNS를 다시 생성하거나 프록시를 켜지 않는다.** 실제 배포 전에 아래 읽기 전용 검사로 확인한다.

```bash
python3 scripts/infra/dns_preflight.py
```

두 공개 리졸버와 서버 리졸버에서 루트 A가 지정 IPv4와 일치해야 한다. 구성된 IPv6가 없으므로 AAAA가 나타나면 중단하고 실제 할당 여부를 확인한다. 코드가 레코드를 자동 삭제하지 않는다. CAA 제한이 있으면 Caddy 인증기관을 허용하는지도 확인한다.

- 인증서 대상은 **on-aircue.com 한 개**. www와 와일드카드는 신청하지 않는다.
- Caddy가 공개 ACME 인증서를 발급·갱신한다. DNS-only이므로 브라우저가 VM 인증서를 직접 검증한다. **Cloudflare Origin CA 인증서를 직접 사용자용 인증서로 대체하지 않는다.**
- HTTP/TLS ACME challenge를 사용하므로 Cloudflare DNS API 토큰을 배포 워크플로에 추가할 필요가 없다.
- 적용 전: `deploy/Caddyfile`의 허용 호스트 진단 경로만 HTTP 200/503. 로그인·구매 페이지는 503 준비중. 임의 Host는 421.
- 적용 후: `deploy/Caddyfile.https`. 루트 도메인의 HTTP만 고정 HTTPS 주소로 308 리다이렉트. 다른 Host는 애플리케이션으로 전달하지 않는다.
- 인증서 개인키와 계정 데이터는 `obs-web-caddy-data`/`obs-web-caddy-config` 볼륨에 보존한다. 인증서를 코드·로그에 넣거나 매 배포 때 삭제하지 않는다.
- Secure/HttpOnly 쿠키와 기존 CSRF·동일 출처 정책을 유지한다. HTTPS 문제를 쿠키 비활성화·CORS 와일드카드로 우회하지 않는다.

## 배포·검증 순서

1. MASTER가 PR #145 및 후속 PR을 검수·main에 반영하고 **정확한 main SHA의 CI 성공**을 확인한다.
2. VM 초기 준비·runner 등록·로컬 테스트 DB 승인 완료.
3. Actions → **Deploy obs-test (manual)** → main → confirm_target에 `obs-web-test` 입력.
4. DNS/TLS가 미준비면 `enable_https=false`로 진단용 기동만 검증한다. DNS·포트가 준비됐으면 `true`.
5. 호스팅 runner에서 테스트·전체 Dockerfile 빌드·폐기용 Compose smoke를 수행한다. 이미지를 파일 아티팩트로 전달하고 보관 기간은 1일이다. 별도 레지스트리를 생성하지 않는다. VM에서 빌드하지 않는다.
6. VM은 실행 대상 표식·machine-id·파일 소유권·아티팩트 목록/해시·배포 SHA를 확인하고 파일 잠금으로 동시 배포를 차단한다.
7. DB 기동 → pg_dump → 덤프 목록 확인 → 앱 정지 → migrate deploy → 앱·프록시 기동 → DB/버전/로컬 프록시/TLS 확인.
8. GitHub 호스팅 runner가 외부에서 https://on-aircue.com/api/health 를 검증한다. 인증서 검증을 끄는 `-k`나 임의 TLS 무시를 사용하지 않는다. HTTPS 전에는 IP의 health만 확인한다.
9. 로그인 유지·실시간 이벤트·이미지 업로드 등 기능 검증은 별도로 수행한다. 테스트 계정 준비나 외부 계약이 없다면 차단 상태를 기록한다. 실결제·환불·유료 인증·실고객 메일은 수행하지 않는다.
10. 재부팅 후 Docker·runner 및 앱 자동 기동은 실제 VM에서 별도 검증한다. `unless-stopped`는 명시적으로 정지한 컨테이너를 강제로 켜지 않는다.

## 데이터·롤백

DB는 `obs-web_obs-web-pgdata`, 앱은 SHA별 이미지/릴리스로 분리한다. `/opt/obs/backups`에 제한된 권한으로 배포 전 덤프를 보존한다. 아카이브 목록 검증은 실제 복원 시험의 대체가 아니다.

- 서버에서 `down -v`, `docker volume rm`, 전체 `prune --volumes` 금지.
- 30GB 디스크에 이미지·백업이 쌓인다. 여유 6GiB 미만이면 배포 중지. 자동 파일·이미지 삭제 금지.
- 백업·이미지 보존으로 공간이 부족하면 필요 용량과 대상을 보고한다. 유료 디스크 확장/버킷 생성은 별도 승인.
- VM 내부 백업은 VM 손실 대비책이 아니다. 승인된 외부 위치로 암호화 보관할 계획이 별도로 필요하다.
- DB migration 파일 지문이 같으면 앱 실패 시 이전 이미지/프록시 복구를 시도한다. 달라졌으면 자동 DB 복원·오래된 앱 강제 기동은 하지 않는다.
- DB 복원은 데이터 손실 범위를 확인한 후 별도 승인으로 수행한다.
- HTTPS 적용 완료 후 HTTP로 하향하는 실수는 차단한다.
- 상태 파일 current.json/previous.json 및 배포 이력에는 SHA·상태·시각만 저장한다. 파일 존재를 현재 health 성공으로 취급하지 않는다.

## 검증 수준 기록

후속 작업의 로컬 Python/YAML/셸/독립 호스트 정책 검증과 GitHub CI·실제 VM 실행을 구분해 PR에 보고한다. 이 작업 세션은 네트워크 이름 해석이 실패해 공개 DNS를 독립적으로 확인하지 못했고, Docker·VM SSH 자격정보도 없다. 따라서 사용자 보고한 DNS 등록 상태를 실패로 단정하지 않는다. 전체 앱 빌드·Docker 실기동은 GitHub CI 실행 결과를 따로 확인해야 한다. DNS·인증서·로그인·runner Online은 실제 증거가 나올 때까지 미검증이다.

공식 근거:
- https://caddyserver.com/docs/automatic-https
- https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- https://developers.cloudflare.com/dns/proxy-status/
- https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/
- https://docs.github.com/en/actions/reference/security/secure-use
- https://docs.docker.com/engine/install/ubuntu/
