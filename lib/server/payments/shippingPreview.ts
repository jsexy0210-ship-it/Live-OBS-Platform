import type { PrismaClient } from "@prisma/client";
import { MAX_LINE_QUANTITY, MAX_ORDER_LINES } from "../orders/create";
import { computeShippingFee, getShippingPolicy, isRemoteAddress } from "../orders/shipping";
import { eventOf, orderUnitPrice } from "../products/event";
import { shopOpenForPayment } from "./service";

// 주문서 배송비 미리보기(기반-결제 3단계). 주문 생성(orders/create.ts)과 같은 단가(이벤트 할인 포함)·배송비·도서산간 규칙으로 계산만 한다.
// 쿠폰 할인은 넣지 않는다(쿠폰은 주문 생성 때 서버가 다시 계산). 재고·구매 제한은 보지 않고, 주문할 때 다시 확인한다.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ShippingPreview = { itemsSubtotal: number; shippingFee: number; isRemote: boolean; total: number };
export type ShippingPreviewRejection = "shop_unavailable" | "invalid_items" | "invalid_address" | "product_unavailable";

export async function previewShipping(
  db: PrismaClient,
  input: { sellerId: string; items: unknown; zipCode: unknown; address1: unknown; now?: Date },
): Promise<{ ok: true; value: ShippingPreview } | { ok: false; reason: ShippingPreviewRejection }> {
  const items = input.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ORDER_LINES) return { ok: false, reason: "invalid_items" };
  const lines: { optionId: string; quantity: number }[] = [];
  const seen = new Set<string>();
  for (const r of items) {
    const { optionId, quantity } = (r ?? {}) as { optionId?: unknown; quantity?: unknown };
    if (typeof optionId !== "string" || !UUID.test(optionId) || seen.has(optionId)) return { ok: false, reason: "invalid_items" };
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QUANTITY) return { ok: false, reason: "invalid_items" };
    seen.add(optionId);
    lines.push({ optionId, quantity });
  }
  const zipCode = typeof input.zipCode === "string" ? input.zipCode.normalize("NFKC").trim() : "";
  const address1 = typeof input.address1 === "string" ? input.address1.trim() : "";
  if (!/^\d{5}$/.test(zipCode) || address1.length < 1 || address1.length > 200) return { ok: false, reason: "invalid_address" };
  if (!(await shopOpenForPayment(db, input.sellerId))) return { ok: false, reason: "shop_unavailable" };

  const options = await db.productOption.findMany({
    where: { sellerId: input.sellerId, id: { in: lines.map((l) => l.optionId) }, deletedAt: null },
    include: { product: true },
  });
  if (options.length !== lines.length || options.some((o) => o.product.status !== "ON_SALE" || o.product.deletedAt)) return { ok: false, reason: "product_unavailable" };
  const now = input.now ?? new Date();
  const byId = new Map(options.map((o) => [o.id, o]));
  const itemsSubtotal = lines.reduce((sum, l) => {
    const o = byId.get(l.optionId)!;
    return sum + orderUnitPrice(o.product.price + o.priceDelta, eventOf(o.product), now) * l.quantity;
  }, 0);
  const policy = await getShippingPolicy(db, input.sellerId);
  const isRemote = isRemoteAddress(zipCode, address1, policy.remoteZipRanges);
  const shippingFee = computeShippingFee(itemsSubtotal, policy, isRemote);
  return { ok: true, value: { itemsSubtotal, shippingFee, isRemote, total: itemsSubtotal + shippingFee } };
}
