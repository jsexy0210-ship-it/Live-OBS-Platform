# Project Status

> 기준일: 2026-10-03

## 단계

0단계: 이전 프로젝트 정리 및 최소 구성 (완료, PR #7 병합)
1단계 준비: 망고TCG 구조 분석 (`docs/REFERENCE_MANGOTCG.md`)
1단계: 디자인 작업 (화면 구현보다 먼저 진행). 프롬프트: `docs/DESIGN_PROMPT.md`, 깨짐 수정·쇼핑몰 PC판 진행 중
개발 1단계(화면 제외 기반): 디자인과 병행 시작 (대표님 결정 2026-10-02 21:15 KST). 설계 → 데이터 모델·권한·주문대기 도메인·로그인·테스트

## 현재 저장소

- Next.js 최소 앱 (`app/layout.tsx`, `app/page.tsx`)
- CI: typecheck + build, 배포 워크플로 재유입 검사
- 배포 워크플로: `.github/workflows/deploy-obs-test.yml`(테스트 서버 obs-test, 수동 실행만, main만, Environment `obs-test`(승인자 지정은 대표님 조치 대기 ⑤를 마쳐야 적용됨, 그 전에는 승인 단계 없음), 상시 self-hosted runner `obs-kakao`(아직 등록 전). 대표님 결정 2026-10-03: 공개 저장소 + 상시 runner, 「Require approval for all external contributors」 필수). 테스트 도메인 `test.on-aircue.com`(Cloudflare DNS 전용). 절차: `docs/DEPLOY.md`

## 인프라 방향

기존 카카오클라우드 프로젝트·VM 자원을 신규 플랫폼에 재사용하는 방향 (운영자 결정, 2026-10-02).

- 카카오클라우드 자원은 새로 만든다. Leftlife 자원은 재사용하지 않는다 (대표님 결정, 2026-10-03 14:05 KST). Leftlife는 망고TCG와 무관하다(대표님 확인).
  - 테스트 서버 VM: 2vCPU · 4GB 한 대에 앱과 Postgres(시험용 데이터만)를 올린다. 대표님이 만든 VM은 `obs-web-test`(프로젝트 lifeleft / kr-central-2, Ubuntu 24.04, t1i.medium 2vCPU·4GB·SSD 30GB, 공인 IP 210.109.15.68, VPC `obs-vpc`, 서브넷 `obs-public-sn1`, 보안 그룹 `obs-web-sg`, 2026-10-03 대표님 보고). 비용이 나기 시작했고 무료 크레딧이 먼저 차감된다.
  - 생성은 대표님이 콘솔에서 직접 하고, MASTER가 순서를 안내한다. 액세스 키는 넘기지 않는다.
  - Leftlife VM·버킷·보안그룹은 새 서버가 뜨는 것을 확인한 뒤 삭제한다. 삭제 전에 남길 파일이 있는지 대표님이 확인한다.
  - 오늘 IP 이름으로 잘못 만든 DNS 영역(`210.109.15.68`)은 삭제한다. DNS 영역은 도메인을 산 뒤 그 이름으로 만든다.

- 테스트 VM 이름·IP: 대표님 보고로 확인(위). 서버 안 설정(Docker·runner·.env)은 대표님 조치 대기(HANDOFF)
- Object Storage 버킷: 존재 여부·이름 미확인
- 이번 작업에서 서버·DNS·러너는 변경하지 않음

## 미확정·미확인

- `docs/PRODUCT_SCOPE.md`의 미확정 항목
- 카카오클라우드 실제 자원 상태 (콘솔 확인 필요)
- 휴대폰 본인확인(문자) 대행사 미계약: 실제 연동 미검증, 운영에서는 「본인확인 서비스 준비 중」으로 가입 차단
