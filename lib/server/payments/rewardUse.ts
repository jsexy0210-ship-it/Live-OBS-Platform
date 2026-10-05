import type { Prisma } from "@prisma/client";
import { writeAudit } from "../audit/log";

// 적립금 사용(결제 차감, 대표님 결정 2026-10-05).
// - 최소 1,000원, 10원 단위, 상품 금액(상품 할인 쿠폰을 뺀 금액)까지. 배송비에는 쓸 수 없다. 결제할 금액은 1원 이상 남아야 한다.
// - 판매자 실지급 스위치(RewardPolicy.livePayoutEnabled)가 꺼져 있으면 쓸 수 없다.
// - 주문 생성 트랜잭션 안에서 잔액을 바로 빼고 USE 원장(음수, SUCCEEDED)을 남긴다. 멱등 키 use:{orderId}라 같은 주문에 두 번 쓰이지 않는다.
// - 결제 대기 주문 취소·입금 기한 자동 취소는 전부 돌려준다. 환불은 적립금이 상품 금액에만 쓰이므로 상품 금액 기준(MASTER 2026-10-05):
//   돌려주는 상품이 주문 상품 전부면 쓴 적립금 전부, 일부면 쓴 적립금 × 환불 상품 금액 ÷ 주문 상품 금액을 10원 단위로 내림.
//   상품 금액은 품목별 쿠폰 배분을 뺀 값이고 배송비·반품 배송비는 넣지 않는다. 반환 원장은 USE 양수(SUCCEEDED), 멱등 키 use_return:{orderId}.
// - 잠금 순서: 주문(판매자 주문 잠금, 부르는 쪽) → 회원(FOR SHARE) → 적립금 잔액 행(FOR UPDATE). 잔액은 DB CHECK로 음수가 될 수 없다.
type Tx = Prisma.TransactionClient;

export const REWARD_USE_MIN = 1000;
export const REWARD_USE_UNIT = 10;

export type RewardUseFailure = "invalid_reward_use" | "reward_use_unavailable" | "reward_use_over_limit" | "reward_balance_insufficient";

// 요청 값: 없거나 0이면 0(사용 안 함), 1,000원 이상·10원 단위 정수면 그 값, 아니면 null.
export function parseRewardUse(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === 0) return 0;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < REWARD_USE_MIN || raw % REWARD_USE_UNIT !== 0) return null;
  return raw;
}

// 쓸 수 있는 최대: 상품 금액 − 상품 할인 쿠폰(배송비 무료 쿠폰은 배송비만 깎으므로 빼지 않음), 그리고 결제할 금액이 1원 이상 남도록.
export function rewardUseLimit(o: { itemsSubtotal: number; shippingFee: number; couponDiscount: number; couponIsShipping: boolean }): number {
  const itemCoupon = o.couponIsShipping ? 0 : o.couponDiscount;
  const payable = o.itemsSubtotal + o.shippingFee - o.couponDiscount;
  return Math.max(0, Math.min(o.itemsSubtotal - itemCoupon, payable - 1));
}

// 주문 생성 트랜잭션 안에서 부른다(판매자 주문 잠금·회원 FOR SHARE를 잡은 뒤). 성공하면 null.
export async function useRewardForOrder(
  tx: Tx,
  o: { sellerId: string; buyerMemberId: string; orderId: string; amount: number; limit: number; now: Date },
): Promise<RewardUseFailure | null> {
  if (o.amount === 0) return null;
  const policy = await tx.rewardPolicy.findUnique({ where: { sellerId: o.sellerId }, select: { livePayoutEnabled: true } });
  if (!policy?.livePayoutEnabled) return "reward_use_unavailable";
  if (o.amount > o.limit) return "reward_use_over_limit";
  const [bal] = await tx.$queryRaw<{ balance: number }[]>`
    SELECT "balance" FROM "RewardBalance" WHERE "sellerId" = ${o.sellerId}::uuid AND "buyerMemberId" = ${o.buyerMemberId}::uuid FOR UPDATE`;
  if (!bal || bal.balance < o.amount) return "reward_balance_insufficient";
  await tx.rewardBalance.update({
    where: { sellerId_buyerMemberId: { sellerId: o.sellerId, buyerMemberId: o.buyerMemberId } },
    data: { balance: { decrement: o.amount } },
  });
  await tx.rewardLedger.create({
    data: {
      sellerId: o.sellerId,
      buyerMemberId: o.buyerMemberId,
      orderId: o.orderId,
      type: "USE",
      amount: -o.amount,
      status: "SUCCEEDED",
      testMode: false,
      idempotencyKey: `use:${o.orderId}`,
      createdAt: o.now,
      processedAt: o.now,
    },
  });
  await tx.order.update({ where: { id: o.orderId }, data: { rewardUsedAmount: o.amount } });
  await writeAudit(tx, { actorType: "BUYER", actorId: o.buyerMemberId, sellerId: o.sellerId, action: "reward.use", targetType: "Order", targetId: o.orderId, after: { amount: o.amount } });
  return null;
}

// 반환할 금액: 취소(items 없음)·상품 전부 환불은 쓴 적립금 전부, 일부 상품 환불은 쓴 적립금 × 환불 상품 금액 ÷ 주문 상품 금액(10원 단위 내림).
export type RefundedItems = { refunded: number; ordered: number };
export function rewardReturnAmount(o: { rewardUsedAmount: number; items?: RefundedItems }): number {
  if (o.rewardUsedAmount <= 0) return 0;
  if (!o.items || o.items.refunded >= o.items.ordered) return o.rewardUsedAmount;
  if (o.items.ordered <= 0 || o.items.refunded <= 0) return 0;
  const raw = Math.floor((o.rewardUsedAmount * o.items.refunded) / o.items.ordered);
  return raw - (raw % REWARD_USE_UNIT);
}

// 취소·환불 트랜잭션 안에서 부른다(판매자 주문 잠금 뒤). items(환불 상품 금액·주문 상품 금액)를 주면 환불(비율 반환), 없으면 취소(전부 반환).
// 이미 돌려줬으면(같은 멱등 키) 다시 돌려주지 않는다. 탈퇴한 회원이면 잔액에 넣지 않고 FAILED로 남긴다.
export async function returnRewardForOrder(tx: Tx, o: { sellerId: string; orderId: string; items?: RefundedItems; now: Date; reason: string }): Promise<number> {
  const order = await tx.order.findFirst({ where: { id: o.orderId, sellerId: o.sellerId }, select: { buyerMemberId: true, rewardUsedAmount: true } });
  if (!order) return 0;
  const amount = rewardReturnAmount({ rewardUsedAmount: order.rewardUsedAmount, items: o.items });
  if (amount <= 0) return 0;
  const key = `use_return:${o.orderId}`;
  if (await tx.rewardLedger.findUnique({ where: { sellerId_idempotencyKey: { sellerId: o.sellerId, idempotencyKey: key } }, select: { id: true } })) return 0;
  const [m] = await tx.$queryRaw<{ status: string }[]>`
    SELECT "status"::text AS "status" FROM "BuyerMember" WHERE "id" = ${order.buyerMemberId}::uuid AND "sellerId" = ${o.sellerId}::uuid FOR SHARE`;
  const withdrawn = !m || m.status === "WITHDRAWN";
  await tx.rewardLedger.create({
    data: {
      sellerId: o.sellerId,
      buyerMemberId: order.buyerMemberId,
      orderId: o.orderId,
      type: "USE",
      amount,
      status: withdrawn ? "FAILED" : "SUCCEEDED",
      failureReason: withdrawn ? "member_withdrawn" : null,
      testMode: false,
      idempotencyKey: key,
      createdAt: o.now,
      processedAt: o.now,
    },
  });
  if (withdrawn) return 0;
  await tx.$queryRaw`SELECT 1 FROM "RewardBalance" WHERE "sellerId" = ${o.sellerId}::uuid AND "buyerMemberId" = ${order.buyerMemberId}::uuid FOR UPDATE`;
  await tx.rewardBalance.upsert({
    where: { sellerId_buyerMemberId: { sellerId: o.sellerId, buyerMemberId: order.buyerMemberId } },
    create: { sellerId: o.sellerId, buyerMemberId: order.buyerMemberId, balance: amount },
    update: { balance: { increment: amount } },
  });
  await writeAudit(tx, { actorType: "SYSTEM", sellerId: o.sellerId, action: "reward.use_return", targetType: "Order", targetId: o.orderId, reason: o.reason, after: { amount } });
  return amount;
}
