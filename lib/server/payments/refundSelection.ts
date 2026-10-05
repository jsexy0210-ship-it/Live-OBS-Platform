import type { RefundSelection } from "../queue/service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const REFUND_SELECTION_MAX = 100;

// 부분 환불 요청 본문의 items: 없으면 undefined(남은 품목 전부), 모양이 틀리면 null. 주문에 있는지·남은 수량은 refundOrder가 본다.
export function parseRefundSelection(raw: unknown): RefundSelection | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > REFUND_SELECTION_MAX) return null;
  const out: RefundSelection = [];
  for (const x of raw) {
    if (typeof x !== "object" || x === null) return null;
    const { orderItemId, quantity } = x as { orderItemId?: unknown; quantity?: unknown };
    if (typeof orderItemId !== "string" || !UUID.test(orderItemId) || !Number.isSafeInteger(quantity) || (quantity as number) < 1) return null;
    out.push({ orderItemId, quantity: quantity as number });
  }
  return out;
}
