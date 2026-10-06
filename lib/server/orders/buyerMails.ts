import type { Prisma, PrismaClient } from "@prisma/client";
import { mailSender } from "../mail/registry";
import { sendMail, type MailSender } from "../mail/quota";
import { cancelledMail, deliveredMail, orderCompletedMail, shippedMail, type CancelledInput, type OrderBase, type ShopMailBrand } from "../mail/templates";
import { businessView } from "../shop-legal/notice";
import { orderNoLabel } from "./orderNoLabel";

// 구매자 거래 메일 발송(디자인 EM-001 주문 완료 · EM-002 발송 · EM-003 배송 완료 · EM-004 취소·환불, 정기 작업 order_mail.send_buyer_mails).
// 주문 상태를 바꾸는 코드는 고치지 않고, 이미 남은 기록(Order.paidAt·Shipment.shippedAt·deliveredAt·OrderRefund)을 읽어 보낸다(읽기 전용).
// - 대상: 최근 24시간 안에 일어난 일만(처음 켤 때 옛 주문에 한꺼번에 보내지 않는다). 매시간 도는 작업이라 최대 1시간 늦을 수 있다.
//   order.pending_bank 무통장 주문 접수(입금 대기) · order.paid 결제 확인 · order.shipped 발송 · order.delivered 배송 완료 · order.refund 환불(부분·전체, OrderRefund 한 건마다 한 통).
// - 같은 일은 한 번만: 발송 기록(MailDelivery kind + refId)이 있으면 다시 보내지 않는다(주문·종류별 advisory 잠금, 동시 실행도 한 통).
//   제공량·충전 잔액에 걸려 못 보낸 건(SKIPPED_BALANCE)·실패한 건도 기록이 남아 다시 보내지 않는다.
// - 비용(docs/COST_POLICY.md): 파트너스의 월 제공량 안에서는 무료, 넘으면 발송·이용 충전금에서 차감(mail/quota.ts, 발송 기록 id 멱등), 잔액이 없으면 그 메일만 건너뛰고 주문 처리는 그대로다.
// - 수신자: 구매자 로그인 아이디(= 가입 이메일). 이메일 모양이 아니면 건너뛴다. 파트너스가 SA-080에서 끈 종류는 보내지 않는다.
// - 공급자 없음·APP_ORIGIN 없음(링크를 만들 수 없음)이면 아무것도 보내지 않고 기록하지 않는다.
export const LOOKBACK_MS = 24 * 3600_000;
const BATCH = 100;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Kind = "order.pending_bank" | "order.paid" | "order.shipped" | "order.delivered" | "order.refund";
type Policy = { orderCompleteEnabled: boolean; shippedEnabled: boolean; deliveredEnabled: boolean; cancelRefundEnabled: boolean };
const ALLOWED: Record<Kind, keyof Policy> = { "order.pending_bank": "orderCompleteEnabled", "order.paid": "orderCompleteEnabled", "order.shipped": "shippedEnabled", "order.delivered": "deliveredEnabled", "order.refund": "cancelRefundEnabled" };

const ORDER_INCLUDE = {
  items: { orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }] },
  shippingAddress: true,
  shipment: true,
  buyerMember: { select: { loginId: true, broadcastNickname: true } },
  seller: { select: { id: true, slug: true, shopName: true, businessInfo: true, brandColor: { select: { color: true } } } },
} satisfies Prisma.OrderInclude;
type OrderRow = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

export async function sendBuyerOrderMails(db: PrismaClient, now: Date, opts: { sender?: MailSender | null } = {}): Promise<number> {
  const sender = opts.sender === undefined ? mailSender() : opts.sender;
  const origin = process.env.APP_ORIGIN?.replace(/\/+$/, "");
  if (!sender || !origin) return 0;
  const since = new Date(now.getTime() - LOOKBACK_MS);

  const [pending, paid, shipped, delivered, refunds] = await Promise.all([
    db.order.findMany({ where: { status: "PENDING_PAYMENT", paymentMethod: "BANK_TRANSFER", createdAt: { gte: since }, paymentDueAt: { gt: now } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: BATCH, include: ORDER_INCLUDE }),
    db.order.findMany({ where: { status: "PAID", paidAt: { gte: since, lte: now } }, orderBy: [{ paidAt: "asc" }, { id: "asc" }], take: BATCH, include: ORDER_INCLUDE }),
    db.order.findMany({ where: { status: "PAID", shipment: { is: { shippedAt: { gte: since, lte: now } } } }, orderBy: [{ id: "asc" }], take: BATCH, include: ORDER_INCLUDE }),
    db.order.findMany({ where: { shipment: { is: { deliveredAt: { gte: since, lte: now } } } }, orderBy: [{ id: "asc" }], take: BATCH, include: ORDER_INCLUDE }),
    db.orderRefund.findMany({ where: { createdAt: { gte: since, lte: now } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: BATCH }),
  ]);
  const refundOrders = refunds.length ? await db.order.findMany({ where: { id: { in: [...new Set(refunds.map((r) => r.orderId))] } }, include: ORDER_INCLUDE }) : [];
  const refundOrderById = new Map(refundOrders.map((o) => [o.id, o]));

  const sellerIds = [...new Set([...pending, ...paid, ...shipped, ...delivered, ...refundOrders].map((o) => o.sellerId))];
  if (sellerIds.length === 0) return 0;
  const [policies, legals, banks] = await Promise.all([
    db.sellerOrderNotificationPolicy.findMany({ where: { sellerId: { in: sellerIds } } }),
    db.shopLegalNotice.findMany({ where: { sellerId: { in: sellerIds } }, select: { sellerId: true, address: true, csPhone: true, csEmail: true } }),
    db.sellerBankAccount.findMany({ where: { sellerId: { in: sellerIds } } }),
  ]);
  const policyOf = (sellerId: string): Policy => policies.find((p) => p.sellerId === sellerId) ?? { orderCompleteEnabled: true, shippedEnabled: true, deliveredEnabled: true, cancelRefundEnabled: true };
  const host = origin.replace(/^https?:\/\//, "");

  const brandOf = (o: OrderRow): ShopMailBrand => {
    const b = businessView(o.seller.businessInfo);
    const l = legals.find((x) => x.sellerId === o.sellerId);
    return {
      shopName: o.seller.shopName,
      shopUrl: `${host}/shop/${o.seller.slug}`,
      color: o.seller.brandColor?.color ?? null,
      business: { name: b.companyName ?? "", representative: b.representativeName ?? "", businessNumber: b.businessNumber ?? "", mailOrderNumber: b.mailOrderNumber ?? "", address: l?.address ?? "", phone: l?.csPhone ?? "", email: l?.csEmail ?? "" },
    };
  };
  const baseOf = (o: OrderRow): OrderBase => ({
    brand: brandOf(o),
    nickname: o.broadcastNicknameSnapshot,
    orderNoLabel: orderNoLabel(o.createdAt, o.orderNo),
    orderedAt: o.createdAt,
    orderUrl: `${origin}/shop/${o.seller.slug}/orders/${o.id}`,
    lines: o.items.map((i) => ({ name: i.optionNameSnapshot ? `${i.productNameSnapshot} · ${i.optionNameSnapshot}` : i.productNameSnapshot, quantity: i.quantity, amount: i.unitPrice * i.quantity })),
    shippingFee: o.shippingFee,
    rewardUsed: o.rewardUsedAmount,
    total: o.totalAmount,
  });
  const receiverOf = (o: OrderRow) => {
    const a = o.shippingAddress;
    return { name: a?.recipientName ?? "", phone: a?.phone ?? "", address: [a?.address1, a?.address2].filter(Boolean).join(" "), memo: a?.memo ?? null };
  };
  const payLabel = (o: OrderRow) => (o.paymentMethod === "BANK_TRANSFER" ? "무통장 입금" : "카드");

  let n = 0;
  const deliver = async (o: OrderRow, kind: Kind, refId: string, build: () => { subject: string; text: string; html: string } | null) => {
    const to = o.buyerMember.loginId;
    if (!EMAIL.test(to) || !policyOf(o.sellerId)[ALLOWED[kind]]) return;
    await db.$transaction(
      async (tx) => {
        const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('buyer_mail'), hashtext(${`${kind}:${refId}`})) AS "locked"`;
        if (!locked) return;
        if (await tx.mailDelivery.findFirst({ where: { kind, refId }, select: { id: true } })) return;
        const message = build();
        if (!message) return;
        const r = await sendMail(db, sender, { sellerId: o.sellerId, kind, refId, message: { to, ...message } });
        if (r.status === "SENT") n++;
      },
      { timeout: 30_000 },
    );
  };

  for (const o of pending) {
    const bank = banks.find((b) => b.sellerId === o.sellerId);
    await deliver(o, "order.pending_bank", o.id, () =>
      bank && o.paymentDueAt ? orderCompletedMail({ ...baseOf(o), payment: "BANK_TRANSFER", bankName: bank.bankName, accountNumber: bank.accountNumber, accountHolder: bank.accountHolder, dueAt: o.paymentDueAt, receiver: receiverOf(o) }) : null,
    );
  }
  for (const o of paid) await deliver(o, "order.paid", o.id, () => orderCompletedMail({ ...baseOf(o), payment: "CARD", paymentLabel: payLabel(o), receiver: receiverOf(o) }));
  for (const o of shipped) {
    const s = o.shipment;
    await deliver(o, "order.shipped", o.id, () => (s ? shippedMail({ ...baseOf(o), carrier: s.courier, trackingNo: s.trackingNumber, shippedAt: s.shippedAt, receiver: receiverOf(o) }) : null));
  }
  for (const o of delivered) await deliver(o, "order.delivered", o.id, () => deliveredMail({ ...baseOf(o), rewardEarned: o.rewardEarnTiming === "ON_DELIVERY" ? o.rewardEarnAmount : null }));
  for (const r of refunds) {
    const o = refundOrderById.get(r.orderId);
    if (!o) continue;
    await deliver(o, "order.refund", `${r.orderId}:${r.seq}`, () => {
      const base = baseOf(o);
      const common = { ...base, paymentLabel: payLabel(o), refund: (o.paymentMethod === "BANK_TRANSFER" ? { kind: "BANK" } : { kind: "CARD", label: "카드" }) as CancelledInput["refund"], rewardReturned: r.rewardReturn };
      // 마지막 환불(isFinal)은 「주문을 취소했어요」, 아직 남은 품목이 있으면 이번에 환불한 품목만 취소로·남은 품목은 환불 수량을 뺀 나머지로 안내한다
      if (r.isFinal) return cancelledMail({ ...common, kind: "FULL", reason: r.reason, refundAmount: r.refundAmount });
      const refunded = (r.items as { orderItemId: string; quantity: number; amount: number }[]) ?? [];
      const cancelledLines = refunded.map((x) => ({ item: o.items.find((i) => i.id === x.orderItemId), x })).filter((z) => z.item).map((z) => ({ name: z.item!.productNameSnapshot, quantity: z.x.quantity, amount: z.x.amount }));
      const remainingLines = o.items.filter((i) => i.quantity - i.refundedQuantity > 0).map((i) => ({ name: i.productNameSnapshot, quantity: i.quantity - i.refundedQuantity, amount: i.unitPrice * (i.quantity - i.refundedQuantity) }));
      const remainingTotal = remainingLines.reduce((s, l) => s + l.amount, 0);
      return cancelledMail({ ...common, kind: "PARTIAL", cancelledLines, refundAmount: r.refundAmount, remainingLines, remainingTotal });
    });
  }
  return n;
}
