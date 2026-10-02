import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { dbNow, sellerAccessFor } from "../billing/subscription";
import { OPENED_NO_REFUND_CONSENT } from "./consent";
import { computeShippingFee, getShippingPolicy, INT4_MAX, isRemoteZip, parseShippingAddress } from "./shipping";

// 구매자 주문 생성(결제 대기까지). 실제 PG 결제 호출은 없다.
// - 결제 전 「개봉하면 취소·환불이 안 돼요」 동의 필수(체크 기본 해제, 동의 없으면 주문을 만들지 않음). 동의 시각(DB 시계)·문구 버전을 기록.
// - 잠긴 판매자(체험하기·구독 끝)는 새 주문을 받지 않는다.
// - 금액은 서버가 상품·옵션 가격으로 계산한다. 화면이 보낸 금액은 받지 않는다.
// - 재고는 주문 수량만큼 있는지 확인한다(차감은 결제 때, 선점 없음 — 대표님 확정, ARCHITECTURE 4.4).
// - 즉시 발송: 배송지는 주문 때 받아 스냅숏으로 남기고, 배송비는 판매자 배송비 설정으로 계산한다(shipping.ts).
// - 적립금 사용은 방식이 정해지기 전이라 받지 않는다(요청이 오면 거부).

export const MAX_ORDER_LINES = 20;
export const MAX_LINE_QUANTITY = 99;

export type CreateOrderInput = {
  sellerId: string;
  buyerMemberId: string;
  items: unknown;
  consent: { agreed?: unknown; noticeVersion?: unknown } | undefined;
  rewardUseAmount?: unknown;
  shippingAddress: unknown;
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
  | "invalid_shipping_address"
  | "invalid_amount"; // 단가 1원 미만(음수 추가금 등)·합계가 정수 범위를 넘음

export type CreateOrderResult =
  | { ok: true; orderId: string; orderNo: number; totalAmount: number; shippingFee: number }
  | { ok: false; reason: CreateOrderFailure };

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

export async function createOrder(db: PrismaClient, input: CreateOrderInput): Promise<CreateOrderResult> {
  // 판매자: 운영 중이고 잠기지 않았어야 한다(이용 판단은 DB 시계)
  const seller = await db.seller.findUnique({ where: { id: input.sellerId }, select: { status: true } });
  if (!seller || seller.status !== "ACTIVE" || (await sellerAccessFor(db, input.sellerId)) === "expired") {
    return { ok: false, reason: "shop_unavailable" };
  }
  if (input.consent?.agreed !== true) return { ok: false, reason: "consent_required" };
  if (input.consent.noticeVersion !== OPENED_NO_REFUND_CONSENT.version) return { ok: false, reason: "consent_outdated" };
  if (input.rewardUseAmount !== undefined && input.rewardUseAmount !== 0) return { ok: false, reason: "reward_use_not_supported" };
  const lines = parseItems(input.items);
  if (!lines) return { ok: false, reason: "invalid_items" };
  const address = parseShippingAddress(input.shippingAddress);
  if (!address) return { ok: false, reason: "invalid_shipping_address" };

  return db.$transaction(async (tx) => {
    // 같은 판매자의 주문 번호를 한 줄로 매긴다
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`order_no:${input.sellerId}`}))`;
    const now = await dbNow(tx);
    const member = await tx.buyerMember.findFirst({
      where: { id: input.buyerMemberId, sellerId: input.sellerId, status: "ACTIVE", deletedAt: null },
      select: { id: true, broadcastNickname: true },
    });
    if (!member) return { ok: false as const, reason: "shop_unavailable" as const };

    const options = await tx.productOption.findMany({
      where: { sellerId: input.sellerId, id: { in: lines.map((l) => l.optionId) } },
      include: { product: true },
    });
    if (options.length !== lines.length) return { ok: false as const, reason: "product_unavailable" as const };
    const byId = new Map(options.map((o) => [o.id, o]));
    for (const l of lines) {
      const o = byId.get(l.optionId)!;
      if (o.product.status !== "ON_SALE" || o.product.deletedAt) return { ok: false as const, reason: "product_unavailable" as const };
      if (o.stock < l.quantity) return { ok: false as const, reason: "out_of_stock" as const };
    }

    // 금액은 서버 값으로만: 단가 = 상품 가격 + 옵션 추가금, 합계 = 단가 × 수량 + 배송비. 적립금 사용 없음.
    // 단가가 1원 미만이거나 합계가 저장 범위(INT4)를 넘으면 주문을 만들지 않는다(500 대신 invalid_amount).
    const priced = lines.map((l) => {
      const o = byId.get(l.optionId)!;
      return { line: l, option: o, unitPrice: o.product.price + o.priceDelta };
    });
    if (priced.some((p) => p.unitPrice < 1)) return { ok: false as const, reason: "invalid_amount" as const };
    const itemsSubtotal = priced.reduce((sum, p) => sum + p.unitPrice * p.line.quantity, 0);
    const policy = await getShippingPolicy(tx, input.sellerId);
    const isRemote = isRemoteZip(address.zipCode, policy.remoteZipRanges);
    const shippingFee = computeShippingFee(itemsSubtotal, policy, isRemote);
    const totalAmount = itemsSubtotal + shippingFee;
    if (!Number.isSafeInteger(totalAmount) || totalAmount > INT4_MAX) return { ok: false as const, reason: "invalid_amount" as const };

    const last = await tx.order.aggregate({ where: { sellerId: input.sellerId }, _max: { orderNo: true } });
    const orderNo = (last._max.orderNo ?? 0) + 1;
    const order = await tx.order.create({
      data: {
        sellerId: input.sellerId,
        orderNo,
        buyerMemberId: member.id,
        status: "PENDING_PAYMENT",
        broadcastNicknameSnapshot: member.broadcastNickname,
        totalAmount,
        shippingFee,
        fulfillmentType: "IMMEDIATE",
        rewardUsedAmount: 0,
        createdAt: now,
      },
    });
    await tx.orderShippingAddress.create({ data: { sellerId: input.sellerId, orderId: order.id, ...address, isRemote } });
    await tx.orderItem.createMany({
      data: priced.map((p) => ({
        sellerId: input.sellerId,
        orderId: order.id,
        productId: p.option.productId,
        optionId: p.option.id,
        productNameSnapshot: p.option.product.name,
        optionNameSnapshot: p.option.name,
        unitPrice: p.unitPrice,
        quantity: p.line.quantity,
      })),
    });
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
