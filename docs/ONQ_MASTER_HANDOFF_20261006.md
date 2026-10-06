# ONQ 마스터 세션 인계 — 2026-10-06

## 인수 대상과 권한

- 대표님 지정 인수 세션: `codex://threads/01a10187-33d2-70d0-951f-e2d69fdd2dc1`.
- 대표님은 이 세션에 ONQ 마스터 역할, 기존 확정 지침, 개발 배정·감시·검수 추적·테스트 배포 업무의 인계를 지시하셨습니다.
- 기존 세션은 신규 개발을 중지하고 작업·검증·미완료 상태를 보존합니다. 인수 세션은 원격 및 실제 환경을 다시 확인한 다음 기존 작업부터 재개합니다.
- **마스터는 앱 코드를 직접 구현하지 않습니다.** 구현 전담과 독립 검수 전담을 배정하고 대표님께 지속 보고하며 배포를 담당합니다. 별도 감시 세션을 두어 누락·충돌·허위 완료를 지속 지적하게 합니다.
- 이 문서는 역할 위임과 작업 인계 기록입니다. 스레드로 직접 전송하거나 인증·실행 환경 권한이 자동 복사된 것은 아닙니다. 인수 세션의 수신·인수 완료는 확인하지 못했습니다.
- 문서 브랜치: `docs/onq-master-handoff-01a10187`. main 직접 수정·병합·배포를 하지 않았습니다.

## 반드시 유지할 대표님 지침

1. 호칭은 **대표님**, 극존칭·합니다체로 보고합니다. 실제 결과부터 간결하게 설명합니다. 불필요한 확인·승인 질문으로 작업을 멈추지 않습니다.
2. 저장소는 `https://github.com/jsexy0210-ship-it/Live-OBS-Platform`이며 최신 main이 Source of Truth입니다. remote·브랜치·dirty·열린 PR 전체·Issue 전체·Actions·HANDOFF·PROJECT_STATUS·최상위 정책·실제 디자인 소스를 직접 확인합니다.
3. 다른 작업자의 미커밋 변경을 삭제·덮어쓰지 않습니다. 파일 소유를 먼저 정하고 중복 작업을 금지합니다. main 직접 push, 강제 push, 테스트 skip, 타입·린트 우회, 미완료를 완료로 표시하는 행동을 하지 않습니다.
4. 구현 → 필요한 테스트 → PR → CI → 독립 검수 → main 반영 → 배포 준비·테스트 배포까지 계속 진행합니다. 단순 계획·보고만 제출하고 개발을 멈추지 않습니다. 저장소 규칙상 main 병합은 검수 전담이 수행합니다.
5. 별도 보안리뷰 자동화는 중지 상태입니다. 권한·판매자 격리·개인정보·결과 무결성·중복 실행 및 지급 방지는 기능 구현·테스트 범위로 계속 확인합니다.
6. 신규 유료 인프라·외부 유료 API·실결제·실제 경품 지급은 승인 없이 실행하지 않습니다. 기존 DB·실시간 연결·큐·배포 체계를 재사용합니다.
7. 테스트 VM 자동배포와 주기적 디스크 정리는 대표님이 승인하셨습니다. 승인 범위는 기존 테스트 인프라와 main/CI 절차입니다. 실제 자동배포 적용 상태와 feature 브랜치 구현을 구분합니다.
8. 근거 없는 완료율·잔여 개발 비율을 제시하지 않습니다. 자동화 단위시험, SQL 시험, API 통합, 브라우저 fixture, 실제 브라우저/API E2E, 실제 OBS 검증을 분리합니다.
9. 모델·속도는 역할에 맞게 비용을 아껴 배정합니다. 구현·복잡한 검수는 GPT-6.1-sol medium/high, 단순 감시는 가벼운 모델을 권장합니다. 사용 불가능한 Claude/Fable 모델·도구가 실행 중이라고 주장하지 않습니다. 이 세션이 마스터 모델을 자동 변경한 사실은 없습니다.
10. 최신 main의 `CLAUDE.md`, `HANDOFF.md`, `docs/session-prompt.md` 전문을 읽습니다. 사용자 최신 지시는 이전 문서의 상충 지침보다 우선하며 같은 작업으로 정본에 반영합니다.

## 최신 UX 확정 지시 — 아직 전체 완료 아님

- 모든 관리자·파트너스 페이지 제목 바로 아래 해당 페이지 목적 또는 핵심 안내를 짧게 표시합니다. 공통 `PageHead.description`을 사용하며 무의미한 자동 설명을 만들지 않습니다.
- 검색·필터는 데이터 표 바깥에 놓습니다. 목록 건수는 왼쪽, 작업·일괄 처리 버튼은 오른쪽입니다. 외곽 테두리는 **표 그리드만** 감싸며 검색·건수·버튼·페이지 이동·안내까지 감싸지 않습니다.
- 버튼 높이·폭·간격·역할은 기존 토큰과 공통 부품으로 통일합니다. 모바일의 작은 버튼, 겹침, 외부 컨테이너 경계 침범을 수정합니다.
- 플레이스홀더는 `검색어 입력`, `이름 입력`처럼 짧은 행동형으로 통일합니다. 사용자 문장의 `ex)`는 예시 표기이며 실제 플레이스홀더 접두어로 추가하지 않았습니다. 입력 길이·형식·필수 조건 안내는 라벨/helper/ARIA에 보존합니다.
- 읽기 전용 입력값의 글자는 회색 계열로 통일합니다. 현재 공통 토큰 색상 검증은 `rgb(107,112,122)`입니다.
- 날짜 입력은 대표님 캡처의 `시작일 [달력 아이콘] ~ 종료일 [달력 아이콘]` 형식으로 통일합니다. 날짜·시간 부품 자체의 동작·경계·키보드 문제도 해결합니다.
- **페이지 이동·섹션 이동용 탭 메뉴는 좌측 사이드 메뉴로 모두 풀어 배치합니다.** 상태·기간 필터, 폼 값 선택, 진행 단계 표시는 메뉴와 구분하여 기존 기능을 보존합니다. 탭을 지우기 전에 각 기능으로 이동 가능한 사이드 메뉴와 직접 URL 진입을 연결합니다.
- 디자인 정본은 `design/SCREEN_MAP.md` → 해당 FINAL 실제 HTML/CSS/JS → 공통 소스 → `docs/IA.md` 순서로 확인합니다. PNG는 검수 증거일 뿐 정본이 아닙니다. 외부 캔버스 연결은 현재 도구에서 사용할 수 없습니다.
- 공통 DS와 주문·입금 확인 일부 정본은 수정됐지만 관리자·파트너스 개별 FINAL 보드 전체 설명/프레임 동기화는 남았습니다. 앱 수정만으로 디자인 동기화 완료라고 보고하지 않습니다.

## 서비스·가격·결제 확정 정책

- OVERLAY: `OVERLAY + EXTERNAL_WEBHOOKS`; COMMERCE: 여기에 `STORE_MANAGEMENT` 추가.
- 가격 VAT 포함: OVERLAY 정가 99,000원·런칭 69,000원, COMMERCE 정가 249,000원·런칭 179,000원.
- 런칭 할인은 **첫 성공한 할인 결제부터 3 KST 달력개월** 적용합니다. 계정당 시작점을 보존하고 실패·대기 결제는 시작하지 않으며 재가입으로 초기화하지 않습니다. 이전 코드의 1회 할인 정책은 폐기 대상입니다.
- 자동 설치·연결 110,000원은 선택 사항이며 기본 선택하지 않습니다.
- PG 후보는 Payple 직접계약 / NHN KCP 직접계약만입니다. PASS 제외, SMS 본인확인입니다. 기존 NICEPAY 코드·설정을 지웠다는 뜻은 아닙니다. 정책 문서 브랜치와 런타임 전환을 구분합니다.
- Cafe24 OAuth·웹훅·주문 누락 보정 우선, 실제 OBS 주문 오버레이 E2E까지 검증해야 합니다.

## 방송 이벤트 1차 출시 필수 범위

ONQ는 판매 운영·시청자 참여 이벤트·OBS 송출을 연결하는 플랫폼입니다. 룰렛·사다리타기·랜덤 추첨은 1차 출시 필수입니다. 관련 없는 기존 정책은 바꾸지 않습니다.

### 공통 참가·운영·권한

- 하나의 이벤트/참가자/회차/결과/경품 관리 기반을 재사용합니다. 방송 연결, 참가 조건·규칙, 확정 명단, 설정·결과, 당첨/경품, 실행·취소·재추첨 이력을 기록합니다.
- 직접 입력, 여러 줄 붙여넣기, 모바일 참가 URL·QR, **현재 연결된 YouTube 라이브 채팅 키워드 자동 참가**를 지원해야 합니다.
- YouTube 참가: 판매자가 지정한 키워드와 **메시지 전체가 일치**해야 합니다(앞뒤 공백 정리). 같은 채널·라이브의 author channel ID로 식별하고 메시지 ID로 중복 방지합니다. 표시명·구독자 여부로 동일 인물을 단정하지 않습니다.
- 회원은 기존 회원 식별/세션과 판매자 소속을 사용합니다. 게스트는 불투명 서버 세션과 중복 방지 한계를 표시하며 실제 본인확인 완료 사용자로 취급하지 않습니다. 같은 표시명도 서로 다른 참가자일 수 있습니다.
- 모바일 참가에는 이벤트명·조건·규칙·참가 상태·마감 안내·개인정보 안내를 표시합니다. 전화번호·주소·본인인증을 일괄 필수화하지 않습니다. 요청 제한/서버 검증과 마감 후 서버 차단이 필수입니다.
- 상태: 작성 → 접수 → 마감·명단 확정 → 진행 → 완료, 별도 취소. 확정 이후 조용한 설정/명단 변경 금지, 실행 전 명시적 재설정 및 이력. 실행된 회차 설정·결과는 수정하지 않습니다.
- 무료 참여 기본입니다. 유료 응모·구매 필수·구매금액 비례 확률·후원·슬롯머신·현금 베팅·환전·신규 게임 확장은 제외합니다. 퀴즈·투표·빙고도 이번 구현 범위가 아닙니다.
- 테스트는 샘플 명단으로 실행하고 관리자/OBS에 표시하며 실제 당첨·쿠폰·적립금·배송·경품 지급에 영향을 주지 않습니다.

### 이벤트별 필수 기능

- 룰렛: 항목/경품 추첨과 참가자 추첨 2종, 제목/안내/항목 CRUD, 실행 전 미리보기, 회전·결과, 효과음 설정, 중복 당첨 허용 여부, 이전 당첨 대상 제외 후 다음 회차, 테스트/실제 분리, OBS, 회차 기록. 기본 동일 확률, 가중치·확률 조절·운영자 결과 지정 제외. 남은 대상·규칙을 실행 전에 보여 줍니다.
- 사다리: 참가자/결과 입력과 수량 일치 검증, 서버 생성 구조와 정확한 도착 매칭, 경로 애니메이션, 개별/전체 공개, 테스트/실제, OBS, 전체 결과 및 공개 상태 저장. 부족한 슬롯 자동 보충/참가자 자동 제외 금지. 새로고침·재연결 시 구조 재생성 금지. 알고리즘 검증 없이 균등/조작 불가 표시 금지.
- 랜덤 추첨: 1명/여러 명, 당첨 인원, 중복 허용/이전 당첨자 제외, 카운트다운, 순차/일괄 공개, OBS, 결과 기록. 룰렛과 참가자·추첨·기록 기반 공유.

### 결과·콘솔·OBS·경품

- 당첨 결과는 서버 CSPRNG와 트랜잭션/고유 제약/멱등 키로 확정·저장합니다. 프런트·OBS는 저장 결과를 표현하며 별도 추첨하지 않습니다.
- 버튼 연타, 두 운영자 동시 요청, 타임아웃 재시도, 새로고침, OBS 재연결, 메시지 중복에도 같은 회차는 1회 확정합니다.
- 재추첨은 이전 회차 참조·사유·실행자를 가진 새 회차입니다. 이전 결과를 덮어쓰지 않고 경품 처리 영향도 명시합니다. 숨겨진 조작/결과 수정 기능 금지.
- LIVE CONSOLE에서 선택·접수/마감·확정 수·테스트/실행·사다리 개별/전체 공개·재표시·다음 회차·종료/취소·경품 상태를 주문 큐와 함께 조작합니다. 비슷한 새 메뉴를 남발하지 않습니다.
- **결과 재표시 ≠ 전체 공개 ≠ 재추첨 ≠ 지급**. 재표시는 기존 공개 상태를 그대로 복원합니다.
- 기존 OBS 토큰/URL/SSE와 하나의 이벤트 화면을 재사용하고 대기·QR/URL·마감·카운트다운·진행·당첨을 표시합니다. URL 복사·안내·미리보기·테스트 지원. 주문 알림과의 우선순위/겹침 정의, 주문 수집·처리 중단 금지.
- 재연결 복원과 메시지 멱등 처리로 효과음·추첨·지급 중복을 방지합니다. OBS 읽기 권한으로 실행·취소·다른 판매자 데이터 접근 금지. 실명/연락처/주소/주문번호 등 방송 불필요 개인정보 제외.
- 경품은 당첨 결과와 지급 상태를 분리: 대기/처리 중/완료/실패/취소, 수동 확인·메모·중복 방지·실패 재처리.
- OVERLAY에서도 자체몰 없이 이벤트·참가자·콘솔·OBS·당첨·수동 지급 가능. COMMERCE는 기존 쿠폰/적립금 원장/배송 API와 연결하며 잔액 직접 수정 금지. 자동 지급 기반 없으면 미지원과 수동 가능을 명확히 구분합니다. PG 실연동으로 기본 이벤트 실행을 불필요하게 막지 않습니다.
- 빈 참가자/입력 오류/슬롯 불일치/마감/기실행/처리 중/연결 끊김/실행·지급 실패/권한 없음/취소를 처리합니다. 서버와 화면에 검증된 최대 수량 안내, 효과음/애니메이션 제어, 모바일 조작 영역 검증이 필수입니다.
- 출시 검증: 각 이벤트 생성→등록→마감/확정→실행→OBS→당첨→경품 전 흐름, 동시성/멱등/매칭/제외/재추첨/중복 지급, 권한/PII/테스트 영향 차단, 기존 주문·큐·OBS 알림/랭킹·상품/재고·쿠폰/포인트/배송·플랜·콘솔 회귀. 실제 OBS 불가하면 미검증과 확인 절차를 남깁니다.

## 실제 환경과 외부 접근 상태

- 작업 공간 `/workspace`, Ubuntu/bash 실행 환경, 모든 원본 worktree는 아래 inventory에 기록합니다.
- 테스트 VM: KakaoCloud `obs-web-test`, `210.109.15.68`, `test.on-aircue.com`, Ubuntu 24.04, 2 vCPU/4 GiB/SSD 30 GB.
- Docker Compose, PostgreSQL 16, Caddy, 앱 내부 3000, 공개 80/443, 상시 self-hosted runner `obs-kakao`, 배포 대상 main.
- Native Git `github.com` fetch/push는 실제 성공합니다. `api.github.com`은 환경 네트워크의 CONNECT/GraphQL `403 Forbidden`으로 차단됩니다. **토큰이 무효하다는 증거가 아닙니다.** GH PR 생성·CI 상세 조회·merge·workflow dispatch를 완료했다고 보고하지 않습니다.
- 사용자 제공 자격증명은 런타임 로컬 credential helper와 gh wrapper에 등록했습니다. 같은 실행 공간에서 `/tmp/onq-github-auth/credential-helper`, `/tmp/onq-github-auth/gh`를 사용합니다. 내용 출력·Git/문서 저장 금지. 다른 세션의 다른 환경으로 credential이 자동 이전되지는 않습니다.
- 환경 설정 draft에는 GH_TOKEN 요구 및 api.github.com 허용 변경을 저장했지만 runtime 적용/publish를 확인하지 못했습니다. 현재 도구에는 다른 스레드 메시지 전송, 환경 publish, secret binding 값을 설치하는 기능이 없습니다. 네트워크 우회·새 원격 relay workflow를 만들지 않습니다.
- 실제 SSH/실행 VM 접근·현재 배포 SHA·실제 OBS 실행은 확인되지 않았습니다. 문서의 과거 배포 성공을 현재 버전으로 간주하지 않습니다.
- Prisma 공식 engine 다운로드도 네트워크 정책으로 차단되어 신규 모델 client 생성이 실패합니다. 복사된 기존 Prisma client/DMMF에는 이벤트 모델이 없습니다. native API 통합은 `resetDb` fixture에서 `prisma://` 전용 오류로 본문 미진입합니다. 공식 client 생성 후 필수 재검증이며 SQL/mock 성공으로 대체 완료 처리하지 않습니다.

## main 및 충돌 기준

- 인계 시 다시 fetch한 main: `4a06ba9016dae9784774329c1e253ecc92b0c9d3`.
- GitHub 공개 목록 재확인: OPEN 24개, draft 7개, 1페이지 전체. 목록과 실제 head는 `handoff/open-prs.json`.
- #990 주문 목록: 주문 UX 브랜치가 해당 구현을 보존 merge했습니다. #992 구독 페이지: 할인 브랜치와 실제 UI 충돌이 있으므로 구조/기능을 양쪽 보존해야 합니다.
- #1000은 공용 `tests/unit/planFeatures.test.ts` 소유, #1006은 알림/스키마 관련이며 공유 경로 조정이 필요합니다. 함부로 경로 목록 시험을 고치지 않습니다.
- #572 기존 배포 PR을 자동배포 브랜치와 병합 대조했고 외부몰 env sync는 보존합니다.
- 디자인 PR #1002/#1004/#1005/#1008 등의 공통 auth CSS 및 메타데이터 변경을 덮지 않습니다. 공통 UI는 자기 hunk만 수정했습니다.
- 이전 공개 Actions 스냅샷 최신25개: success12/cancelled12/failure1, 최신 #3174 성공·#3173 MA082 실패. 이는 과거 공개 HTML 관측이며 현재 API 전체 큐/CI 결과가 아닙니다. 이번 작업 PR/CI는 생성되지 않았습니다.
- 열린 Issue 기존 확인 2개: #150 출시 플랜/설치·연결, #137 obs-test 인프라. 새 세션에서 현재 상태를 재확인합니다.
- main `PROJECT_STATUS.md`의 10월3일 최소 앱·테스트 없음 문구 및 일부 HANDOFF 구성은 실제 구현보다 낡았습니다. 최신 코드/실검증으로 상태 문서를 정리해야 합니다.

## 보존 브랜치와 검증 — 최종 체크포인트는 inventory 참조

| 작업 | 브랜치 / 기준 SHA | 실제 범위 및 다음 단계 |
|---|---|---|
| 자동배포/정리 | `feat/obs-test-auto-deploy` / `a0ccbf58` | main CI 성공·현재 main SHA 재확인 후 배포, 배포 후+매주 월03시 KST 정리. 자동 DB backup 최신3·배포 성공 image3+rollback+컨테이너 참조 보존. 수동 backup/.part/.env/volume/runner 보호. PR/CI/main 반영·실행 VM 검증 없음. |
| 3개월 할인 | `feat/onq-launch-discount-3-months` / `32199545` | 첫 성공 결제+3 KST 달력개월, 계정시작 보존, migration 및 문서15파일. 독립단위6/6; DB/전체UI는 미검증. #992 subscription UI 충돌 병합 해결 필요. |
| PG 정책 | `docs/direct-pg-policy` / `04bef8ad` | Payple/KCP 직접계약 후보 정본 및 과거 gap 문서 표시. 런타임 PG 변경 아님. |
| 이벤트 출시 정본 | `docs/live-events-1-0-scope` / `4b677623` | PRODUCT_SCOPE의 1차 이벤트/키워드 전체 일치/제외 항목 수정. |
| 이벤트 기초 | `feat/onq-broadcast-event-core` / `7f914b85` | 공통 event/entrant/round/result/rejection, YouTube 식별/중복/정확키워드 및 서버 초기 randomdraw. 이후 integration이 확장. |
| 추첨 helper | `feat/event-draw-engine` / `2ec66a79` | crypto.randomInt 공통 추첨·미리보기·당첨자 제외, 독립33/33, build/typecheck 통과. integration에 실제 merge됨. |
| 사다리 helper | `feat/event-ladder-engine` / `458b1494` | Fisher-Yates permutation·합법 rung·경로/도착 bijection, 독립33/33, build/typecheck 통과.128은 내부 보호 한도이며 상품 성능 약속 아님. integration에 merge됨. |
| 실행 integration | `feat/onq-event-execution-integration` / `e2014370` | 4종 실행·preview·immutable next/redraw·공개append·사다리개별/전체·재표시공개상태보존. BUYER mutation 차단/actor 분류/DB check. 관련88/88 독립, 원본SQL28/166migration 구현자 성공. native API/type/build 신규 Prisma 모델로 차단. 원래87e 검수 worktree와 redisplay5f→e201 worktree 보존. |
| 참가 소스 확장 | `feat/onq-event-entrant-modes` | parser5/5와3140ff8f merge 기반. 직접/붙여넣기/회원/게스트세션/공개참가API/FK/탈퇴비식별 작성, 최종 checkpoint/검증은 worker 보고와 inventory 확인. |
| 이벤트 디자인 | `design/event-1-0-canonical` / `0db70a51` | 20개 DRAFT/PROPOSED EVT1.0r1 실제 소스,54사진은증거. SA001진입/SA058운영/SH042참가/OV009송출 제안. FINAL/캔버스 동기화·실제 앱UI 아님. |
| 공통 목록/제목 | `feat/common-list-layout-contract` / `501499bb` | DS+PageHead.description/ListHead/ListTable/모바일단일경계/readonly/placeholder규칙. type/build343/designcheck 및 원본/부품1440·1024·390 통과. 개별 보드 전체 미동기화. |
| 주문/입금 UX | `feat/unified-order-list-ux` | own35fb6daa+#990+공통 merge; 검증immutable44f1b45a, 인계 직전236f773e source-only 최신merge. productionfixture8/8·type/build343/designcheck 통과, 실API·실입금 아님. |
| 파트너스 전체 UX | `feat/page-guidance-unification` / remote `6de969e0` | 80route 중62직접안내+10위임+2주문전담+5auth보존+1catchall. 목록40route/51grid, 간결placeholder. type/build/designcheck 통과. 성공fixture5×3+popup3=18, 전체목록모든성공상태는 미검증. local29e8a005 sidebar3패널 URL 연결은 후속 미검증. |
| 관리자 전체 UX | `feat/admin-layout-unification` | 41route=39안내+로그인1+placeholder1, 표42곳. fixture3route×3+dialog3=12 및readonly/권한추가검증. 최종typebuild/HEAD는 worker 보고/inventory 확인. staleWebpack generatedtype10오류는 본인cache의 fresh기본build로 소멸·API수정0. |
| 사이드 메뉴 전환 | `feat/navigation-sidebar-unification` | 별도 WIP. DS-NAV/SA-LNB→Shell/shellNav/PageHead출력제거/lnb CSS/IA, 쿼리 기반패널 계약 작성중. 아직 구현/실검증 완료 아님. |
| 날짜/시간 경계 | `feat/datetime-picker-boundaries` | 독립 base501499bb WIP. 기존 dirty데이트 worktree는 보존. 아래7결함을 수정·검증해야 함. |
| SA056 정합 | local `feat/sa056-hierarchy` / `df8a2c11` | 4section을2grid rows로 묶음. type/designcheck 성공하지만 모바일badge/chart경계/날짜겹침/CTA·summary·memberinfo·shell차이 남음. 외부통계소유불명확, main/PR 미반영. |

모든 로컬/원격 SHA·dirty·소유·checkpoint는 이 문서의 `handoff/worktree-inventory.json`와 `handoff/agent-checkpoints.md`를 함께 읽습니다. 앞선 검증 immutable SHA와 이후 WIP를 섞지 않습니다.

## 현재 전담 소유 및 재개 순서

1. `event_core_impl`: events service/entries/entryInput 및event API, schema 자기모델·migration, actor분류2줄, buyer withdraw hook1 및해당시험. 회원참가/탈퇴는 `lockSellerOrders → Seller row → BuyerMember lock` 순서 유지, 명단/결과 UUID불변과 개인식별정보 분리. 마지막 신규SQL15+기존28=43통과, serviceDBmock11+parser5통과, fresh167migration성공, native API5 fixture실패, 전체unit600성공/4 inventory실패까지 보고됐으며 후속 checkpoint 결과를 읽습니다.
2. `event_core_review`: 독립검수. redisplay5f 관련80/80, actor e201 관련88/88 독립 성공. SQL 숫자를 독립 재실행으로 부르지 않습니다. 현재 UI common501/orders44f/seller6de/admin 최종 검수 진행 도중 중지·기록합니다.
3. `event_design_source`: 공통 단계 완료, 현재 **DatePicker.tsx 전체 Date/Range/DateTime/신규 TimePicker**, index의TimePicker자기export1줄, 날짜 styles 및 DS-DATEPICKER 실제원본/전용테스트 소유. old dirty DatePicker 작업은 수정 금지.
4. `event_draw_engine`: 주문 단계 완료, 현재 **SellerShell, AdminShell, shellNav, PageHead RouteTabs 출력 제거줄만, seller.css lnb-parent/subnav/sub-i 블록, DS-NAV/SA-LNB, IA nav 규칙, 전용nav E2E** 소유. 전체common PageHead/스타일 재작성 금지.
5. `page_guidance_unification`: 파트너스 페이지/허가된 HomeDashboard·OverlayHome·ProductForm·StatsFrame의헤더/목록/placeholder, 후속bulk/legal/membermessages URLpanel 연결. 주문2개/common/admin수정금지. 종료·보존된 세션으로 인수 세션에서 명시적 followup/대체agent 재개.
6. `admin_layout_unification`: 관리자페이지 및 PartnerDetailTabs/PartnerTabs 등 해당헤더/목록/placeholder만, 후속partner8tabs query 소비. AdminShell/common/date/API 직접수정금지.
7. `watchdog_lite`: 독립누락/소유충돌/허위성공/PRCI배포미진행 감시, stable checkpoint복구. 다른worker의같은보고를반복복제하지말고실제새누락을푸시합니다.

이 agent 이름은 기존 thread 내부 이름입니다. 새 thread에서 자동 재사용 가능하다는 뜻은 아닙니다. 새 세션은 기능별 전담을 다시 만들거나 연결 가능한 agent를 확인하고 같은 파일 소유를 인수합니다.

### 날짜/시간의 확인된 7결함

1. scroll350 후 anchor y=-264인데popup y134로남음.
2. transform+overflow:hidden 부모에서popup잘림(centerhitfalse).
3. minDateTime2026-10-06T10:00에서동일날짜비활성·09:00허용오류.
4. 종료<시작을안내없이swap. 명시검증필요.
5. 390×320에서442pxsheet top=-122로잘림. 실제모바일키보드시험과구분.
6. Enter안내는달력열기인데현재입력commit동작불일치. focus/Down/Escape도검증.
7. main의단독TimePicker실제selector없음. 신규공통export와 HH:mm선택/입력/minmax/disabled/readOnly지원필요.

readonly·변환·KST·기존 value/onChange API를보존합니다. 원본검수 `/tmp/onq-date-audit/evidence/metrics.json` 및 `/tmp/onq-sa056-readonly-audit.md`를 참고합니다.

### 사이드 메뉴로 옮길 기존 탭

- 공통 `RouteTabs`, shell fallback `rtabs-top`: 새사이드메뉴에동일기능을연결후중복제거.
- 파트너스 StatsFrame 통계6route, products/bulk 등록/내보내기/이력, settings/legal 약관종류, member-messages 새발송/발송기록.
- 관리자 partners/[sellerId] 정보8탭. 정확querykey/value는 worker checkpoint계약을읽고상호일치검증.
- 상태필터/reviews/returns/shipping, 로그인계정종류, automation단계는 navigationmenu로오인해삭제하지않음.

## 검증·증거·PR 본문

- 공통 `/tmp/onq-list-layout-evidence/`, `/tmp/onq-list-layout-pr-body.md`.
- 주문 `/tmp/onq-order-list-evidence-final/manifest.json`, `/tmp/unified-order-list-ux-pr-body.md`; productionserver3124에서새E2E8건검증, 접근성라벨은 `주문 조건`(기존주문검색label과중복피함).
- 파트너스 원격브랜치 `tests/e2e/screenshots/page-guidance/`에 routeinventory/context/metrics/재현script/대표PNG 영속보존. `/tmp/onq-page-guidance-pr.md`.
- 관리자 `/tmp/onq-admin-layout-evidence/`, `/tmp/onq-admin-layout-pr.md`.
- 이벤트실행 `/tmp/event-execution-pr-body.md`, core `/tmp/event-core-pr-body.md`, draw `/tmp/event-draw-engine-pr.md`, ladder는 checkpoint 참고.
- 이벤트디자인 `/tmp/onq-event-design-pr-body.md`, metadata/canvas제안patch `/tmp/onq-event-metadata-proposal.patch`, `/tmp/onq-event-canvas-index-proposal.patch` (미적용).
- 정책 `/tmp/live-events-1-0-pr-body.md`, `/tmp/onq-direct-pg-pr-body.md`, 가격/배포 `/tmp/onq-docs-pr-body.md`, `/tmp/onq-auto-deploy-pr-body.md`.
- 개별FINAL source후속mapping `/tmp/onq-individual-source-sync-followup.json`; 외부canvas버전metadata일괄수정금지. 새세션에서도실제openPR추가소유를재확인합니다.
- 로컬복구 `/workspace/onq-recovery-20261006/` verifiedgitbundle/증분/patch/SHA256SUMS. secret/.env/운영DB/node_modules/.next는복구자료에포함하지않습니다. 같은환경이아니면로컬파일은자동사용불가이며원격refs/인계assets에서복원합니다.

## 다음 마스터가 실제로 수행할 일

1. main·전체PR/Issue/Actions·dirty/refs를새로확인하고이인계브랜치를fetch합니다. 원격작업브랜치의검증된SHA와WIP를분리합니다.
2. 환경API접근·Prisma공식engine/client생성차단을현재권한안에서확인합니다. 제약이남으면현재작업을완료/CI/main배포로표시하지말고코드·증거·PR본문부터검토가능하게보존합니다.
3. 참가등록/withdraw/concurrencycheckpoint를독립검수하고공식client생성후API통합/type/build를실제로통과시킵니다.
4. 날짜/시간7결함·캡처형식통일을완수하고ownedpage들의native date/time잔여callsite도공통부품으로연결합니다.
5. sidebar↔페이지query계약을완수합니다. 직접URL·뒤로가기·active/plan/권한·모바일메뉴·dirty폼행동을검증하고탭제거로숨은기능이없도록합니다.
6. 전체개별FINAL원본 설명·프레임·버튼·placeholder를실제소스로맞춥니다. source와실제캔버스동기화제약은구분합니다. 공통DS수정만으로전체디자인완료보고금지.
7. pricing#992/conflictingUI·배포#572·공유inventory#1000와기존UI9PR스택을검수전담과조정합니다. 정본디자인PR우선, 기존규칙CI·리뷰조건후검수전담병합, main자동배포워크플로검증을추적합니다.
8. 이벤트앱설정/모바일URL·QR/LIVE CONSOLE/OBS연출·reconnect·주문우선순위/수동경품, COMMERCE쿠폰/포인트/배송재사용연결은아직미완료이므로화면DRAFT/helper만으로완료보고하지않고전담구현합니다.
9. Cafe24실계정연동/누락보정·실제주문OBS E2E 및룰렛/사다리/추첨전흐름·회귀를별도검증합니다. 실제OBS환경없으면미검증과운영확인절차기록합니다.
10. 상태문서의낡은정리내용을실제main구현·검증근거로갱신하고, branch/commit/PR/CI/배포SHA/남은외부승인항목을대표님께보고합니다.

**인수 재개 문구:** 이 문서와 `handoff/` 자료를 읽고 대표님이 지정하신 ONQ 마스터 역할을 인수합니다. 최신 main 및 외부 실제 상태를 확인하고 위 파일별 소유·검증된 checkpoint부터 하위 전담 세션으로 이어갑니다.
