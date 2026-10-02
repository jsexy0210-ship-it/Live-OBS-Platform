# HANDOFF

> 기준일: 2026-10-02 (KST)
> 브랜치: `claude/ecstatic-ramanujan-bmzcay`

## 세션

| 세션 | ID | 담당 |
|---|---|---|
| Live-OBS-Platform MASTER | `session_01XqBPGTKiEMmRSMB5SfFp3C` | 요구사항 접수 · 작업 배정 · 독립 검수 · main 병합 · 상태 문서 관리 |

전담 세션은 아직 없다. 생성 시 이 표에 추가하고 `docs/session-prompt.md`를 지시에 넣는다.

## 완료

- 0단계 이전 프로젝트 정리 및 최소 구성: PR #7 병합 (2026-10-02 16:23 KST, merge `b92cad1`)
  - 이전 프로젝트 코드·문서·배포 워크플로·서버 스크립트 제거. 상세 목록은 Git 이력 참조.
  - 병합 시 배포 워크플로 미실행 확인 (CI만 실행).
- 망고TCG 참조 저장소 구조 분석: `docs/REFERENCE_MANGOTCG.md`

## 현재 구성

- Next.js 최소 앱 (`app/layout.tsx`, `app/page.tsx`)
- CI: typecheck + build, self-hosted 배포 워크플로 재유입 검사
- 배포 워크플로: 없음
- 테스트: 없음

## 미확인·미변경 (권한/범위 밖)

- 이전 프로젝트 흔적 (재검토 2026-10-02 KST, 현재 파일에는 없음):
  - 원격 브랜치 11개: 대표님 지시로 삭제 완료 (2026-10-02 KST 확인, 남은 원격 브랜치는 `main`과 MASTER 작업 브랜치).
  - 종료된 PR #1~#6: 이전 프로젝트 제목·본문. GitHub에서 PR 삭제 불가.
  - Actions 실행 기록과 빌드 아티팩트 `lifeleft-production-static` (2026-10-06 08:24 KST 자동 만료). 실행 기록 삭제는 Actions 화면에서 가능.
  - Git 커밋 이력: 이력 재작성 금지로 유지.
- 기존 self-hosted 러너, 저장소 Secrets·Environments: 미확인, 유지.
- 카카오클라우드 실제 자원(프로젝트·VM·버킷·DNS): 미확인, 변경 없음. 기존 VM에서 이전 사이트가 계속 서비스 중일 수 있음.

## 다음 작업

1. 카카오클라우드 재사용 확인 (운영자 콘솔 화면 필요, 키는 가림):
   - 기존 이름이 IAM 프로젝트인지 Object Storage 버킷인지 식별
   - 프로젝트: 이름 변경 불가 → 유지, 설명만 변경
   - 버킷: 새 버킷 생성 → 필요한 파일만 복사 → 연결·검증 → 기존 버킷 삭제는 별도 결정 (객체 URL에 버킷명 포함 주의)
   - 기존 VM의 이전 사이트 종료 여부 결정
2. **디자인 작업 우선** (운영자 결정, 2026-10-02): 화면 디자인 확정 전 기능 구현을 시작하지 않는다. 클로드디자인 프롬프트: `docs/DESIGN_PROMPT.md`
3. 디자인 확정 후 대기열 도메인 판매자 범위 재설계 및 단위 테스트 (`docs/REFERENCE_MANGOTCG.md` 7절).
4. 데이터 모델(판매자·상품·재고·주문·적립금) 및 DB 선택 설계.
