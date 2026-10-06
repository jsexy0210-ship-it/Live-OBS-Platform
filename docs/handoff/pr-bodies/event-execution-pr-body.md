## 재표시 결함 정정

87e3249b의 redisplay가 새 ALL 공개기록을 만들던 결함을 5f7abf2b에서 수정했습니다. redisplay는 전용 함수로 현재 publicationState와 저장 결과만 복원합니다. 개별·전체 공개는 명시 scope를 요구하며 기본 ALL 처리를 제거했습니다. DBmock 실제 service 회귀3건은 부분공개 → 재표시/재시도의 공개범위 불변, RNG0/새회차0/새결과0/지급0을 확인했습니다. 네이티브 Prisma 통합 증거를 대신하지 않습니다.

## 변경

YouTube 방송 이벤트의 frozen 회차 실행을 공통 구조에 연결했습니다. 항목 룰렛·참가자 룰렛·사다리·랜덤 추첨은 기존 서버 CSPRNG 도우미를 재사용합니다. YouTube 원문은 메모리에서 trim 후 전체 equality로 참가 키워드와 비교하며, 기존 200자 저장정책과 안정 author channel ID/메시지 ID 중복 방지를 유지합니다.

다음 회차는 원회차·사유·실행자·requestKey와 불변 명단/규칙 snapshot을 보존합니다. 추첨/룰렛은 이전 선택 제외 또는 명시적 중복허용을 지원합니다. 기존 draw 재시도는 항상 첫 회차이며 execute는 명시 roundId를 요구합니다. 사다리는 저장 구조/결과를 보존하고 개별·전체 공개기록을 분리합니다. Redisplay/reveal은 기존 결과와 공개기록만 읽고 RNG·지급을 실행하지 않습니다. 기존 회원/주문/경품 원장을 복제하지 않았습니다.

## 의존성 및 검증 상태

- base origin/main: 4a06ba9016dae9784774329c1e253ecc92b0c9d3
- core 7f914b85 + equal-chance draw 2ec66a79 + ladder 458b1494를 병합해 재사용했습니다. 도우미 구현/단위검사는 수정하지 않았습니다. 독립 도우미 PR 선행 병합 또는 이 PR 포함 병합 순서 조율이 필요합니다.
- migration 20261006310000_audience_event_execution은 core migration20261006300000 뒤에 적용합니다. 운영 적용/배포는 수행하지 않았습니다.
- 최신 main 동기화 후 PR1000 + PR1006 head를 함께 합성한 git merge-tree는 충돌 없이 통과했습니다. Prisma schema-to-DB diff 검증을 대신하지 않습니다.
- `npx vitest run tests/unit/eventRedisplay.test.ts tests/unit/eventExecution.test.ts tests/unit/eventsDraw.test.ts tests/unit/eventLadder.test.ts tests/unit/broadcastEventCore.test.ts`: 80/80 통과(adapter9 + 기존 helper66 + core2 + 실제 service DBmock 재표시회귀3).
- disposable 로컬 PostgreSQL `event_execution_final_test`에 현재 브랜치 전체165migration SQL 적용 성공.
- `DATABASE_URL=<disposable local test DB> npx vitest run tests/integration/eventExecutionSql.test.ts tests/integration/broadcastEventCoreSql.test.ts --no-file-parallelism`: 23/23 통과(새SQL14 + 기존SQL9). SQL persistence/constraint 검사이며 Prisma 서비스/API 통합을 대체하지 않습니다.
- `npm test`: 579 통과/1 실패. 3개 event API가 공용 planFeatures inventory에 미등록입니다. #1000과 겹치는 공유 파일 담당 규칙상 해당 파일을 수정·skip하지 않았습니다. 담당 변경 병합 후 본인 경로3줄을 순차 반영해야 합니다.
- Prisma 서비스/API 통합19건 실행: 모두 resetDb fixture에서 기존 copied client가 prisma:// datasource를 요구해 실패했습니다. 서비스 로직 검증 완료로 표시하지 않습니다.
- `npx prisma validate`: pinned official schema-engine checksum 다운로드403. 기존 정상 캐시/설치 경로에 동일 버전 native engine이 없었습니다. wasm/custom generator/임시 모델 타입/체크섬 우회/package-lock 변경 없이 제한을 유지했습니다.
- `npm run typecheck`: 신규 AudienceEvent generated client 타입 부재로 실패.
- `npm run build`: application compile 성공 후 동일 generated client 타입 오류로 실패. build 통과가 아닙니다.
- `git diff --check`: 통과.

## 남은 1차 필수

출시 완료 PR이 아닙니다. 디자인이 DRAFT이므로 이벤트 UI/OBS 공개표시/구매자 참여 UI는 미구현이며 FINAL 디자인 구현·렌더 증거가 필요합니다. 직접입력·붙여넣기·QR/Cafe/guest 참가 모드, 명단 편집/마감 UX, 경품 참조와 수동 처리/배송 정보/쿠폰·포인트 연동, COMMERCE 지급 계획 및 플랜 상품화는 후속 필수입니다. 사다리 outcome slot의 경품 있음/없음 및 기존 경품 참조 계약이 없어 라벨에서 당첨 여부나 이전 당첨자 제외를 추론하지 않았습니다. 해당 명시 계약과 결과와 분리된 지급 state·수동 관리가 필요합니다. 시험 모드에서는 실제 경품·쿠폰·적립금·배송을 생성하지 않습니다.

공식 generated client 생성 뒤 actorId 신규2칸의 memberData shared inventory도 반영·검증해야 합니다(담당 scope 확인 중). 공식 generated client·서비스/API 통합·typecheck·build 및 공용 inventory가 통과하기 전 병합/배포 판단을 할 수 없습니다. GitHub API 네트워크 CONNECT403이 지속되면 PR 등록 및 CI 조회도 차단 상태로 기록합니다.
