# Project Status

> 검토용 초안: 2026-10-06 (KST). 저장소·main에 미반영. 아래 2026-10-03 인프라 기록은 최신 상태 재확인이 필요하다.

## 단계

- 0단계 최소 구성은 PR #7로 완료한 역사 기록이다.
- 현재 main에는 마스터·파트너스·구매자·공개/인증 화면과 서버 도메인·DB 마이그레이션·시험 코드가 있다. 화면별 정본 일치·실동작 검수 상태는 `docs/UI_STATUS.md`, 담당·블로커는 `HANDOFF.md`로 확인한다. 코드 존재만으로 완료율을 산정하지 않는다.
- 개발·디자인 정본 대조와 미완료 기능 보완을 진행하고 있다. 최신 디자인 정본은 `design/SCREEN_MAP.md`와 대상 FINAL 소스다.

## 현재 저장소 (main 코드 확인)

- Next.js 앱: 관리자·파트너스·구매자 쇼핑몰·공개/인증·API 라우트가 구현돼 있다. 근거: `app/(admin)/`, `app/(seller)/`, `app/(shop)/`, `app/api/`.
- 서버 영역: 권한·구독/청구·주문·배송/환불·재고·회원/적립금·쇼핑몰 운영·방송/큐·오버레이·YouTube·자동 연결·도우미·운영 감시 모듈이 있다. 근거: `lib/server/`와 `prisma/migrations/`. 실제 외부 호출·정본 검수 완료 여부는 별도다.
- CI에는 typecheck·build와 단위/통합 시험이 있다. e2e 야간 워크플로도 있다. 근거: `.github/workflows/ci.yml`, `.github/workflows/e2e-nightly.yml`, `tests/`. 이번 문서 조사에서 CI 성공·전체 시험 통과를 새로 검증하지 않았다.
- 테스트/운영 배포 및 시험 데이터·디스크 정리·시크릿 확인 워크플로가 저장소에 있다. 근거: `.github/workflows/`. 워크플로 존재는 최근 배포 성공·실서비스 정상 동작의 증거가 아니다.

## main·작업 브랜치 구분 (2026-10-06 KST 조사)

- 조사 main: `4a06ba9016dae9784774329c1e253ecc92b0c9d3`.
- 런칭 할인 변경은 `feat/onq-launch-discount-3-months`의 `32199545`까지 2커밋·15파일이며 main에 미반영이다. 할인 정책을 여기 복제하지 않고 해당 브랜치의 정본 문서 변경으로 관리한다.
- 이벤트 출시 범위 문서는 `docs/live-events-1-0-scope`의 `4b677623`까지 2커밋·1파일이며 원격 push 완료, PR 생성은 GitHub API 네트워크 403으로 차단됐다. 이 기록은 앱·UI·이벤트 동작의 완료를 뜻하지 않는다.
- PG 직접 계약 정책 정정은 별도 문서 브랜치 `docs/direct-pg-policy`에서 준비 중이다. PG 코드 추가나 외부 계약·실결제 실행은 포함하지 않는다.
- OPEN24 스냅샷(`/tmp/onq-open-prs.json`)과 fetched refs를 대조했으며 `PRODUCT_SCOPE.md`·`FEATURE_GAP.md`·`PROJECT_STATUS.md` 변경 겹침은 없었다. 이 문서는 MASTER 소유 상태 문서의 검토용 초안이며 저장소 원본을 수정하지 않았다.

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
