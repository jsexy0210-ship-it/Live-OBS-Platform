# Project Status

> 기준일: 2026-10-06 (KST)

## 마스터 인수 시 재확인

- 대표님 지정 인계 브랜치 `docs/onq-master-handoff-01a10187`의 `docs/ONQ_MASTER_HANDOFF_20261006.md` 및 checkpoint를 확인하고 Codex MASTER가 인수했습니다. main 직접 수정·배포 없이 독립 checkout에서 재개했습니다.
- 재확인 main: `4a06ba9016dae9784774329c1e253ecc92b0c9d3`, CI run `37439099514` 성공. 열린 PR 24개(초안 7개), 열린 Issue #137·#150입니다. 이 수치는 인수 시 스냅샷입니다.
- GitHub API는 현재 Windows 실행 환경에서 정상 접근됩니다. 이전 클라우드의 API 차단은 현재 차단으로 간주하지 않습니다.
- runner `obs-web-test`: online, 조회 시 idle. 최근 수동 테스트 배포 run `37435312037` 성공.
- 공개 `/api/health`: HTTP 200, `status=ok`, `db=ok`, `testMode=true`, 배포 version `ed429d3519dfa60bd7ef76f8e94f633b12521273`. 최신 main 배포·인증된 사용자 기능·실제 OBS 검증 성공은 아닙니다.
- 날짜·시간 7결함 복구, 이벤트 참가 WIP/검증 환경 독립 확인, 원격 보존·소유 충돌 감시를 별도 전담에 배정했습니다. 아직 구현·검수 완료가 아닙니다.
- 자동배포·정리와 할인·이벤트·공통 UI의 보존 feature/WIP는 인계 자료를 기준으로 검수하며, 기존 테스트 숫자를 현재 환경 재실행 성공으로 재사용하지 않습니다.

## 단계

0단계: 이전 프로젝트 정리 및 최소 구성 (완료, PR #7 병합)
1단계 준비: 망고TCG 구조 분석 (`docs/REFERENCE_MANGOTCG.md`)
1단계: 디자인 작업 (화면 구현보다 먼저 진행). 프롬프트: `docs/DESIGN_PROMPT.md`, 깨짐 수정·쇼핑몰 PC판 진행 중
개발 1단계(화면 제외 기반): 디자인과 병행 시작 (대표님 결정 2026-10-02 21:15 KST). 설계 → 데이터 모델·권한·주문대기 도메인·로그인·테스트

## 현재 저장소

- Next.js 앱에는 관리자·파트너스·쇼핑몰·오버레이 화면 및 주문·구독·재고 등 서버 구현과 시험이 존재합니다. 기능별 완료 여부는 실제 검증으로 판정하며 최소 앱 단계 문구는 과거 기록입니다.
- CI 및 배포 정의는 최신 `.github/workflows/`를 기준으로 확인합니다. CI 성공과 전체 기능·디자인·배포 검증을 구분합니다.
- 배포 워크플로: `.github/workflows/deploy-obs-test.yml`(테스트 서버 obs-test, 수동 실행만, main만, Environment `obs-test`(main만, 승인자 대표님), 상시 self-hosted runner `obs-web-test`(라벨 `obs-kakao`, 서버의 `/home/obs`에 설치·서비스 등록). 2026-10-03 첫 배포 성공: `https://test.on-aircue.com/api/health` → status ok, db ok, version c37492f. 대표님 결정 2026-10-03: 공개 저장소 + 상시 runner, 「Require approval for all external contributors」 필수). 테스트 도메인 `test.on-aircue.com`(Cloudflare DNS 전용). 절차: `docs/DEPLOY.md`

## 인프라 방향

기존 카카오클라우드 프로젝트·VM 자원을 신규 플랫폼에 재사용하는 방향 (운영자 결정, 2026-10-02).

- 카카오클라우드 자원은 새로 만든다. Leftlife 자원은 재사용하지 않는다 (대표님 결정, 2026-10-03 14:05 KST). Leftlife는 망고TCG와 무관하다(대표님 확인).
  - 테스트 서버 VM: 2vCPU · 4GB 한 대에 앱과 Postgres(시험용 데이터만)를 올린다. 대표님이 만든 VM은 `obs-web-test`(프로젝트 lifeleft / kr-central-2, Ubuntu 24.04, t1i.medium 2vCPU·4GB·SSD 30GB, 공인 IP 210.109.15.68, VPC `obs-vpc`, 서브넷 `obs-public-sn1`, 보안 그룹 `obs-web-sg`, 2026-10-03 대표님 보고). 비용이 나기 시작했고 무료 크레딧이 먼저 차감된다.
  - 생성은 대표님이 콘솔에서 직접 하고, MASTER가 순서를 안내한다. 액세스 키는 넘기지 않는다.
  - Leftlife VM·버킷·보안그룹은 새 서버가 뜨는 것을 확인한 뒤 삭제한다. 삭제 전에 남길 파일이 있는지 대표님이 확인한다.
  - 오늘 IP 이름으로 잘못 만든 DNS 영역(`210.109.15.68`)은 삭제한다. DNS 영역은 도메인을 산 뒤 그 이름으로 만든다.

- 테스트 VM 이름·IP: 대표님 보고로 확인(위). 서버 안 설정(Docker·runner·.env)과 첫 배포는 2026-10-03 대표님이 마침
- Object Storage 버킷: 존재 여부·이름 미확인
- DNS `test.on-aircue.com`(Cloudflare, DNS only)은 대표님이 등록함. 서버 안 설정·runner 등록·첫 배포는 2026-10-03 대표님이 마침

## 미확정·미확인

- `docs/PRODUCT_SCOPE.md`의 미확정 항목
- 카카오클라우드 이전(Leftlife) VM·버킷·보안 그룹과 Object Storage 버킷 상태 (콘솔 확인 필요). 테스트 VM `obs-web-test`는 확인됨(위 「인프라 방향」)
- 휴대폰 본인확인(문자) 대행사 미계약: 실제 연동 미검증, 운영에서는 「본인확인 서비스 준비 중」으로 가입 차단
