# HANDOFF

> 기준일: 2026-10-02 · 기준 main: `d3a3261`
> 브랜치: `claude/ecstatic-ramanujan-bmzcay`
> PR: https://github.com/jsexy0210-ship-it/Live-OBS-Platform/pull/7 (draft)

## 이번 작업: LifeLeft 정리 및 최소 구성

### 삭제

- 배포: `.github/workflows/deploy-lifeleft-domain.yml`, `.github/workflows/stage-kakao-static.yml`
- 스크립트: `scripts/{stage-lifeleft-static,install-lifeleft-domain,rollback-lifeleft-domain,finalize-lifeleft-domain}.sh`
- 페이지: `app/{about,career,commute,privacy,ranking,salary,subscriptions,survival,weekends,work-time}/page.tsx`, `app/robots.ts`, `app/sitemap.ts`, `app/globals.css`
- 브랜드 자산: `app/{apple-icon.png,favicon.ico,icon.svg}`, `public/og/*.png`(9), `public/ads.txt`
- 컴포넌트: `components/*` 22개 전체 (LifeLeft 계산기·광고·공유)
- 로직: `lib/*` 13개 전체 (계산·통계·광고·사이트 메타)
- 문서: `docs/{DEPLOYMENT,IMPLEMENTATION_STATUS,INFRASTRUCTURE,MVP_SPEC}.md`
- 의존성: `recharts`

### 교체

`package.json`(이름 `live-obs-platform`), `next.config.ts`(static export 제거), `app/layout.tsx`, `app/page.tsx`, `.github/workflows/ci.yml`, `README.md`, `.gitignore`(`*.tsbuildinfo` 추가)

### 유지

`tsconfig.json`, `next-env.d.ts`, Git 이력 전체

### 신규

`CLAUDE.md`, `PROJECT_STATUS.md`, `HANDOFF.md`, `docs/PRODUCT_SCOPE.md`

## 검증 결과

- `npm run typecheck`: 통과
- `npm run build`: 통과 (`/`, `/_not-found`)
- CI 배포 재유입 검사(`self-hosted|lifeleft`): 로컬 통과
- 테스트: 기존·신규 모두 없음
- PR CI: PR 체크 확인

## 배포 차단 상태

- 작업 시작 시 열린 PR 0, 실행·대기 중 Actions 0 (최근 실행 모두 completed)
- 기존 `Deploy LifeLeft Domain`은 main push마다 `lifeleft-kakao` self-hosted 러너로 배포했다 (마지막 실행 `d3a3261`, success).
- 이 PR은 해당 워크플로 파일을 삭제한다. 머지 커밋에는 파일이 없으므로 머지 push로 배포가 실행되지 않는다.
- **머지 전**에는 main에 워크플로가 남아 있어 main에 다른 push가 생기면 배포가 실행된다. 이 PR 머지 전 main 직접 push 금지.
- 신규 운영 배포: 미구성

## 미확인·미변경 (권한/범위 밖)

- GitHub Actions 워크플로 비활성화(Disable) 설정: 이 세션 도구로 변경 불가. 머지 후 파일 삭제로 실행 경로 제거되나, UI에서 `Deploy LifeLeft Domain`·`Stage Kakao Static`을 Disable 하면 이중 차단됨.
- self-hosted 러너 `lifeleft-kakao`: 등록 상태 미확인, 유지(삭제 금지 지시).
- 저장소 Secrets·Environments: 미확인.
- 카카오클라우드 실제 자원(프로젝트·VM·버킷·DNS): 미확인, 변경 없음. 기존 LifeLeft 사이트(`lifeleft.duckdns.org`)는 VM에서 계속 서비스 중일 수 있음.
- 망고TCG 참조 저장소: 이번 단계에서 조회·수정하지 않음.

## 다음 작업

1. PR #7 CI 통과 확인 → 운영자 검토 후 머지.
2. GitHub UI에서 LifeLeft 워크플로 Disable 여부 결정.
3. 카카오클라우드 재사용 확인 (운영자 콘솔 화면 필요, 키는 가림):
   - `lifeleft`가 IAM 프로젝트인지 Object Storage 버킷인지 식별
   - 프로젝트: 이름 변경 불가 → 유지, 설명만 변경
   - 버킷: 새 버킷 생성 → 필요한 파일만 복사 → 연결·검증 → 기존 버킷 삭제는 별도 결정 (객체 URL에 버킷명 포함 주의)
   - VM의 기존 LifeLeft 사이트 종료 여부 결정
4. 망고TCG 저장소 구조 분석 → 재사용 모듈 목록화 (대기열·오버레이·HIT·알림).
5. 데이터 모델(판매자·상품·재고·주문) 및 DB 선택 설계.
