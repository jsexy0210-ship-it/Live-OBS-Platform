# 결제 연계 점검표 (구매자·마스터 화면)

> 작성: 2026-10-06 (KST) · 개발 전담(기반-결제) · 기준: main 코드의 화면 → 서버 API 호출 연결. 파트너스 화면은 이전 점검에서 끝남.
> 방법: 화면 컴포넌트가 해당 서버 API를 실제로 부르는지 코드로 대조했습니다. **렌더링·실결제 확인은 하지 않았습니다**(실제 결제창은 대표님 결제 필요). ✓ = 호출 연결됨, △ = 판단 필요, ✗ = 화면에서 부르는 곳 없음.

## 구매자 쇼핑몰

| 화면 | 서버 API | 상태 | 비고 |
|---|---|---|---|
| 주문서(체크아웃) | `POST /api/shop/{slug}/orders/quote`, 주문 생성 | ✓ | 금액은 서버가 다시 계산 |
| 결제(OrderPay) | `POST /payments`(나이스페이 결제창), `/payments/bank-transfer`, 결과 `/api/payments/nicepay/return` | ✓ | 결제창 승인·웹훅·대사 서버 완료 |
| SH-021 주문 내역 | `GET /orders`(탭·기간·counts·사진·queue) | ✓ | 서버 기본 기간 3개월(이번 변경, MASTER 결정) |
| SH-022 주문 상세 | `GET /orders/{id}`(paymentInfo 카드 요약·현금영수증 상태·배송지·받는 방법) | ✓ | 카드 매출전표 안내 문구 표시 |
| 취소·환불 요청 | `refund-requests`, 취소 | ✓ | RefundRequestSection |
| SH-022-R 교환·반품 | `returns` | ✓ | ReturnSection |
| 배송비 미리보기 | `GET /payments/shipping-preview` | △ | 화면 호출 없음. 체크아웃은 `orders/quote`가 배송비를 줘서 쓸모가 겹침 → 화면-쇼핑몰이 quote로 충분한지 확인 후 API 삭제 또는 연결 결정 |
| 현금영수증·세금계산서 신청(구매자) | `/receipt-requests`, `/receipt-requests/{id}` | ✗ | 구매자 화면에서 신청하는 곳 없음(SH-022는 신청 상태 표시만). 정본에 신청 UI가 있는지 SH-022 보드 확인 필요 → 없으면 서버 API만 남은 상태로 MASTER 판단 |

## 마스터 관리자

| 화면 | 서버 API | 상태 | 비고 |
|---|---|---|---|
| MA-024 청구·결제 내역 | `/api/admin/billing/invoices`(+export·retry), `/api/admin/payments/{id}` | ✓ | |
| MA-026 환불 요청 목록 | `/api/admin/subscription-refunds`(+`/{id}`) | ✓ | |
| MA-031 PG 연결 상태 | `/api/admin/pg-status` | ✓ | |
| MA-032 구독료 수납 현황 | `/api/admin/subscription-billing` | ✓ | |

## 이번 정리에서 확인한 사항

- 자동 연결 「다른 카드로 결제」(SA-151) 서버는 #786으로 병합됨. 파트너스 결제 화면이 새 API(`POST /api/automation/purchase/one-time`)를 부르는 것은 화면-Back 소관.
- 실제 샌드박스 결제창 종단 확인, 환불 실행(`pgTid`·`Payment.pgTid` PG 취소)은 대표님 승인 환경에서 한다.
