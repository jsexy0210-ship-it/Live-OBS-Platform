import type { PrismaClient } from "@prisma/client";
import { shopOpen } from "../buyers/signup";
import { parseRewardUse, rewardUsePrecheck, REWARD_USE_MIN, REWARD_USE_UNIT, type RewardUseFailure } from "../payments/rewardUse";
import { itemCouponDiscount } from "../shop-coupons/service";
import { dbClock } from "./overdue";
import { priceOrder, type OrderPricingFailure } from "./pricing";
import { INT4_MAX } from "./shipping";
import { MAX_LINE_QUANTITY, MAX_ORDER_LINES } from "./create";

// 주문서 견적(읽기 전용): 주문 생성과 같은 계산(orders/pricing.ts)을 돌려 주문서에 보여 줄 금액을 준다.
// 순서는 상품 금액 + 배송비 → 쿠폰 → 적립금이고 결제 금액은 최소 1원이다. 서버 계산이 기준이며 주문을 만들 때 다시 계산한다.
// 쿠폰·적립금을 쓰지 않아도 되고, 쓰지 못하는 이유는 오류 코드로 준다(쿠폰 실패는 쿠폰만 빼고 다시 부르면 된다).

export type QuoteFailure = "shop_unavailable" | "invalid_items" | "invalid_shipping_address" | "invalid_reward_use" | OrderPricingFailure | RewardUseFailure | "invalid_amount";
export type QuoteInput = { sellerId: string; buyerMemberId: string; items: unknown; couponId?: unknown; rewardUseAmount?: unknown; zipCode?: unknown; address1?: unknown };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseLines(raw: unknown) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ORDER_LINES) return null;
  const seen = new Set<string>();
  const lines: { optionId: string; quantity: number }[] = [];
  for (const r of raw) {
    const { optionId, quantity } = (r ?? {}) as { optionId?: unknown; quantity?: unknown };
    if (typeof optionId !== "string" || !UUID.test(optionId) || seen.has(optionId)) return null;
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QUANTITY) return null;
    seen.add(optionId);
    lines.push({ optionId, quantity });
  }
  return lines;
}

export async function quoteOrder(db: PrismaClient, input: QuoteInput) {
  if (!(await shopOpen(db, input.sellerId))) return { ok: false as const, reason: "shop_unavailable" as const };
  const lines = parseLines(input.items);
  if (!lines) return { ok: false as const, reason: "invalid_items" as const };
  // 도서·산간 판단용 우편번호·주소(둘 다 있을 때만, 없으면 일반 지역 배송비)
  const zip = typeof input.zipCode === "string" ? input.zipCode.trim() : "";
  const addr1 = typeof input.address1 === "string" ? input.address1.trim() : "";
  const address = zip && addr1 ? { zipCode: zip, address1: addr1 } : null;
  const rewardUse = parseRewardUse(input.rewardUseAmount);
  if (rewardUse === null) return { ok: false as const, reason: "invalid_reward_use" as const };

  return db.$transaction(async (tx) => {
    const now = await dbClock(tx);
    const member = await tx.buyerMember.findFirst({ where: { id: input.buyerMemberId, sellerId: input.sellerId, status: "ACTIVE", deletedAt: null }, select: { id: true } });
    if (!member) return { ok: false as const, reason: "shop_unavailable" as const };
    const price = await priceOrder(tx, { sellerId: input.sellerId, buyerMemberId: member.id, lines, address, couponId: input.couponId, now });
    if (!price.ok) return { ok: false as const, reason: price.reason };
    const policy = await tx.rewardPolicy.findUnique({ where: { sellerId: input.sellerId }, select: { livePayoutEnabled: true } });
    const balanceRow = await tx.rewardBalance.findUnique({ where: { sellerId_buyerMemberId: { sellerId: input.sellerId, buyerMemberId: member.id } }, select: { balance: true } });
    const rewardBalance = balanceRow?.balance ?? 0;
    // 쓸 수 있는 최대: 한도와 잔액 중 작은 값을 10원 단위로 내림, 1,000원 미만이면 0
    const usable = Math.floor(Math.min(price.rewardLimit, rewardBalance) / REWARD_USE_UNIT) * REWARD_USE_UNIT;
    const rewardMax = policy?.livePayoutEnabled && usable >= REWARD_USE_MIN ? usable : 0;
    if (rewardUse > 0) {
      const pre = await rewardUsePrecheck(tx, { sellerId: input.sellerId, amount: rewardUse, limit: price.rewardLimit });
      if (pre) return { ok: false as const, reason: pre };
      if (rewardUse > rewardBalance) return { ok: false as const, reason: "reward_balance_insufficient" as const };
    }
    const totalAmount = price.itemsSubtotal + price.shippingFee - price.couponDiscount - rewardUse;
    if (!Number.isSafeInteger(totalAmount) || totalAmount > INT4_MAX) return { ok: false as const, reason: "invalid_amount" as const };
    const applied = price.coupon.applied;
    return {
      ok: true as const,
      value: {
        itemsSubtotal: price.itemsSubtotal,
        shippingFee: price.shippingFee,
        isRemote: price.isRemote,
        coupon: applied ? { couponId: applied.couponId, benefit: applied.benefit, discountAmount: applied.discountAmount } : null,
        couponDiscount: price.couponDiscount,
        rewardUse,
        rewardMax,
        rewardBalance,
        totalAmount,
        items: price.priced.map((p) => ({
          optionId: p.option.id,
          unitPrice: p.unitPrice,
          listUnitPrice: p.listUnitPrice,
          quantity: p.line.quantity,
          couponDiscount: applied ? itemCouponDiscount({ itemDiscounts: applied.itemDiscounts }, p.option.id) : 0,
        })),
      },
    };
  });
}

