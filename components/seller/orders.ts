// 판매자 주문 화면(SA-021 목록 · SA-022 상세 · SA-023 환불) 공통 타입과 표시 규칙.
export type OrderStatus = "PENDING_PAYMENT" | "PAID" | "CANCELLED" | "REFUNDED";

// GET /api/seller/orders 한 줄. 받는 분 이름·연락처는 목록에 없다.
export type OrderRow = {
  id: string;
  orderNo: number;
  status: OrderStatus;
  createdAt: string;
  paidAt: string | null;
  buyer: { id: string; broadcastNickname: string };
  totalAmount: number;
  itemSummary: { firstProductName: string | null; otherCount: number };
  shipped: boolean;
  refundable: boolean;
};

export type OrderItem = { id: string; productNameSnapshot: string; optionNameSnapshot: string; unitPrice: number; quantity: number };

// GET /api/seller/orders/{id}. 고객 정보 보기 권한이 없으면 buyer는 닉네임만, shippingAddress는 도서산간 여부만 온다.
export type OrderDetail = {
  id: string;
  orderNo: number;
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
};

// 결제 상태 배지. 시안 결제 배지(완료·결제 대기·환불됨)에 맞추고, 시안에 없는 취소는 「취소」로 보인다.
export const STATUS_BADGE: Record<OrderStatus, { label: string; cls: string }> = {
  PENDING_PAYMENT: { label: "결제 대기", cls: "b-wait" },
  PAID: { label: "완료", cls: "b-done" },
  CANCELLED: { label: "취소", cls: "b-cancel" },
  REFUNDED: { label: "환불됨", cls: "b-cancel" },
};
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
// 「10월 2일 14:02」
export const longTime = (iso: string) => {
  const t = kst(iso);
  return `${t.m}월 ${t.d}일 ${t.hh}:${t.mm}`;
};
// 「2026-10-02 14:02:10」
export const fullTime = (iso: string) => {
  const t = kst(iso);
  return `${kstDate(iso)} ${t.hh}:${t.mm}:${t.ss}`;
};
// 오늘 기준 n일 전의 한국 날짜(기간 필터 from)
export const kstDaysAgo = (n: number, now = new Date()) => kstDate(new Date(now.getTime() - n * 86_400_000).toISOString());

export const itemSummaryText = (s: OrderRow["itemSummary"]) =>
  `${s.firstProductName ?? "상품 정보 없음"}${s.otherCount > 0 ? ` 외 ${s.otherCount}건` : ""}`;

// 휴대폰 번호 하이픈(010-1234-5678). 형식이 다르면 그대로 둔다.
export const phoneText = (p: string) => {
  const d = p.replace(/\D/g, "");
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return p;
};
