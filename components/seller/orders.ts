import { formatDateTime } from "../../lib/client/format";
// 판매자 주문 화면(SA-021 목록 · SA-022 상세 · SA-023 환불) 공통 타입과 표시 규칙.
export type OrderStatus = "PENDING_PAYMENT" | "PAID" | "CANCELLED" | "REFUNDED";

// GET /api/seller/orders 한 줄. 받는 분 이름·연락처는 목록에 없다.
export type OrderRow = {
  id: string;
  orderNo: number;
  // 사람이 읽는 주문번호(「20261002-0409」). 전화 응대·검색 대조용
  orderNoLabel: string;
  status: OrderStatus;
  createdAt: string;
  paidAt: string | null;
  buyer: { id: string; broadcastNickname: string };
  totalAmount: number;
  // 현금 환불 합계(없으면 0)·환불한 품목 수량·남은 금액(totalAmount − refundedAmount)
  refundedAmount: number;
  refundedQuantity: number;
  remainingAmount: number;
  itemSummary: { firstProductName: string | null; otherCount: number };
  shipped: boolean;
  refundable: boolean;
  // 목록 API가 함께 주는 값(결제 수단 · 입금 기한 · 발송 상태 · 대기 중인 환불 요청 수)
  paymentMethod?: "CARD" | "BANK_TRANSFER" | null;
  paymentDueAt?: string | null;
  shipment?: { state: "none" | "in_transit" | "delivered"; courier: string | null; trackingNumber: string | null; deliveredAt: string | null };
  refundRequest?: { pendingCount: number };
};

export type OrderItem = { id: string; productNameSnapshot: string; optionNameSnapshot: string; unitPrice: number; quantity: number };

// GET /api/seller/orders/{id}. 고객 정보 보기 권한이 없으면 buyer는 닉네임만, shippingAddress는 도서산간 여부만 온다.
export type OrderDetail = {
  id: string;
  orderNo: number;
  orderNoLabel: string;
  status: OrderStatus;
  createdAt: string;
  paidAt: string | null;
  cancelledAt: string | null;
  refundedAt: string | null;
  totalAmount: number;
  rewardUsedAmount: number;
  shippingFee: number;
  paymentMethod: "CARD" | "BANK_TRANSFER" | null;
  refundAmount: number | null;
  refundFault: "BUYER" | "SELLER" | null;
  returnFeeDeducted: number | null;
  items: OrderItem[];
  shipment: { courier: string; trackingNumber: string; status: string; shippedAt: string; deliveredAt: string | null } | null;
  shippingAddress:
    | { isRemote: boolean; recipientName?: string; phone?: string; zipCode?: string; address1?: string; address2?: string | null; memo?: string | null }
    | null;
  buyer: { id: string; broadcastNickname: string; name?: string; phone?: string };
  // 환불 API의 expectedVersion(주문대기 버전). 상세를 읽은 때의 값이다.
  queueVersion: number;
  // 결제 완료 주문만 온다. 사유 주체별 실제 환불액(서버 계산), 개봉한 상품, 이 사유로 환불할 수 없는지(blocked)
  refundPreview: RefundPreview | null;
  // 상태 이력(시각 오름차순). 서버 모양은 lib/server/orders/history.ts
  history: OrderHistoryEvent[];
  // 쓴 쿠폰과 할인 금액(전체 취소로 되돌렸으면 restoredAt). 쿠폰을 쓰지 않았으면 null
  couponRedemption: { benefit: "AMOUNT" | "RATE" | "FREE_SHIPPING"; discountAmount: number; restoredAt: string | null; coupon: { id: string; name: string } } | null;
};

export type RefundFault = "BUYER" | "SELLER";
export type RefundPreview = {
  shipped: boolean;
  // 구매자가 실제로 낸 처음 배송비(배송비 무료 쿠폰이면 0). 예전 응답에는 없다.
  chargedShippingFee?: number;
  openedItems: { orderItemId: string; amount: number }[];
  // refundAmount: 현금 환불액(적립금 반환을 뺀 값), rewardReturn: 함께 적립금으로 돌려주는 금액(쓴 적립금이 없으면 0),
  // itemsAmount·shippingRefunded: 이번에 돌려받는 상품 금액·배송비(배송비는 마지막 환불에서만)
  byFault: Record<RefundFault, { refundAmount: number; returnFeeDeducted: number; rewardReturn: number; itemsAmount?: number; shippingRefunded?: number; blocked: boolean }>;
  // 부분 환불(SA-023): 품목별 남은 수량, 이번 환불로 주문 전체가 끝나는지, 이미 돌려준 현금 합, 회수할 주문 적립. 예전 응답에는 없다.
  items?: RefundPreviewItem[];
  isFinal?: boolean;
  refundedAmount?: number;
  rewardRevoke?: { amount: number; kind: "ledger" | "manual" | "pending" | null };
};
export type RefundPreviewItem = {
  orderItemId: string;
  productName: string;
  optionName: string;
  quantity: number;
  refundedQuantity: number;
  refundableQuantity: number;
  opened: boolean;
  // 개봉 순서를 기다리거나 개봉 중: 수량 일부만 환불할 수 없다
  queued: boolean;
  refundableAmount: number;
};

export type OrderHistoryEvent = {
  kind: "status" | "payment_approved" | "refund_partial" | "payment_cancel";
  at: string;
  status: OrderStatus | null;
  fromStatus: OrderStatus | null;
  amount: number | null;
  quantity: number | null;
  cancelStatus: "REQUESTED" | "DONE" | "FAILED" | null;
  actor: { type: "SELLER" | "BUYER" | "ADMIN" | "SYSTEM"; role: "OWNER" | "STAFF" | null; name: string | null };
  note: string | null;
};

// 상태 이력 「상태」 칸: 시안(SA-022) 표의 상태 이름을 따른다
export function historyLabel(e: OrderHistoryEvent) {
  if (e.kind === "payment_approved") return "결제 완료";
  if (e.kind === "refund_partial") return "일부 환불";
  if (e.kind === "payment_cancel") return "결제 취소";
  if (e.status === "PAID") return "결제 완료";
  if (e.status === "PENDING_PAYMENT") return e.fromStatus ? "결제 대기" : "주문 생성";
  return e.status ? STATUS_BADGE[e.status].label : "—";
}

// 상태 이력 「비고」 칸: 금액·수량·취소 결과 뒤에 파트너스가 쓴 사유
export function historyNote(e: OrderHistoryEvent) {
  const parts: string[] = [];
  if (e.amount !== null) parts.push(`${e.amount.toLocaleString("ko-KR")}원`);
  if (e.kind === "refund_partial" && e.quantity) parts.push(`${e.quantity}개`);
  if (e.kind === "payment_cancel") parts.push(e.cancelStatus === "DONE" ? "취소 완료" : e.cancelStatus === "FAILED" ? "취소 실패" : "취소 요청");
  if (e.note) parts.push(e.note);
  return parts.join(" · ");
}

// 상태 이력 「처리」 칸: 역할·이름만
export function historyActor(a: OrderHistoryEvent["actor"]) {
  if (a.type === "SYSTEM") return "자동";
  if (a.type === "BUYER") return "구매자";
  if (a.type === "ADMIN") return "마스터 관리자";
  return a.name ?? (a.role === "OWNER" ? "대표" : "직원");
}

// 결제 상태 배지. 시안 결제 배지(완료·결제 대기·환불됨)에 맞추고, 시안에 없는 취소는 「취소」로 보인다.
export const STATUS_BADGE: Record<OrderStatus, { label: string; cls: string }> = {
  PENDING_PAYMENT: { label: "결제 대기", cls: "b-wait" },
  PAID: { label: "완료", cls: "b-done" },
  CANCELLED: { label: "취소", cls: "b-cancel" },
  REFUNDED: { label: "환불됨", cls: "b-cancel" },
};
// 일부만 환불한 주문(전액 환불은 status가 REFUNDED)
export const isPartialRefund = (o: Pick<OrderRow, "status" | "refundedAmount">) => o.refundedAmount > 0 && o.status !== "REFUNDED";
// 목록 결제 칸 배지: 부분 환불이면 「부분 환불」(환불 계열 색), 아니면 결제 상태
export const payBadge = (o: Pick<OrderRow, "status" | "refundedAmount">) => (isPartialRefund(o) ? { label: "부분 환불", cls: "b-cancel" } : STATUS_BADGE[o.status]);

// 상세 머리 배지는 「결제 완료」(SA-022)
export const detailStatusLabel = (s: OrderStatus) => (s === "PAID" ? "결제 완료" : STATUS_BADGE[s].label);

export const PAYMENT_METHOD: Record<string, string> = { CARD: "신용카드", BANK_TRANSFER: "무통장 입금" };

// 한국 시간 기준 날짜·시각 조각
function kst(iso: string) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: String(d.getUTCHours()).padStart(2, "0"), mm: String(d.getUTCMinutes()).padStart(2, "0"), ss: String(d.getUTCSeconds()).padStart(2, "0") };
}
export const kstDate = (iso: string) => {
  const t = kst(iso);
  return `${t.y}-${String(t.m).padStart(2, "0")}-${String(t.d).padStart(2, "0")}`;
};
// 목록 첫 줄: 오늘이면 「14:12」, 아니면 「9/30 13:28」(SA-021-S)
export function listTime(iso: string, now = new Date()) {
  const t = kst(iso);
  return kstDate(iso) === kstDate(now.toISOString()) ? `${t.hh}:${t.mm}` : `${t.m}/${t.d} ${t.hh}:${t.mm}`;
}
export const listDate = (iso: string) => {
  const t = kst(iso);
  return `${t.m}/${t.d}`;
};
// 「2026.10.02 14:02」(공용 일시 서식, lib/client/format.ts)
export const longTime = (iso: string) => formatDateTime(iso);
export const fullTime = (iso: string) => formatDateTime(iso);
// 오늘 기준 n일 전의 한국 날짜(기간 필터 from)
export const kstDaysAgo = (n: number, now = new Date()) => kstDate(new Date(now.getTime() - n * 86_400_000).toISOString());

export const itemSummaryText = (s: OrderRow["itemSummary"]) =>
  `${s.firstProductName ?? "상품 정보 없음"}${s.otherCount > 0 ? ` 외 ${s.otherCount}건` : ""}`;

// 전화번호 하이픈(010-1234-5678). 서울 02 번호는 02-XXX(X)-XXXX. 형식이 다르면 그대로 둔다.
export const phoneText = (p: string) => {
  const d = p.replace(/\D/g, "");
  if (d.startsWith("02") && (d.length === 9 || d.length === 10)) return `02-${d.slice(2, d.length - 4)}-${d.slice(-4)}`;
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return p;
};
