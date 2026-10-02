# 망고TCG 참조 저장소 구조 분석

> 분석일: 2026-10-02 (KST)
> 대상: `jsexy0210-ship-it/obs-order-queue-cafe24-webhook` @ `7616fab` (2026-10-02 14:34 KST)
> 방식: 읽기 전용 shallow clone. 원본 수정·운영 접근 없음. 비밀값 미열람(`.env.local.example`은 키 이름만 확인).

## 1. 요약

- Next.js(App Router) + better-sqlite3 단일 서버 앱. 파일 111개, `lib/` 약 4,000줄.
- **단일 판매자(망고TCG) 전용**: 카페24 쇼핑몰 1개(`CAFE24_MALL_ID` env), 관리자 계정 2개(env), DB 1개(`data/cardbreak.db`).
- 주문 원천은 **카페24 웹훅**. 자체 쇼핑몰·상품·재고·PG 기능 없음.
- 실시간 갱신은 **프로세스 내 EventEmitter + SSE**. 단일 인스턴스 전제.
- 주문자 알림(알림톡·SMS) 기능 **없음**.

## 2. 디렉터리 구조

| 경로 | 역할 |
|---|---|
| `app/overlay*`, `app/preview-*` | OBS Browser Source 오버레이 (기본·세로·카드브레이크·쇼츠) 및 미리보기 |
| `app/admin/` | 관리자 대시보드: 주문 대기열 조작, HIT 카드 등록, 랭킹, 적립금 설정·원장 |
| `app/order-history/` | 주문 이력 조회 |
| `app/api/webhooks/cafe24` | 카페24 주문 웹훅 수신 (토큰 검증, 이벤트별 URL) |
| `app/api/cafe24/oauth/*` | 카페24 OAuth 연동 (토큰 AES-256-GCM 암호화 저장) |
| `app/api/stream`, `overlay-stream` | SSE 실시간 스트림 (관리자용 / 오버레이용) |
| `app/api/orders`, `hit-cards`, `overlay-*` | 대기열·HIT·오버레이 설정 CRUD |
| `app/api/reward-*`, `order-ranking` | 적립금·랭킹 보너스 |
| `app/api/internal/cafe24-reconcile` | 웹훅 누락 보정(정기 대조) |
| `lib/` | 도메인 로직 (아래 3절) |
| `proxy.ts` | 경로 접근 제어 (Next 16 middleware) |
| `scripts/` | 배포·복구·보정·백필 스크립트, 테스트 2개 |
| `.github/workflows/` | `main.yml`(CI), `deploy-remote.yml`, `deploy-self-hosted.yml`(main push 배포) |

## 3. 핵심 모듈

| 모듈 | 내용 | 신규 플랫폼 재사용 판단 |
|---|---|---|
| `lib/db.ts` | SQLite 스키마·마이그레이션 | 스키마 설계 참조만. 멀티테넌트 DB로 재설계 필요 |
| `lib/store.ts` | 주문 대기열 상태 전이 `waiting → opening → done / cancelled`, 타이머, HIT 카드, 이력 | **핵심 참조.** 상태 모델·함수 구조 재사용, `seller_id` 범위 추가 필요 |
| `lib/events.ts` | 전역 EventEmitter `update` 방송 | 개념 재사용. 다중 인스턴스 시 Redis Pub/Sub 등으로 교체 필요 |
| `app/api/stream` | SSE + 25초 ping | 그대로 재사용 가능 (판매자별 채널 분리 필요) |
| `lib/liveOverlayPrivacy.ts` | 오버레이 노출 시 회원ID 제거·닉네임 정리 | **그대로 재사용 권장** (개인정보 보호) |
| `lib/overlaySettings.ts` | 오버레이 표시 설정 (단일 행 JSON) | 판매자별 설정으로 확장 |
| `lib/orderRanking.ts` | 구매 랭킹 집계 | 선택 기능으로 재사용 |
| `lib/cafe24*.ts` | 카페24 주문 정규화·OAuth·관리 API·보정 | 신규 플랫폼은 자체 쇼핑몰이므로 **기본 범위 제외**. 외부몰 연동 옵션으로 보류 |
| `lib/reward*.ts` | 등급별 적립률 설정, 결제 시 지급·취소 시 회수, 원장(pending/succeeded/failed), 실지급 플래그(기본 false), 지급 시작 시각 | **재사용.** 계산·원장·실행 스위치 구조를 판매자별로 이식. 카페24 API 호출부는 자체 적립금 저장소로 교체 |
| `lib/adminAuth.ts`, `proxy.ts` | env 고정 2계정, SHA-256 쿠키 토큰 | **재사용 불가.** 판매자 회원·세션 인증으로 교체 필요 |
| `lib/buyerNames.ts` | 구매자 표시명 해석 | 참조 |

## 4. 데이터 모델 (요약)

- `orders`: 주문 1건 = 대기열 1항목. `source`(cafe24/manual), `external_order_id`(중복 방지), `status`, `timer_seconds`, `paid_at`, 결제수단·PG명, `youtube_nickname`
- `hit_cards`: HIT 카드 기록 (user_id, card, 닉네임)
- `overlay_settings`, `reward_settings`: 단일 행 JSON 설정
- `reward_ledger`, `ranking_bonus_ledger`: 적립금 원장
- `cafe24_oauth_tokens`, `cafe24_reconciliation_runs`, `cafe24_member_point_balance_snapshots`, `hidden_order_history`

모든 테이블에 판매자 구분 컬럼이 없다.

## 5. 신규 플랫폼 기능 대비

| 제품 범위 | 망고TCG 보유 | 비고 |
|---|---|---|
| 판매자별 쇼핑몰 | 없음 | 신규 개발 |
| 상품·이미지·재고 | 없음 (카페24 썸네일 조회만) | 신규 개발, 이미지 저장소 필요 |
| 주문 관리 | 부분 (카페24 웹훅 주문 수신·취소·환불 반영) | 자체 주문 생성으로 전환 |
| 판매자 명의 PG | 없음 (카페24 결제 정보만 기록) | 신규 개발 |
| 방송 대기열 | **있음** | 핵심 재사용 대상 |
| 오버레이 | **있음** (4종) | 재사용, 판매자별 URL·토큰 필요 |
| HIT | **있음** | 재사용 |
| 적립금 | **있음** (카페24 적립금 API 경유) | 판매자별 적립금으로 재설계 |
| 주문자 알림 | 없음 | 신규 개발 |
| 구독 결제·요금제 | 없음 | 신규 개발 |

## 6. 이식 시 주의

- **멀티테넌트화**: 모든 데이터·SSE 채널·오버레이 URL에 판매자 범위 필요. 오버레이 공개 경로(`/overlay-*`, `/api/overlay-*`)는 판매자별 추측 불가 토큰으로 보호해야 함.
- **SQLite → 서버 DB**: 다중 판매자·다중 인스턴스 운영에는 PostgreSQL 등 검토.
- **의존성 `latest` 고정**: 원본은 `next`, `react` 등이 `latest`. 신규 플랫폼은 버전 고정 유지.
- **운영 데이터·비밀값 복사 금지**: `data/` DB, `.env.local`, 카페24 토큰은 가져오지 않음 (저장소에도 커밋돼 있지 않음 확인).
- **배포 워크플로 복사 금지**: 원본의 main push 자동 배포 워크플로는 망고TCG 운영 서버 대상이다.
- **테스트**: 원본 테스트는 `scripts/*.test.mjs` 2개(적립금 계산·카페24 주문 정규화)뿐이다. 적립금 계산 테스트는 이식 시 함께 옮기고, 대기열 로직 테스트는 새로 작성한다.

## 7. 권장 이식 순서 (제안)

1. 대기열 도메인(`store.ts`의 상태 전이·타이머·HIT)을 판매자 범위로 재설계, 단위 테스트 작성
2. SSE 스트림 + 오버레이 1종(기본형) 이식, 개인정보 마스킹 포함
3. 판매자 인증 도입 후 관리자 대기열 화면 이식
4. 상품·재고·주문 → PG → 판매자별 적립금 → 알림 순으로 신규 개발
