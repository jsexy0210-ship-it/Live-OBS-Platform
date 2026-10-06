이벤트 1.0 화면 정본이 없는 상태를 검수 가능한 신규 DRAFT 소스로 보완했습니다. source/version은 `EVT-1.0-r1`이며, FINAL 구현 정본으로 사용하지 않습니다. 기존 화면·공용 metadata·production 코드는 수정하지 않았습니다.

- `SA-001-EVENT` · `/seller/broadcast`: 기존 SA-001 v336 원본의 제목 행동 줄에 「이벤트 운영」 하나만 추가한 bounded variant입니다. GNB/LNB 메뉴 추가 없음.
- `SA-058` · 같은 콘솔의 이벤트 운영 상태: 이벤트 목록/생성·사전 설정·참여/마감·테스트/실제·카운트다운·룰렛 2종/사다리/추첨·순차/전체 공개·결과/경품 지급/수동 메모입니다.
- `SH-042` · `/event/[opaqueToken]`: 쇼핑몰이 없어도 이용하는 독립 공개 참여 화면입니다. opt-in exact keyword, guest/YouTube 분리 중복 방지와 동일인 확인 불가 한계를 안내합니다.
- `OV-009` · 기존 `/overlay/[token]`의 event state: OBS 주소 재사용, 16:9/9:16·전체 이벤트 상태·테스트 표시·PII 제외·주문 알림 공존 검수 indicator입니다.

검수 경로: `design/project/event-1-0.README.md`, `event-1-0.source.json`, 신규 .dc.html 4장, `event-1-0-review/` 주요 스크린샷/검사 JSON. 스크린샷은 증거이고 정본은 HTML/CSS/JS 소스입니다. preview는 native HTML의 로컬 fixture이며 실제 참가/추첨/지급/QR/효과음 API 구현이 아닙니다.

검증: 최신 origin/main 4a06ba9016dae9784774329c1e253ecc92b0c9d3 merge(Already up to date), `npm run design:check` 통과(IA196/MAP203/누락0/경로0), JS syntax/신규 link·id·hash/단일 console entry 검증, Chromium 1440/1024/390 overflow0/pageError0, 390×844 전 입력 focus·Tab·Footer 겹침0, 항목 CRUD·사다리 부족/불일치·취소·test/real·공개·지급 flow, 1920×1080/1080×1920 주문 indicator clipping 없음 확인. OS 모바일 soft keyboard와 실제 랜덤 엔진은 이 디자인 검증 범위 밖입니다.

남은 판단/차단: fetched PR refs #986/#995/#1002/#1004/#1005가 SCREEN_MAP/DESIGN_SOURCE/CHANGELOG/canvas.json을 동시에 변경하므로 이번 PR에는 수정하지 않았습니다. 정확 metadata/canvas index proposal patch는 MASTER에 별도로 전달했습니다. 외부 Claude canvas tool이 없어 동기화/새 canvas version을 주장하지 않습니다. 공유 metadata 안전 통합·IA 등록·canvas 반영·독립 검수·FINAL 승격 후 UI 구현을 시작합니다. QR guest↔YouTube opt-in 계정 연결 정책, 보관/고지와 무점포 공개 약관 경로·token lifecycle/편집기 배치 연계는 MASTER/코어 판단이 남습니다. 직접 main merge하지 않습니다.
