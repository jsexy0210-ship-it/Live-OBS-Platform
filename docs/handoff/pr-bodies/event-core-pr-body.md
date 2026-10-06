현재 YouTube 채팅은 주문 닉네임 표시만 지원하며 방송 이벤트 참가·동결·추첨 결과를 보존하지 않습니다. 이 변경은 파트너스의 진행 중인 방송과 활성 YouTube 채팅에 묶인 RANDOM_DRAW 서버 흐름을 추가합니다. ONQ 1.0 전체 기능 완료 PR이 아닙니다. 검증 차단 사항이 남아 있으므로 초안 검수 대상입니다.

## 고친 것

- 공통 유형 ROULETTE_ITEM / ROULETTE_PARTICIPANT / LADDER / RANDOM_DRAW와 Event·Entrant·Round·Result 모델을 추가했습니다. 미구현 유형은 `409 not_ready`로 막았습니다.
- 지정 키워드를 채팅 원문에 `trim()`을 적용한 전체 문자열과 정확히 비교했습니다. 원문은 수집 메모리에서만 쓰고 기존 채팅 본문 앞 200자 저장을 유지했습니다. keyword는 관리 설정값으로 이벤트와 동결 규칙에 저장했습니다.
- 안정적인 YouTube author channel ID와 message ID로 중복 참가를 막았습니다. 표시 이름은 식별자로 쓰지 않았습니다. 안정 ID 누락은 참가시키지 않고 최소 진단과 멱등 집계를 남겼습니다. 구독자 조회·추정 API를 사용하지 않았습니다.
- 판매자 행 잠금으로 생성·채팅 참가·동결·추첨의 동시 실행을 직렬화했습니다. 생성 요청키 충돌을 확인하고 재시도는 저장된 회차·결과를 반환합니다. 결과는 서버의 crypto.randomInt로 중복 없이 결정했습니다.
- 동결 회차와 결과를 append-only SQL trigger로 보호하고, snapshot 참가자·규칙 일치, 결과의 당첨자 범위·중복·시험 모드를 DB에서도 검사했습니다.
- OVERLAY / BROADCAST_RUN, 판매자·방송·채팅 격리, 구독·정지 검사, 본문 8KiB, 시간·참가자·방송별 이벤트·변경 요청 한도를 적용했습니다. 기존 Origin 검사를 유지했습니다.
- 진행자는 시작 전에 방송에서 키워드·참가 조건·마감·규칙을 안내했음을 확인해야 합니다. 이는 진행자의 고지 확인이며 참가자 개인정보 동의가 아닙니다. 서버 고지 계약을 추가했고 실제 참가자 화면은 만들지 않았습니다.
- 시험과 실제 모드 모두 보상 지급 연결을 제공하지 않습니다. 회원·주문·경품 지급 원장을 복제하지 않았고 쿠폰·적립금·배송을 생성하지 않습니다. 가격·PG·공통 UI·ladder.ts는 변경하지 않았습니다.

## 실제 검사

- `npx vitest run tests/unit/broadcastEventCore.test.ts tests/unit/youtube.test.ts`: **19/19 통과**.
- 최신 main의 전체 SQL migration과 `20261006300000_audience_event_core`를 별도 폐기용 PostgreSQL DB에 pg로 적용: **성공**. Prisma migrate 실행 성공으로 표현하지 않습니다.
- `npx vitest run tests/integration/broadcastEventCoreSql.test.ts --no-file-parallelism`: **9/9 통과**. 채널 중복, 동결 뒤 참가, 회차 수정·삭제, 결과 수정, 외부/중복 당첨자·시험 모드 변경, 판매자 composite FK를 실제 PostgreSQL로 확인했습니다. 서비스/API 통합 시험을 대신하지 않습니다.
- `npm test`: **501 통과 / 1 실패**. 유일한 실패는 공용 `tests/unit/planFeatures.test.ts`의 신규 event API 경로 3행 미등록입니다. 열린 #1000이 같은 파일을 소유하므로 MASTER 지시에 따라 동시 수정·skip하지 않았습니다. #1000 병합 뒤 자기 행을 순차 추가해야 합니다.
- `npm run typecheck`: **실패**. Prisma 새 모델 타입 생성이 차단되어 AudienceEvent 타입·delegate가 없어 연쇄 타입 오류가 남았습니다. 임시 타입·검사 우회를 만들지 않았습니다.
- `npm run build`: **실패**. 애플리케이션 컴파일 뒤 TypeScript 검사에서 위 신규 모델 타입 누락으로 실패했습니다. 빌드 성공으로 보고하지 않습니다.
- `prisma generate` / `prisma validate` / `prisma migrate diff`: Prisma native engine/checksum 다운로드가 `binaries.prisma.sh`에서 **403**으로 차단됐습니다. 임시 wasm generator·checksum 우회를 적용하지 않았습니다. Prisma schema-to-DB diff 검증은 미완료입니다.
- Prisma 서비스/API 통합 시험 12건을 작성했습니다. 실행은 기존 복사된 client가 PostgreSQL URL 대신 `prisma://` protocol을 요구하는 환경 오류로 fixture 단계에서 **차단**됐습니다. 통과로 보고하지 않습니다.
- 로컬 `npm ci`: 기존 lockfile의 sharp 플랫폼 optional entries 누락으로 **실패**했습니다. package/lock은 소유 범위 밖이라 수정하지 않았고 기존 의존성을 독립 복사해 검사했습니다.
- `git diff --check`: 통과. 최신 origin/main `4a06ba9016dae9784774329c1e253ecc92b0c9d3` 병합 확인. `git merge-tree --write-tree HEAD origin/pr/1000`, `origin/pr/1006`: 충돌 없음. 신규 migration 번호/이름은 해당 알려진 refs와 겹치지 않습니다.

## 못 고친 것·판단 필요

- Prisma 엔진 정상 접근과 새 client 생성 뒤 typecheck/build, 서비스/API 통합 시험, schema-to-DB diff 및 전체 CI 재검사가 필요합니다.
- #1000 공용 경로 목록 변경 병합 뒤 event API 3행을 순차 반영해야 합니다. 전체 시험이 green인 상태가 아닙니다.
- roulette item/participant adapter, ladder adapter, 모든 이벤트 UI/OBS overlay와 디자인 정본, Cafe 연동, guest 참가, 공개 참가자 고지 화면, 이벤트 참가자·진단·결과 보관/비식별 정책은 후속입니다.
- COMMERCE 경품 상품·쿠폰·적립금·배송 지급 연결과 플랜 표시/사용량 정책은 후속이며 기존 상품·서비스를 사용해야 합니다. 현재 실제 경품 지급 기능은 없습니다.
- GitHub API 403 때문에 전체 open PR 목록/CI 상태 확인은 미완료입니다. 로컬에 알려진 refs만 대조했습니다. 정상 push/PR도 실패하면 인증/권한 차단으로 보고하고 우회하지 않습니다.

검수 대상 head: `7f914b85501f281319b2d710ecaa044916575931`. main 직접 push·병합·배포는 실행하지 않았습니다.
