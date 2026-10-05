# 외부 쇼핑몰 연동 서버 기반 (SA-005·006, 오버레이 전용 파트너스)

코드: `lib/server/external/**`, `app/api/seller/external-shops/**`(OAuth 복귀 경로는 `…/oauth-done`: 점검 중 「callback」 이름 경로는 막지 않는다는 규칙 때문에 이름을 피했다. 이 경로는 파트너스 세션 화면 흐름이라 점검 중에는 막힌다), `app/api/external/webhook`, 스키마 「외부 쇼핑몰 연동」 블록(마이그레이션 `20261005081000_external_shop`). 2026-10-05 KST, MASTER 승인(월 1만 원 이내·키 없으면 꺼짐).

## 이 단계에서 하는 것 / 아닌 것
- 한다: 연결 시작(1회용·만료 state, 시작한 파트너스·직원 세션에 묶음) · OAuth 콜백 · 토큰 암호화 저장(AES-256-GCM, 파트너스 id 묶음) · 해제(쇼핑몰 쪽 철회, 실패하면 「해제 대기」) · 웹훅 수신(서명 검증 후 원본 저장, 같은 본문 한 번만) · 권한(대표자·쇼핑몰 설정 직원, 요금제 「외부 연동」) · 연결 중인 쇼핑몰의 중복 연결 차단.
- 정기 작업(`lib/server/jobs/scheduler.ts`, `external/jobs.ts`): 끝난 OAuth state 삭제(만료 1일 뒤), 웹훅 원본 30일 삭제(`WEBHOOK_RETENTION_DAYS`, 대표님 확인 대기 값), 토큰 갱신(갱신 토큰이 3일 안에 만료되거나 접근 토큰이 만료된 연결, 400·401이면 「다시 연결 필요」, 5xx·시간 초과는 다음에 다시, 잠긴 파트너스·연동 키 없음이면 호출 0건).
- 외부 주문 저장·주문대기 연결(`external/orders.ts`, 마이그레이션 `20261005110000_external_order`): `ExternalOrder`(외부 주문번호·방송 표시 이름·취소 시각만, 가짜 회원·상품 행 없음)와 `QueueItem`의 외부 참조(`externalOrderId`·`externalLineNo`). 대기열 항목은 내부 주문(`orderId`·`orderItemId`) 또는 외부 주문 중 정확히 한쪽만 채운다(DB CHECK `QueueItem_source_check`). `storeExternalOrder`(같은 연결의 같은 외부 주문번호는 한 번만, 연결됨 상태만, 입력 검증, 내부 주문과 같은 줄 순번·방송), `cancelExternalOrder`(대기 항목만 취소). 개봉 시작·완료·취소·타이머, 오버레이 주문 알림(「처음」 표시), HIT 카드가 외부 항목에서도 돈다. 재고·결제·적립금·배송은 이 쪽에서 다루지 않는다.
  - 화면 계약(방송 화면 전담용): 대기열 항목 응답에서 외부 주문 항목은 `orderId`·`orderItemId`가 null, `externalOrderId`·`externalLineNo`가 채워진다. HIT 카드 응답의 `order`는 외부 주문에서 나온 카드면 null. 출처 배지·주문 링크 처리는 화면 쪽 몫.
  - 출처 필드(후속 PR): 큐 스냅샷(`GET /api/seller/queue`)의 모든 항목, HIT 카드 응답, 방송 상세(SA-055)의 HIT에 `source: "INTERNAL" | "EXTERNAL"`(HIT는 직접 입력 카드면 null)과 `externalShopName`(지금은 몰 ID, 별칭 없음)이 붙는다. 방송 상세에는 내부 주문 목록과 별도로 `externalOrders`(그 방송 시간에 들어온 외부 주문: 닉네임·상품·수량·상태·취소 시각·완료 시각, 금액·결제 정보 없음, 최대 200건)가 있다. 개봉 시작·완료 같은 큐 동작의 응답 행에는 `source`가 없다(화면은 스냅샷을 다시 읽는다).
  - 실시간 version은 실제로 저장·취소가 일어났을 때만 올린다(중복·비활성 연결·잘못된 입력은 올리지 않음).
- 아직 안 한다(다음 PR): 웹훅 이벤트 본문 → `NormalizedExternalOrder` 변환(파서, 공식 이벤트 형식 확인 필요)과 취소·환불 이벤트 연결, 외부 주문 원본 보관 기간 삭제·주문대기·오버레이 표시(공식 이벤트 본문 형식 확인 필요, 주문대기 모델이 내부 주문 참조를 필수로 가져 모델 결정 필요), 누락 보정 조회(호출 한도 10분 3,000건의 70% 안전선, `CALL_SAFETY_RATIO`), 해제 대기 철회 재시도, 화면 SA-005·006.

## 설정(환경변수, 값은 저장소·문서에 적지 않는다)
`EXTERNAL_SHOP_CLIENT_ID`, `EXTERNAL_SHOP_CLIENT_SECRET`, `EXTERNAL_SHOP_REDIRECT_URI`(https 필수), 선택 `EXTERNAL_SHOP_SCOPES`, `EXTERNAL_WEBHOOK_SIGNATURE_HEADER`. 하나라도 없으면 연동 전체가 꺼진다: 목록 `enabled:false`, 연결 시작 503, 웹훅 503. 토큰 암호화는 기존 `BILLING_KEY_SECRET`을 쓴다.

## 미검증 (공식 문서 직접 확인 전, 이 세션은 developers.cafe24.com 접속이 막혀 있었음)
다음은 기억·공개 요약에 기대 쓴 값이라, 연결 키를 넣기 전에 반드시 공식 문서와 대조한다. 틀려도 안전하게 실패하도록 만들었다(서명이 틀리면 전부 401, 엔드포인트가 틀리면 연결이 안 됨).
1. OAuth 엔드포인트 경로(`/api/v2/oauth/authorize`·`token`·`revoke`)와 토큰 응답 필드 이름(`expires_at`·`refresh_token_expires_at`·`scopes`).
2. 주문 읽기 scope 이름(기본값 `mall.read_order`, 환경변수로 바꿈).
3. 웹훅 서명: 헤더 이름(기본 `x-cafe24-hmac-sha256`)과 계산식(앱 비밀값으로 본문 HMAC-SHA256, base64). 웹훅은 앱 단위 주소 하나라 본문의 몰 id(`resource.mall_id`)로 연결을 찾는다.
4. 앱 심사·공개 요건·수수료.
확인된 것(MASTER): Admin API 호출 한도는 쇼핑몰당 10분 3,000건(넘으면 429), 웹훅 이벤트는 개발자센터 앱 설정에서 등록.

## 보안 요약
- 판매자가 낸 주소는 접속에 쓰지 않는다. 지원 도메인(`<몰 id>.cafe24.com`·`cafe24shop.com`)에서 몰 id만 뽑아 검증된 값으로 호스트를 만든다(IP·localhost·http·포트·사용자 정의 도메인 거절).
- 콜백은 다른 파트너스·다른 직원·이미 쓴·만료된·없는 state를 모두 거절하고, 맞는 state만 토큰 교환 전에 태운다. 남의 state를 쓰려다 실패해도 원래 state는 태워지지 않는다.
- 응답·오류·로그에 토큰·코드·플랫폼 이름을 싣지 않는다(응답은 중립 문구, 감사 기록에 토큰 없음).
