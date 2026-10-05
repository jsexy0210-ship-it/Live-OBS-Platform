# 외부 쇼핑몰 연동 서버 기반 (SA-005·006, 오버레이 전용 파트너스)

코드: `lib/server/external/**`, `app/api/seller/external-shops/**`(OAuth 복귀 경로는 `…/oauth-done`: 점검 중 「callback」 이름 경로는 막지 않는다는 규칙 때문에 이름을 피했다. 이 경로는 파트너스 세션 화면 흐름이라 점검 중에는 막힌다), `app/api/external/webhook`, 스키마 「외부 쇼핑몰 연동」 블록(마이그레이션 `20261005081000_external_shop`). 2026-10-05 KST, MASTER 승인(월 1만 원 이내·키 없으면 꺼짐).

## 이 단계에서 하는 것 / 아닌 것
- 한다: 연결 시작(1회용·만료 state, 시작한 파트너스·직원 세션에 묶음) · OAuth 콜백 · 토큰 암호화 저장(AES-256-GCM, 파트너스 id 묶음) · 해제(쇼핑몰 쪽 철회, 실패하면 「해제 대기」) · 웹훅 수신(서명 검증 후 원본 저장, 같은 본문 한 번만) · 권한(대표자·쇼핑몰 설정 직원, 요금제 「외부 연동」) · 연결 중인 쇼핑몰의 중복 연결 차단.
- 정기 작업(`lib/server/jobs/scheduler.ts`, `external/jobs.ts`): 끝난 OAuth state 삭제(만료 1일 뒤), 웹훅 원본 30일 삭제(`WEBHOOK_RETENTION_DAYS`, 대표님 확인 대기 값), 토큰 갱신(갱신 토큰이 3일 안에 만료되거나 접근 토큰이 만료된 연결, 400·401이면 「다시 연결 필요」, 5xx·시간 초과는 다음에 다시, 잠긴 파트너스·연동 키 없음이면 호출 0건).
- 외부 주문 저장·주문대기 연결(`external/orders.ts`, 마이그레이션 `20261005110000_external_order`): `ExternalOrder`(외부 주문번호·방송 표시 이름·취소 시각만, 가짜 회원·상품 행 없음)와 `QueueItem`의 외부 참조(`externalOrderId`·`externalLineNo`). 대기열 항목은 내부 주문(`orderId`·`orderItemId`) 또는 외부 주문 중 정확히 한쪽만 채운다(DB CHECK `QueueItem_source_check`). `storeExternalOrder`(같은 연결의 같은 외부 주문번호는 한 번만, 연결됨 상태만, 입력 검증, 내부 주문과 같은 줄 순번·방송), `cancelExternalOrder`(대기 항목만 취소). 개봉 시작·완료·취소·타이머, 오버레이 주문 알림(「처음」 표시), HIT 카드가 외부 항목에서도 돈다. 재고·결제·적립금·배송은 이 쪽에서 다루지 않는다.
  - 화면 계약(방송 화면 전담용): 대기열 항목 응답에서 외부 주문 항목은 `orderId`·`orderItemId`가 null, `externalOrderId`·`externalLineNo`가 채워진다. HIT 카드 응답의 `order`는 외부 주문에서 나온 카드면 null. 출처 배지·주문 링크 처리는 화면 쪽 몫.
  - 출처 필드(후속 PR): 큐 스냅샷(`GET /api/seller/queue`)의 모든 항목, HIT 카드 응답, 방송 상세(SA-055)의 HIT에 `source: "INTERNAL" | "EXTERNAL"`(HIT는 직접 입력 카드면 null)과 `externalShopName`(지금은 몰 ID, 별칭 없음)이 붙는다. 방송 상세에는 내부 주문 목록과 별도로 `externalOrders`(그 방송 시간에 들어온 외부 주문: 닉네임·상품·수량·상태·취소 시각·완료 시각, 금액·결제 정보 없음, 최대 200건)가 있다. 개봉 시작·완료 같은 큐 동작의 응답 행에는 `source`가 없다(화면은 스냅샷을 다시 읽는다).
  - 금액: 큐 스냅샷(`GET /api/seller/queue`) 항목에 `amount: number | null`(원)이 붙는다. 내부 주문 항목은 주문 때 단가(이벤트 할인 반영) × 항목 수량, 외부 주문 항목은 외부 금액을 저장하지 않아 null이다(외부 금액을 보이려면 `ExternalOrder`에 금액 컬럼과 주문 조회 응답 연동이 필요 — 별도 판단).
  - 실시간 version은 실제로 저장·취소가 일어났을 때만 올린다(중복·비활성 연결·잘못된 입력은 올리지 않음).
- 웹훅 응답 규칙: 인증키(X-API-Key) 불일치 401·연동 설정 없음 503·본문 초과 413·깨진 본문 400, 그 밖에 인증을 통과한 요청은 연결 안 된 몰·처리 대상이 아닌 이벤트라도 200(저장 안 함). 쇼핑몰은 2xx가 아니면 실패로 세고 실패율이 높으면 수신을 자동으로 끄며, 개발자센터 WebHook TEST 샘플은 연결 안 된 몰 ID로 오기 때문이다.
- 웹훅 이벤트 처리(`external/process.ts`, 수신 직후 응답 뒤 `after()`로 최대 20건 + 정기 작업 `external_webhook_event.process`가 못 한 것을 처리): 접수 90023(입금 전 `paid:"F"`는 조회 없이 닫음)·입금 90025는 주문 조회 API(`embed=items,buyer`)로 결제 완료·취소 아님·품목 있음을 확인한 주문만 `storeExternalOrder`로 주문대기에 올린다(품목 줄 = 상품명 + 옵션, 수량). 취소 90026·90072, 환불 90029·90073은 조회 결과 주문 전체가 취소(`canceled`)일 때만 `cancelExternalOrder`(부분 취소는 줄 단위 상태가 문서에서 확인되지 않아 건드리지 않음). 일괄 이벤트(`order_id` 쉼표 목록, 최대 50)는 각각 처리. 구매자 이름은 첫·끝 글자만 남기고 가려 방송 닉네임으로 쓴다(`maskBuyerName`). 일시 오류(429·5xx·시간 초과·토큰 갱신 실패)는 처리됨으로 표시하지 않고 다시 하며, 조회가 401이면 토큰을 바로 새로 받는다(갱신까지 무효면 「다시 연결 필요」). 주문 없음·형식 틀림·해제된 연결·결제 유예 만료는 처리됨으로 닫는다. 토큰 갱신은 연결별 잠금(`refreshConnection`)으로 정기 작업과 동시에 돌지 않게 했다(갱신 토큰은 한 번 쓰면 폐기).
- 아직 안 한다(다음 PR): 누락 보정 조회(웹훅 로그 조회 API `GET /webhooks/logs`로 빠진 이벤트 찾기, 호출 한도의 70% 안전선 `CALL_SAFETY_RATIO` — 지금은 한 번에 처리하는 건수(수신 직후 20·정기 50)로만 제한), 줄 단위 부분 취소, 해제 대기 철회 재시도(철회 경로 미확인), 외부 주문 원본 보관 기간 삭제, 화면 SA-005.

## 설정(환경변수, 값은 저장소·문서에 적지 않는다)
`EXTERNAL_SHOP_CLIENT_ID`, `EXTERNAL_SHOP_CLIENT_SECRET`, `EXTERNAL_SHOP_REDIRECT_URI`(https 필수), 선택 `EXTERNAL_SHOP_SCOPES`, 웹훅용 `EXTERNAL_WEBHOOK_API_KEY`(개발자센터 WebHook 인증정보). 앞 세 개가 하나라도 없으면 연동 전체가 꺼지고(목록 `enabled:false`, 연결 시작 503, 웹훅 503), 웹훅 인증키만 없으면 웹훅만 503이다. 토큰 암호화는 기존 `BILLING_KEY_SECRET`을 쓴다.

## 공식 문서 대조 결과 (2026-10-05 KST, developers.cafe24.com 직접 확인)
근거: `/app/front/app/develop/oauth/oauthcode`·`oauth/token`·`oauth/retoken`·`webhook/manage`·`webhook/sample`·`api/scope`.
- 일치: OAuth 인증 주소 `https://{mall_id}.cafe24api.com/api/v2/oauth/authorize`(response_type=code, client_id, state, redirect_uri, scope — 공백 또는 콤마 구분), 토큰 `POST …/api/v2/oauth/token`(Basic 인증, authorization_code·refresh_token), 응답 필드(`access_token`·`expires_at`·`refresh_token`·`refresh_token_expires_at`·`mall_id`·`scopes`). 인증 코드 1분, 접근 토큰 2시간, 갱신 토큰 14일·한 번 쓰면 폐기, 토큰 발급 2시간 15회 제한. 주문 조회 scope는 `mall.read_order`.
- 다름(수정함): 웹훅 인증은 HMAC 서명이 아니라 개발자센터 「WebHook 인증정보」가 `X-API-Key` 헤더로 그대로 온다(`X-Trace-ID`도 옴). 앱 비밀값과는 다른 값이라 환경변수 `EXTERNAL_WEBHOOK_API_KEY`로 받는다.
- 웹훅 본문: `{event_no, resource:{mall_id, event_shop_no, event_code, order_id, order_date, paid, payment_date, buyer_name, member_id, ordering_product_name(쉼표 구분), …}}`. 주문 접수 90023, 입금 90025, 취소 90026(일괄 90072), 환불 90029(일괄 90073), 삭제 90070. 이벤트에는 품목별 줄·수량이 없고 주문 머리 정보뿐이며, 일괄 이벤트는 `order_id`가 쉼표로 이어진 목록이다. 줄 단위 정보는 주문 조회 API로 받아야 한다.
- 공식 권고: 웹훅은 일부 누락될 수 있어 웹훅 로그 조회 API로 보정하며, 1주일간 실패 100건 초과·성공률 10% 미만이면 수신이 자동 꺼진다(개발자센터에서 다시 켬). 발신 IP 7개·443 포트 안내가 있다.
- 주문 조회 API 확인(2026-10-05 KST, `apidocs.cafe24.com/docs/admin/get-orders-by-order-id`·`get-orders`·`get-orders-by-order-id-items`·`get-webhooks-logs`): 호스트 `https://{mall_id}.cafe24api.com/api/v2/admin`. 주문 상세 `GET /orders/{order_id}?embed=items,buyer`, 목록 `GET /orders?start_date&end_date&date_type&order_status&embed=items&limit&offset`(한 번에 3개월 이내), 품목 `GET /orders/{order_id}/items`. 모두 scope `mall.read_order`. 품목 필드: `order_item_code`·`item_no`·`product_no`·`product_name`·`option_value`·`quantity`·`order_status`·`status_text`·`claim_quantity`. 주문 머리: `order_id`·`order_date`·`payment_date`·`paid`·`canceled`·`cancel_date`·`billing_name`·`member_id`·`order_place_id`. 웹훅 로그 `GET /webhooks/logs?since_log_id&event_no&success&limit`(scope `mall.read_application`, 로그에 `log_id`·`event_no`·`trace_id`·`request_body`). 문서 표기상 호출 한도 값은 `x-rate-limit 40`·`x-request-limit 100`(쇼핑몰별 10분 3,000건과 다른 표기라 단위 확인 전까지 낮은 쪽인 70% 안전선을 그대로 쓴다).
- 아직 미검증: 토큰 철회(revoke) 경로(개발자센터 OAuth 문서 목록에 철회 절차가 없다 → 현재 철회 호출은 실제로는 효과가 없을 수 있어, 해제하면 토큰은 우리 쪽에서 지우고 쇼핑몰 쪽 토큰은 자연 만료를 기다린다고 본다), 앱 심사·수수료.

## 보안 요약
- 판매자가 낸 주소는 접속에 쓰지 않는다. 지원 도메인(`<몰 id>.cafe24.com`·`cafe24shop.com`)에서 몰 id만 뽑아 검증된 값으로 호스트를 만든다(IP·localhost·http·포트·사용자 정의 도메인 거절).
- 콜백은 다른 파트너스·다른 직원·이미 쓴·만료된·없는 state를 모두 거절하고, 맞는 state만 토큰 교환 전에 태운다. 남의 state를 쓰려다 실패해도 원래 state는 태워지지 않는다.
- 응답·오류·로그에 토큰·코드·플랫폼 이름을 싣지 않는다(응답은 중립 문구, 감사 기록에 토큰 없음).
