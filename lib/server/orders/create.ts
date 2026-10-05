import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { MAX_NICKNAME_LENGTH } from "../buyers/signup";
import { cleanText } from "../text/clean";
import { parseRewardUse, rewardUseLimit, useRewardForOrder, type RewardUseFailure } from "../payments/rewardUse";
import { recordOrderAddress } from "../buyers/addresses";
import { eventOf, orderUnitPrice } from "../products/event";
import { sellerHasFeature } from "../billing/features";
import { sellerAccessFor } from "../billing/subscription";
import { OPENED_NO_REFUND_CONSENT } from "./consent";
import { activeRestriction, dbClock, getOrderPolicy, lockSellerOrders } from "./overdue";
import { computeShippingFee, getShippingPolicy, INT4_MAX, isRemoteAddress, parseShippingAddress } from "./shipping";
import { CouponTaken, quoteOrderCoupon, useOrderCoupon, type OrderCouponFailure } from "../shop-coupons/service";

// 구매자 주문 생성(결제 대기까지). 실제 PG 결제 호출은 없다.
// - 결제 전 개봉 고지(OPENED_NO_REFUND_CONSENT) 동의 필수(체크 기본 해제, 동의 없으면 주문을 만들지 않음). 동의 시각(DB 시계)·문구 버전을 기록.
// - 잠긴 판매자(체험하기·구독 끝)는 새 주문을 받지 않는다.
// - 금액은 서버가 상품·옵션 가격으로 계산한다. 화면이 보낸 금액은 받지 않는다.
// - 재고는 주문 수량만큼 있는지 확인한다(차감은 결제 때, 선점 없음 — 대표님 확정, ARCHITECTURE 4.4).
// - 즉시 발송: 배송지는 주문 때 받아 스냅숏으로 남기고, 배송비는 판매자 배송비 설정으로 계산한다(shipping.ts).
// - 적립금 사용은 방식이 정해지기 전이라 받지 않는다(요청이 오면 거부).
// - 입력한 배송지는 구매자 배송지 목록에 저장한다(saveAddress: false면 저장 안 함, 기본 저장. buyers/addresses.ts).
// - 쿠폰(couponId, 주문당 1장): 할인 금액은 서버가 계산해 결제 금액에서 빼고, 같은 트랜잭션에서 쿠폰을 USED로 바꾼다(shop-coupons/service.ts).

export const MAX_ORDER_LINES = 20;
export const MAX_LINE_QUANTITY = 99;
// 주문 생성 횟수 제한: 같은 구매자, 같은 쇼핑몰 기준 1분에 10건
export const ORDER_RATE_LIMIT = 10;
export const ORDER_RATE_WINDOW_MS = 60_000;

export type CreateOrderInput = {
  sellerId: string;
  buyerMemberId: string;
  items: unknown;
  consent: { agreed?: unknown; noticeVersion?: unknown } | undefined;
  rewardUseAmount?: unknown;
  shippingAddress: unknown;
  saveAddress?: unknown;
  couponId?: unknown;
  // 이 주문에만 쓰는 방송 닉네임(선택, 1~20자). 비우면 회원 방송 닉네임. 회원 닉네임 자체는 바꾸지 않는다(MASTER 결정 2026-10-05).
  orderNickname?: unknown;
  meta?: { ip?: string | null; userAgent?: string | null };
};

export type CreateOrderFailure =
  | "shop_unavailable" // 잠긴 판매자·운영 중 아님
  | "consent_required" // 동의 안 함
  | "consent_outdated" // 화면이 보여 준 문구 버전이 지금과 다름
  | "invalid_items"
  | "product_unavailable" // 판매 중이 아님·없는 옵션·다른 쇼핑몰 옵션
  | "out_of_stock"
  | "reward_use_not_supported"
  | RewardUseFailure // 적립금 사용(payments/rewardUse.ts): 금액 형식·판매자 사용 불가·한도 초과·잔액 부족
  | "invalid_shipping_address"
  | "invalid_order_nickname" // 주문 닉네임이 1~20자가 아니거나 쓸 수 없는 글자
  | "invalid_amount" // 단가 1원 미만(음수 추가금 등)·합계가 정수 범위를 넘음
  | "purchase_restricted" // 미입금 자동 취소가 쌓여 주문이 막힌 구매자(overdue.ts)
  | OrderCouponFailure // 쿠폰을 쓸 수 없음·적용 상품 없음·최소 주문 금액 미달(shop-coupons)
  | "order_rate_limited"; // 같은 구매자가 이 쇼핑몰에서 1분에 10건 넘게 주문

export type CreateOrderResult =
  | { ok: true; orderId: string; orderNo: number; totalAmount: number; shippingFee: number }
  | { ok: false; reason: CreateOrderFailure; endsAt?: Date };

type Line = { optionId: string; quantity: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseItems(raw: unknown): Line[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ORDER_LINES) return null;
  const lines: Line[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") return null;
    const { optionId, quantity } = r as { optionId?: unknown; quantity?: unknown };
    if (typeof optionId !== "string" || !UUID.test(optionId) || seen.has(optionId)) return null;
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QUANTITY) return null;
    seen.add(optionId);
    lines.push({ optionId, quantity });
  }
  return lines;
}

// 주문 닉네임: 없거나 빈 값(공백만 포함)이면 null(회원 닉네임 사용), 가입 닉네임과 같은 글자 검사(앞뒤 공백 제거·제어문자 등 금지, 20자)를 통과하면 그 값, 아니면 false.
export function parseOrderNickname(raw: unknown): string | null | false {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return false;
  if (raw.trim() === "") return null;
  return cleanText(raw, MAX_NICKNAME_LENGTH) ?? false;
}

export async function createOrder(db: PrismaClient, input: CreateOrderInput): Promise<CreateOrderResult> {
  // 판매자: 운영 중이고 잠기지 않았고 스토어 운영 기능 권한이 있어야 한다(이용 판단은 DB 시계, ARCHITECTURE 4.8.0)
  const seller = await db.seller.findUnique({ where: { id: input.sellerId }, select: { status: true } });
  if (
    !seller ||
    seller.status !== "ACTIVE" ||
    (await sellerAccessFor(db, input.sellerId)) === "expired" ||
    !(await sellerHasFeature(db, input.sellerId, "STORE_OPERATIONS"))
  ) {
    return { ok: false, reason: "shop_unavailable" };
  }
  if (input.consent?.agreed !== true) return { ok: false, reason: "consent_required" };
  if (input.consent.noticeVersion !== OPENED_NO_REFUND_CONSENT.version) return { ok: false, reason: "consent_outdated" };
  // 적립금 사용(대표님 결정 2026-10-05): 1,000원 이상 10원 단위. 판매자 사용 가능 여부·한도·잔액은 주문 잠금 아래에서 본다.
  const rewardUse = parseRewardUse(input.rewardUseAmount);
  if (rewardUse === null) return { ok: false, reason: "invalid_reward_use" };
  const lines = parseItems(input.items);
  if (!lines) return { ok: false, reason: "invalid_items" };
  const address = parseShippingAddress(input.shippingAddress);
  if (!address) return { ok: false, reason: "invalid_shipping_address" };
  if (input.saveAddress !== undefined && typeof input.saveAddress !== "boolean") return { ok: false, reason: "invalid_shipping_address" };
  const orderNickname = parseOrderNickname(input.orderNickname);
  if (orderNickname === false) return { ok: false, reason: "invalid_order_nickname" };

  try {
    return await createInTransaction(db, input, lines, address, orderNickname, rewardUse);
  } catch (e) {
    if (e instanceof RewardUseRejected) return { ok: false, reason: e.reason };
    if (e instanceof OutOfStockAtOrder) return { ok: false, reason: "out_of_stock" };
    if (e instanceof CouponTaken) return { ok: false, reason: "coupon_unavailable" };
    throw e;
  }
}

class OutOfStockAtOrder extends Error {}
class RewardUseRejected extends Error {
  constructor(readonly reason: RewardUseFailure) {
    super(reason);
  }
}

async function createInTransaction(
  db: PrismaClient,
  input: CreateOrderInput,
  lines: Line[],
  address: NonNullable<ReturnType<typeof parseShippingAddress>>,
  orderNickname: string | null,
  rewardUse: number,
): Promise<CreateOrderResult> {
  return db.$transaction(async (tx) => {
    // 같은 판매자의 주문 번호를 한 줄로 매긴다
    await lockSellerOrders(tx, input.sellerId);
    // 잠금을 잡은 뒤의 실제 DB 시각(주문 시각·입금 기한·횟수 제한 창의 기준)
    const now = await dbClock(tx);
    // 회원 행을 공유 잠금으로 잡아, 주문을 쓰는 동안 탈퇴(buyers/withdraw, FOR UPDATE)가 끼어들지 못하게 한다
    const [member] = await tx.$queryRaw<{ id: string; broadcastNickname: string }[]>`
      SELECT "id", "broadcastNickname" FROM "BuyerMember"
      WHERE "id" = ${input.buyerMemberId}::uuid AND "sellerId" = ${input.sellerId}::uuid AND "status" = 'ACTIVE' AND "deletedAt" IS NULL
      FOR SHARE`;
    if (!member) return { ok: false as const, reason: "shop_unavailable" as const };
    // 구매 제한·횟수 제한은 같은 잠금 아래에서 세므로 동시 주문에도 한도를 넘지 않는다
    const restriction = await activeRestriction(tx, input.sellerId, member.id, now);
    if (restriction) return { ok: false as const, reason: "purchase_restricted" as const, endsAt: restriction.endsAt };
    const recent = await tx.order.count({
      where: { sellerId: input.sellerId, buyerMemberId: member.id, createdAt: { gt: new Date(now.getTime() - ORDER_RATE_WINDOW_MS) } },
    });
    if (recent >= ORDER_RATE_LIMIT) return { ok: false as const, reason: "order_rate_limited" as const };

    const options = await tx.productOption.findMany({
      where: { sellerId: input.sellerId, id: { in: lines.map((l) => l.optionId) }, deletedAt: null },
      include: { product: true },
    });
    if (options.length !== lines.length) return { ok: false as const, reason: "product_unavailable" as const };
    const byId = new Map(options.map((o) => [o.id, o]));
    for (const l of lines) {
      const o = byId.get(l.optionId)!;
      if (o.product.status !== "ON_SALE" || o.product.deletedAt) return { ok: false as const, reason: "product_unavailable" as const };
      if (o.stock < l.quantity) return { ok: false as const, reason: "out_of_stock" as const };
    }

    // 금액은 서버 값으로만: 단가 = 상품 가격 + 옵션 추가금(이벤트 할인 기간이면 할인 뒤 단가), 합계 = 단가 × 수량 + 배송비 − 쿠폰 − 적립금.
    // 단가가 1원 미만이거나 합계가 저장 범위(INT4)를 넘으면 주문을 만들지 않는다(500 대신 invalid_amount).
    const priced = lines.map((l) => {
      const o = byId.get(l.optionId)!;
      // 이벤트 할인 기간(시작 ≤ 지금 < 종료, 잠금 뒤 DB 시계)이면 할인 뒤 단가, 아니면 정가. 정가는 listUnitPrice로 남긴다.
      const listUnitPrice = o.product.price + o.priceDelta;
      return { line: l, option: o, listUnitPrice, unitPrice: orderUnitPrice(listUnitPrice, eventOf(o.product), now) };
    });
    if (priced.some((p) => p.unitPrice < 1)) return { ok: false as const, reason: "invalid_amount" as const };
    const itemsSubtotal = priced.reduce((sum, p) => sum + p.unitPrice * p.line.quantity, 0);
    const policy = await getShippingPolicy(tx, input.sellerId);
    const isRemote = isRemoteAddress(address.zipCode, address.address1, policy.remoteZipRanges);
    const shippingFee = computeShippingFee(itemsSubtotal, policy, isRemote);
    // 쿠폰 할인(서버 계산). 배송비 무료 쿠폰도 배송비(shippingFee)는 그대로 남기고 할인 금액으로 뺀다.
    const coupon = await quoteOrderCoupon(tx, {
      sellerId: input.sellerId,
      buyerMemberId: member.id,
      couponId: input.couponId,
      now,
      lines: priced.map((p) => ({ key: p.option.id, productId: p.option.productId, unitPrice: p.unitPrice, listUnitPrice: p.listUnitPrice, quantity: p.line.quantity })),
      shippingFee,
    });
    if (!coupon.ok) return { ok: false as const, reason: coupon.reason };
    const couponDiscount = coupon.applied?.discountAmount ?? 0;
    const rewardLimit = rewardUseLimit({ itemsSubtotal, shippingFee, couponDiscount, couponIsShipping: coupon.applied?.benefit === "FREE_SHIPPING" });
    const totalAmount = itemsSubtotal + shippingFee - couponDiscount - rewardUse;
    if (!Number.isSafeInteger(totalAmount) || totalAmount > INT4_MAX) return { ok: false as const, reason: "invalid_amount" as const };

    // 입금 기한: 주문 시각 + 판매자 설정(기본 사용·10일). 자동 취소를 끈 쇼핑몰은 기한을 두지 않는다. 이미 만든 주문은 설정을 바꿔도 그대로다.
    const orderPolicy = await getOrderPolicy(tx, input.sellerId);
    const paymentDueAt = orderPolicy.autoCancelEnabled ? new Date(now.getTime() + orderPolicy.paymentDueHours * 60 * 60 * 1000) : null;
    const last = await tx.order.aggregate({ where: { sellerId: input.sellerId }, _max: { orderNo: true } });
    const orderNo = (last._max.orderNo ?? 0) + 1;
    const order = await tx.order.create({
      data: {
        sellerId: input.sellerId,
        orderNo,
        buyerMemberId: member.id,
        status: "PENDING_PAYMENT",
        broadcastNicknameSnapshot: orderNickname ?? member.broadcastNickname,
        totalAmount,
        shippingFee,
        returnFeeSnapshot: policy.returnFee,
        fulfillmentType: "IMMEDIATE",
        rewardUsedAmount: 0, // 적립금을 쓰면 아래 useRewardForOrder가 잔액을 뺀 뒤 기록한다
        createdAt: now,
        paymentDueAt,
      },
    });
    // 적립금 사용: 주문 잠금 → 회원(위 FOR SHARE) → 잔액 행 순서. 안 되면 이 트랜잭션 전체를 되돌린다(주문 없음).
    const rewardFailure = await useRewardForOrder(tx, { sellerId: input.sellerId, buyerMemberId: member.id, orderId: order.id, amount: rewardUse, limit: rewardLimit, now });
    if (rewardFailure) throw new RewardUseRejected(rewardFailure);
    if (coupon.applied) await useOrderCoupon(tx, { sellerId: input.sellerId, buyerMemberId: member.id, orderId: order.id, applied: coupon.applied, now });
    await tx.orderShippingAddress.create({ data: { sellerId: input.sellerId, orderId: order.id, ...address, isRemote } });
    await recordOrderAddress(tx, { sellerId: input.sellerId, buyerMemberId: member.id }, address, input.saveAddress !== false, now);
    await tx.orderItem.createMany({
      data: priced.map((p) => ({
        sellerId: input.sellerId,
        orderId: order.id,
        productId: p.option.productId,
        optionId: p.option.id,
        productNameSnapshot: p.option.product.name,
        optionNameSnapshot: p.option.name,
        unitPrice: p.unitPrice,
        listUnitPrice: p.listUnitPrice,
        quantity: p.line.quantity,
      })),
    });
    // 주문 때 차감(ORDER) 상품은 지금 뺀다. 조건부 UPDATE라 동시 주문·결제 차감과 겹쳐도 음수가 되지 않고,
    // 모자라면 이 트랜잭션 전체를 되돌린다(주문 없음, out_of_stock).
    for (const p of priced.filter((x) => x.option.product.stockDeductMode === "ORDER")) {
      const dec = await tx.productOption.updateMany({
        where: { id: p.option.id, sellerId: input.sellerId, stock: { gte: p.line.quantity } },
        data: { stock: { decrement: p.line.quantity } },
      });
      if (dec.count !== 1) throw new OutOfStockAtOrder();
      await tx.stockMovement.create({
        data: { sellerId: input.sellerId, optionId: p.option.id, delta: -p.line.quantity, reason: "ORDER", orderId: order.id, actorType: "BUYER", actorId: member.id, createdAt: now },
      });
      await tx.orderItem.updateMany({ where: { orderId: order.id, optionId: p.option.id }, data: { stockDeductedAt: now } });
    }
    await tx.orderConsent.create({
      data: {
        sellerId: input.sellerId,
        orderId: order.id,
        kind: OPENED_NO_REFUND_CONSENT.kind,
        noticeVersion: OPENED_NO_REFUND_CONSENT.version,
        agreedAt: now,
      },
    });
    await tx.orderStatusHistory.create({
      data: { sellerId: input.sellerId, orderId: order.id, fromStatus: null, toStatus: "PENDING_PAYMENT", actorType: "BUYER", actorId: member.id, createdAt: now },
    });
    await writeAudit(tx, {
      actorType: "BUYER",
      actorId: member.id,
      sellerId: input.sellerId,
      action: "order.create",
      targetType: "Order",
      targetId: order.id,
      after: { orderNo, totalAmount, shippingFee, lines: lines.length, consentVersion: OPENED_NO_REFUND_CONSENT.version },
      ip: input.meta?.ip,
      userAgent: input.meta?.userAgent,
    });
    return { ok: true as const, orderId: order.id, orderNo, totalAmount, shippingFee };
  });
}
