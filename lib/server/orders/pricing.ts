import type { Prisma } from "@prisma/client";
import { eventOf, orderUnitPrice } from "../products/event";
import { loadRewardUseSettings, rewardUseLimit } from "../payments/rewardUse";
import { quoteOrderCoupon, type OrderCouponFailure } from "../shop-coupons/service";
import { computeShippingFee, getShippingPolicy, isRemoteAddress } from "./shipping";
import { applyGradeShipping, loadGradeShipping } from "../shop-member-grades/benefits";

// 주문 금액 계산(서버 기준). 주문 생성(create.ts)과 주문서 견적(quote.ts)이 같은 계산을 쓴다.
// 순서: 상품 금액 + 배송비 → 쿠폰 → 적립금 한도(결제 금액 1원 이상 유지).
type Tx = Prisma.TransactionClient;

export type PricedLine = NonNullable<Awaited<ReturnType<typeof loadLines>>>[number];
export type OrderPricingFailure = "product_unavailable" | "out_of_stock" | "invalid_amount" | OrderCouponFailure;

async function loadLines(tx: Tx, sellerId: string, lines: { optionId: string; quantity: number }[], now: Date) {
  const options = await tx.productOption.findMany({
    where: { sellerId, id: { in: lines.map((l) => l.optionId) }, deletedAt: null },
    include: { product: true },
  });
  if (options.length !== lines.length) return null;
  const byId = new Map(options.map((o) => [o.id, o]));
  return lines.map((l) => {
    const option = byId.get(l.optionId)!;
    // 이벤트 할인 기간이면 할인 뒤 단가, 아니면 정가. 정가는 listUnitPrice로 남긴다.
    const listUnitPrice = option.product.price + option.priceDelta;
    return { line: l, option, listUnitPrice, unitPrice: orderUnitPrice(listUnitPrice, eventOf(option.product), now) };
  });
}

export async function priceOrder(
  tx: Tx,
  o: {
    sellerId: string;
    buyerMemberId: string;
    lines: { optionId: string; quantity: number }[];
    address: { zipCode: string; address1: string } | null;
    couponId: unknown;
    now: Date;
  },
) {
  const priced = await loadLines(tx, o.sellerId, o.lines, o.now);
  if (!priced) return { ok: false as const, reason: "product_unavailable" as const };
  for (const p of priced) {
    if (p.option.product.status !== "ON_SALE" || p.option.product.deletedAt) return { ok: false as const, reason: "product_unavailable" as const };
    if (p.option.stock < p.line.quantity) return { ok: false as const, reason: "out_of_stock" as const };
  }
  // 단가가 1원 미만이면 만들지 않는다(음수 추가금 등)
  if (priced.some((p) => p.unitPrice < 1)) return { ok: false as const, reason: "invalid_amount" as const };
  const itemsSubtotal = priced.reduce((sum, p) => sum + p.unitPrice * p.line.quantity, 0);
  const policy = await getShippingPolicy(tx, o.sellerId);
  const isRemote = o.address ? isRemoteAddress(o.address.zipCode, o.address.address1, policy.remoteZipRanges) : false;
  const baseShippingFee = computeShippingFee(itemsSubtotal, policy, isRemote);
  // 회원 등급 배송비 혜택(견적과 주문 생성이 이 함수를 같이 써서 견적 금액 = 결제 금액)
  const shippingFee = applyGradeShipping(baseShippingFee, await loadGradeShipping(tx, o.sellerId, o.buyerMemberId));
  // 쿠폰 할인(서버 계산). 배송비 무료 쿠폰도 배송비(shippingFee)는 그대로 남기고 할인 금액으로 뺀다.
  const coupon = await quoteOrderCoupon(tx, {
    sellerId: o.sellerId,
    buyerMemberId: o.buyerMemberId,
    couponId: o.couponId,
    now: o.now,
    lines: priced.map((p) => ({ key: p.option.id, productId: p.option.productId, unitPrice: p.unitPrice, listUnitPrice: p.listUnitPrice, quantity: p.line.quantity })),
    shippingFee,
  });
  if (!coupon.ok) return { ok: false as const, reason: coupon.reason };
  const couponDiscount = coupon.applied?.discountAmount ?? 0;
  // 적립금 사용 설정(최소 금액·최대 비율)은 여기서 한 번 읽어 한도 계산과 견적·주문 검증에 같이 쓴다
  const rewardSettings = await loadRewardUseSettings(tx, o.sellerId);
  const rewardLimit = rewardUseLimit({ itemsSubtotal, shippingFee, couponDiscount, couponIsShipping: coupon.applied?.benefit === "FREE_SHIPPING", maxRatio: rewardSettings.maxRatio });
  return { ok: true as const, priced, policy, isRemote, itemsSubtotal, shippingFee, gradeShippingDiscount: baseShippingFee - shippingFee, coupon, couponDiscount, rewardLimit, rewardSettings };
}
