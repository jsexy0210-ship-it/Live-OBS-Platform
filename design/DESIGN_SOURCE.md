# DESIGN_SOURCE — 디자인 정본 출처와 우선순위

| 항목 | 값 |
|---|---|
| Artifact | https://claude.ai/artifact/YYGXZ3u4QvjQpEMUHnN4tS (Claude Design 캔버스 「ONQ (OnAirCue) 전체 화면 디자인」) |
| 동기화한 버전 | `1791213911-1437` (v271 `1791212943-9f5c` 이후 캔버스 전체 재동기화: 보드 342장 크기 대조 일치) · 부분 동기화 v279 `1791215615-5ed1`(GNB·LNB 셸 · ← 버튼 · 통합 탭 · 이용권) · v280 `1791215940-2ce9`(셸 재동기화) · v281 `1791216406-e929`(쉬운 말 FINAL 24장 · SA-022 상태 이력) · v282 `1791216847-dff7`(AU-008 · SA-023 · SA-029) · v283 `1791217115-7fad`(SA-060 FINAL) · v284 `1791217340-eeda`(구매자 ← 44 · SH-003/005 재확인) · v285 `1791217461-521d`(SA-041 FINAL · SA-062 날짜 칸) · v286 `1791217504-7bca`(SA-041 FINAL · SA-062 날짜 칸) · v287 `1791217739-ca0d`(FINAL 26장 날짜 · 필터 · 일시) · v288 `1791217961-0a6c`(설정 · 적립금 9장 FINAL) · v289 `1791218119-0fe3`(방송 묶음 7장 FINAL) · v290 `1791218258-c278`(운영 묶음 9장 FINAL) · v291 `1791219075-ad9b`(마스터 15장 FINAL · MA-001-IA 3섹션) · v292 `1791219414-c487`(파트너스 17장 FINAL) · v293 `1791238661-161d`(MA-081 FINAL) · v294 `1791238725-244f`(SA-056 기간 칩) · v295 `1791238855-8cd0`(나머지 마스터 20장 FINAL · DS-NAV 띄어쓰기) · v296 `1791239078-7381`(인증 10장 FINAL) · v297 `1791239220-fcb0`(공개 10장 FINAL) · v298 `1791239414-fa20`(구매자 4장 FINAL · 비회원 주문 제거) · v299 `1791239687-96b7`(SH-022-R 교환·반품 시트 · SH-022-RF) · v300 `1791239970-91e4`(코드 PR 쉬운 말 문구 일괄 반영) · v301 `1791240487-94ff`(SA-012 이미지 한도 변형 삭제) · v302 `1791240973-f773`(보드 12장 구현 대조 정리) · v303 `1791241210-a098`(SA-056 캔버스 재동기화) · v304 `1791242205-7ae5`(SA-051 경로 중복 정리) · v305 `1791242482-60c2`(AU-002 · AU-012 캔버스 재동기화) · v306 `1791243074-c01b`(PF-007 가입 신청 5단계 화면) · v307 `1791243912-69d4`(MA-120 인프라 · 비용) · v308 `1791244117-7b5d`(MA-001 인프라 카드 · MA-120 외부 연결) · v309 `1791244589-fc7f`(SA-060 공유 글자 수 60/160) · v310 `1791244939-8b87`(문의 분류 8종 정렬 · 담당자 비노출) · v311 `1791245964-0d7e`(방송 묶음 쉬운 말 SA-001 · 053 · 054 · 055) · v312 `1791246297-cc12`(SA-053 제목 「HIT 카드 기록」 · canvas.json PF-007 분할 항목 복원) · v313 `1791247211-153e`(SH-040 FINAL 준비 중 · 일시 정지 안내 · SA-060 운영 상태 안내 · SA-001 채팅 가져오기 잔존 정리) · v314 `1791248032-de23`(DS-TABLE-CARD 공통 표 모바일 카드 신설) · v315 `1791248663-aca7`(lop.css 모바일 카드 버튼 44 · 날짜 칸 `.i.dt` 규칙 캔버스 복원 · SA-011-M · SA-FRAME-M 높이) · v316 `1791249109-2097`(DRAFT→FINAL 묶음 1: SA-023 · 029 · 100 · 130 · 140) · v317 `1791249725-8d06`(보드 반영 묶음 2: SA-150 · MA-024 · SH-022 3장 · SA-114 · MA-052 · SA-061 · SH-040 2장 · SH-041 · SH-012 2장 · SA-064 · SA-065) · v318 `1791249763-25e3`(MA-052 방송 화면 칸 두 줄) |
| 동기화 시각 | 2026-10-06 10:25 KST |
| 디자인 전담 세션 | 디자인 전담 (5) `session_011d8Z2cYpic36sAioV2XasE` (`HANDOFF.md` 세션 표) |
| Git 경로 | `design/project/` (캔버스 `project/`와 1:1, 파일명·상대 경로 보존) |
| 소스 파일 수 | 366 (보드 342장 · canvas.json · ds/wds 2 · lop.css · ov.css · ibgen 17 · fonts/WantedSans-OFL.txt) |

## 정본 우선순위

1. 대표님 최신 확정 지시 (`CLAUDE.md` 결정 기록 · MASTER 전달)
2. `design/SCREEN_MAP.md`에서 **FINAL**인 화면의 소스
3. `design/project/` (DRAFT 포함, 구현 참고용)
4. 공통 디자인 시스템: `design/project/lop.css` · `ov.css` · `ds/wds/tokens.json` · `DS-PANEL` · `DS-ROW-ACTION` · `SA-LNB` · `SH-CARD-IA`
5. `docs/IA.md` (메뉴 계층 · 화면 ID)
6. `docs/DESIGN_PROMPT.md` (요청문 · 규격 · 문구 규칙)
7. 현재 production 구현 — **production은 디자인 정본보다 우선하지 않는다**

`docs/DESIGN_GAP.md`와 `docs/design-gap/`은 과거 디자인↔개발 비교 기록이며 정본이 아니다.

## 버전 관리

- 버전 폴더(`v221/` 등)를 복제하지 않는다. Git 이력이 버전 관리이고, 캔버스 버전은 커밋 메시지와 `design/CHANGELOG.md`에 적는다.
- 캔버스를 고칠 때마다 `design/project`를 같은 내용으로 동기화하는 PR을 낸다(디자인 전담). 동기화 전 캔버스 버전이 Git보다 앞서 있을 수 있으니, 개발은 `SCREEN_MAP.md`의 「Artifact Version」과 캔버스의 현재 버전을 비교해 차이가 있으면 디자인 전담에 동기화를 요청한다.

## 예외

- **고아 파일**: 캔버스의 `project/SA-045.dc.html`(옛 틀의 회원 알림 발송 보드)은 `canvas.json` 인덱스 밖이고 SA-049로 이동된 보드가 따로 있어 복사하지 않았다(MASTER 결정 2026-10-05). MASTER가 캔버스에서 삭제함(v257 `1791209877-f282`, canvas.json 변경 없음) — 이 시점부터 `design/project`는 캔버스 `project/`와 서체 파일 외 1:1이다.
- **서체**: 캔버스의 `project/fonts/WantedSansVariable.woff2`(1.2MB)는 복사하지 않았다. 저장소에 이미 있는 `public/fonts/wanted-sans/split/WantedSansVariable.split.*.woff2`(92개 unicode-range 분할, `styles/wanted-sans.css`)가 같은 서체(Wanted Sans Variable, SIL OFL 1.1)다. 디자인 `lop.css`·`ov.css`의 `@font-face`는 `fonts/WantedSansVariable.woff2`를 가리키므로 저장소 안에서 정적으로 열면 시스템 서체로 대체된다.
- **런타임**: 보드가 참조하는 `./support.js`와 캔버스의 `artifact-type/**` · `index.html` · `SKILL.md` · 루트의 `*.dc.html`은 Artifact 유형 소유라 이관 대상이 아니다. 따라서 Build는 NOT_APPLICABLE이다.
- **업로드 이미지**(`/_blob/…`): 2026-10-05 기준 보드가 참조하는 블롭이 없다(스크립트 검사 0건). 생기면 `design/project/` 안에 받아 두고 경로 대응을 여기에 적는다.
- **외부 의존**: Google Fonts 등 외부 CDN 참조 없음(검사 0건). `ibgen/shot_board.mjs.txt`의 `localhost:8000`은 생성 스크립트 기록이다.
- **비밀값**: 파일 내용을 검사했다. 사람 이름·번호·이메일은 모두 자리표시자(`[휴대폰 번호]` · `010-0000-0000` · `byulbit@mail.com` 등 가상 값)다.
