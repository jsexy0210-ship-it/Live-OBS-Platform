# 외부 쇼핑몰 연동 서버 기반 (SA-005·006, 오버레이 전용 파트너스)

코드: `lib/server/external/**`, `app/api/seller/external-shops/**`, `app/api/external/webhook`, 스키마 「외부 쇼핑몰 연동」 블록(마이그레이션 `20261005081000_external_shop`). 2026-10-05 KST, MASTER 승인(월 1만 원 이내·키 없으면 꺼짐).

## 이 단계에서 하는 것 / 아닌 것
- 한다: 연결 시작(1회용·만료 state, 시작한 파트너스·직원 세션에 묶음) · OAuth 콜백 · 토큰 암호화 저장(AES-256-GCM, 파트너스 id 묶음) · 해제(쇼핑몰 쪽 철회, 실패하면 「해제 대기」) · 웹훅 수신(서명 검증 후 원본 저장, 같은 본문 한 번만) · 권한(대표자·쇼핑몰 설정 직원, 요금제 「외부 연동」) · 연결 중인 쇼핑몰의 중복 연결 차단.
- 아직 안 한다(다음 PR): 웹훅 이벤트 → 외부 주문 저장·주문대기·오버레이 표시, 토큰 갱신·누락 보정 조회(호출 한도 10분 3,000건의 70% 안전선, `CALL_SAFETY_RATIO`), 해제 대기 철회 재시도, 웹훅 원본 보관 기간 삭제(30일, 대표님 확인 대기), 화면 SA-005·006.

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
