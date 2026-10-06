# 이벤트 1.0 제안 소스 — EVT-1.0-r1

**DRAFT / PROPOSED입니다. FINAL 구현 정본이 아닙니다.** 기존 디자인/공용 메타데이터/production 코드는 수정하지 않았습니다. 외부 Claude 캔버스와 동기화했다고 주장하지 않습니다. 검수와 metadata 병합·FINAL 승격이 먼저입니다.

| ID | 제안 경로 | 내용 |
|---|---|---|
| SA-001 (상태 소스 SA-001-EVENT) | /seller/broadcast | SA-001 v336 원본의 제목 행동 줄에 「이벤트 운영」 한 요소만 추가한 bounded variant |
| SA-058 | /seller/broadcast의 이벤트 운영 상태 | 기존 방송 GNB/LNB 유지 · 이벤트 목록/생성·설정·참여자·진행·결과 기록 |
| SH-042 | /event/[opaqueToken] | 쇼핑몰 없는 파트너스도 이용하는 독립 공개 참여 화면 |
| OV-009 | /overlay/[token]의 event state | OBS 주소 하나 재사용 · 16:9/9:16 · 대기/QR/마감/카운트다운/진행/결과/재연결 |

일반 HTML로 직접 열 수 있는 native preview입니다. 새로운 event-1-0.css/js만 참조하며 기존 공통 source/token/typography를 재사용합니다. SA-001-EVENT는 원본의 bounded 복제입니다. .dc.html import와 외부 canvas index 반영은 도구가 있는 디자인 전담 검수 후 진행합니다. font는 기존 design source와 같은 Wanted Sans 경로를 사용하며 Git 정적 열기에서는 원본과 같이 fallback합니다. 검수 서버는 같은 public Wanted Sans unicode-range 파일을 추가로 로드했습니다.

## 사용자 요구 대조

- 이벤트 목록/생성 및 방송 전 설정. 기존 콘솔 안의 단일 진입이며 새 GNB/LNB 메뉴가 없습니다.
- 키워드 입력은 명시 참여 신청입니다. 전체 채팅의 앞뒤 공백만 제거한 후 판매자 키워드와 exact match합니다. 부분 일치·대소문자·유사문자 변환은 없습니다.
- 채팅 중복은 stable author channel ID, QR guest는 익명 token/session으로 따로 막습니다. 같은 표시명으로 합치지 않습니다. 두 방법 사이 동일인 확인 불가와 guest 브라우저 변경 한계를 안내합니다. 자동 계정 연결·전화/주소/일괄 인증 필수화가 없습니다.
- 마감 확인/명단 확정, 설정 잠금, 참여 없음/당첨 인원 초과/진행 확인 실패/재연결·기록 상태 복원 안내.
- 무작위 추첨·참여자 룰렛·항목 룰렛·사다리. 항목 CRUD/동일확률, 사운드 꺼짐 기본, 미리보기, 기존 당첨 제외/중복 허용/후보 수.
- 사다리 인원과 슬롯 수 대조. 부족 슬롯은 확인 후 미당첨 추가하며 넘친 슬롯은 수정 요청. 개별/전체 공개와 결과 복원.
- 테스트/실제 확인 창·카운트다운·진행·순차/전체 공개. 실제 완료 뒤 같은 이벤트 재실행 잠금. 테스트 경품 지급 버튼 없음.
- 실행 전 이벤트 취소/실행 실패 확인/실제 기록 보존, 결과별 경품 지급 상태(대기/중/완료/확인 필요)와 파트너스 전용 수동 메모.
- 공개 참여 화면에 이벤트명·경품/조건·규칙·마감 안내·상태가 먼저 나옵니다. 참여/중복/대기/마감/진행/결과/종료/조회 실패·테스트 상태 포함.
- OBS 공개 화면에 표시명/참여 번호·경품 외 PII가 없습니다. 하단 주문 알림 띠는 공존 검수 indicator이며 신규 주문 위젯/OBS 소스를 추가하지 않습니다.

## 검증 증거 (2026-10-06 KST)

- npm run design:check 통과: IA IDs 196, map 203, 누락/깨진 경로 0. 새 보드는 공용 지도 등록 대기이므로 이 검사만으로 새 정본 등록을 주장하지 않습니다.
- node --check event-1-0.js 통과. 신규 파일/링크/유일 DOM id/source hash 검사는 별도 수행했습니다.
- Chromium 1440/1024/390에서 설정/참여/진행/기록과 공개 참여 가로 넘침 0, page error 0.
- 테스트 → 순차/전체 공개 → 지급 버튼 없음, 실제 → 재실행 잠금 → 결과별 지급 상태, 항목 CRUD, 사다리 부족 확인/보충·인원 불일치, 취소 상태를 브라우저에서 확인했습니다.
- 390×844 모든 표시 입력 focus와 Tab(저장→참여 열기), 일반 흐름 Footer, 키워드 focus/하단 스크롤 겹침 0. OS 모바일 soft keyboard는 Chromium viewport에서 재현하지 않았습니다.
- OBS 1920×1080/1080×1920 상태별 렌더와 주문 알림 영역을 직접 확인했습니다. 결과 선택/확률 검증은 디자인 fixture가 하므로 실제 랜덤 엔진 검증 증거가 아닙니다.
- 검수용 주요 증거는 event-1-0-review/에 보관했습니다. 전체 evidence: /tmp/onq-event-design-evidence/ · checks.json / acceptance-checks.json. 스크린샷은 정본이 아닙니다.

## 남은 판단/차단

공용 SCREEN_MAP/DESIGN_SOURCE/CHANGELOG/canvas.json은 fetched refs의 디자인 owner overlap으로 손대지 않았습니다. /tmp/onq-event-metadata-proposal.patch는 최신 안전한 main에서 재생성/검수한 뒤 소유 전담이 반영해야 합니다. sourceVersion은 외부 캔버스 v338을 뜻하지 않습니다.

유튜브↔guest 명시 opt-in 연결은 미정이며 자동 연결 UI를 만들지 않았습니다. 참여 고지/보관 기간, 무점포 공개 약관/처리방침 실제 경로, 공개 token 발급/만료, OBS 편집기에서 event 표시 영역 선택·기존 주문 영역 공존 방식은 코어/MASTER와 확정해야 합니다. 이 소스가 실제 서비스/API/추첨/효과음/스캔 가능한 QR을 구현하지 않습니다. API 403으로 PR 생성과 CI는 확인하지 못했습니다. FINAL 정본을 main에 반영하기 전 앱 UI 구현은 시작하지 않습니다.
