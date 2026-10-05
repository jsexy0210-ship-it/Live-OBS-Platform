import { Prisma, type Payment, type PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { sellerHasFeature } from "../billing/features";
import { sellerAccessFor } from "../billing/subscription";
import { lockSellerOrders } from "../orders/overdue";
import { markOrderPaid } from "../queue/service";
import type { AuthResult, PaymentGateway, PgPayment } from "./gateway";

// 구매자 주문 카드 결제(나이스페이 서버 승인 모델, 테스트 결제). ARCHITECTURE 4.5 「결제(PG)」.
// 흐름: 결제 시작(READY) → 결제 창 인증 → returnUrl → 승인 잡기(APPROVING, 같은 주문은 하나만) → PG 승인 → PAID → 주문 결제 완료(markOrderPaid).
// - 금액은 서버가 주문 품목·배송비·쿠폰·적립금으로 다시 계산한 값만 쓴다. 인증 결과·승인 응답 금액이 다르면 승인하지 않는다.
// - 같은 결제(tid)·같은 주문을 두 번 승인하지 않는다(pgTid 유니크 + 주문별 부분 유니크 인덱스 + READY → APPROVING 조건 갱신).
// - 승인 응답을 못 받으면(타임아웃) 매뉴얼대로 망 취소하고, 망 취소도 모르면 APPROVING으로 두고 조회(reconcilePayment)로 확정한다.
// - 승인됐는데 그사이 주문이 취소됐으면(입금 기한 자동 취소 등) 전액 취소를 요청한다.
// - 환불은 refundOrder 트랜잭션에서 취소 요청(PaymentCancel)만 남기고, PG 취소는 커밋 뒤 processPaymentCancel이 한다.

type Tx = Prisma.TransactionClient;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYSTEM = { actorType: "SYSTEM" as const, actorId: null };
// 같은 취소 요청을 다시 시도하기 전 기다리는 시간(동시에 두 번 PG를 부르지 않게)
export const CANCEL_RETRY_AFTER_MS = 60_000;

export type StartRejection = "shop_unavailable" | "not_found" | "order_not_payable" | "already_paid" | "amount_mismatch";
export type StartResult =
  | { ok: true; paymentId: string; clientId: string; method: "card"; orderId: string; amount: number; goodsName: string; paymentDueAt: Date | null }
  | { ok: false; reason: StartRejection };

export type ConfirmOutcome = "paid" | "failed" | "pending" | "cancelled";
export type ConfirmResult = { ok: true; outcome: ConfirmOutcome; sellerId: string; orderId: string } | { ok: false; reason: "not_found" | "invalid_signature" };

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

// 결제할 금액(서버 계산): 품목 단가 × 수량 + 배송비 − 쿠폰 할인 − 적립금 사용. 주문을 만들 때 저장한 totalAmount와 같아야 한다.
export function payableAmount(o: { items: { unitPrice: number; quantity: number }[]; shippingFee: number; rewardUsedAmount: number; couponRedemption: { discountAmount: number } | null }) {
  return o.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0) + o.shippingFee - (o.couponRedemption?.discountAmount ?? 0) - o.rewardUsedAmount;
}

// 결제 창 상품명(나이스페이 40바이트 제한, 한글 3바이트)
export function goodsNameOf(items: { productNameSnapshot: string }[]) {
  const first = items[0]?.productNameSnapshot ?? "주문 상품";
  const suffix = items.length > 1 ? ` 외 ${items.length - 1}건` : "";
  let name = first;
  while (Buffer.byteLength(name + suffix, "utf8") > 40) name = name.slice(0, -1);
  return name + suffix;
}

// 주문 생성과 같은 조건: 운영 중이고 잠기지 않았고 스토어 운영 기능 권한이 있어야 결제(카드·무통장 선택)할 수 있다
export async function shopOpenForPayment(db: PrismaClient, sellerId: string): Promise<boolean> {
  const seller = await db.seller.findUnique({ where: { id: sellerId }, select: { status: true } });
  return !!seller && seller.status === "ACTIVE" && (await sellerAccessFor(db, sellerId)) !== "expired" && (await sellerHasFeature(db, sellerId, "STORE_OPERATIONS"));
}

export async function startPayment(
  db: PrismaClient,
  gw: PaymentGateway,
  input: { sellerId: string; buyerMemberId: string; orderId: string; now?: Date },
): Promise<StartResult> {
  if (!UUID.test(input.orderId)) return { ok: false, reason: "not_found" };
  const now = input.now ?? new Date();
  if (!(await shopOpenForPayment(db, input.sellerId))) return { ok: false, reason: "shop_unavailable" };
  const order = await db.order.findFirst({
    where: { id: input.orderId, sellerId: input.sellerId, buyerMemberId: input.buyerMemberId, legalHoldAt: null },
    include: { items: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] }, couponRedemption: { select: { discountAmount: true } } },
  });
  if (!order) return { ok: false, reason: "not_found" };
  if (await db.payment.findFirst({ where: { orderId: order.id, status: { in: ["APPROVING", "PAID", "PARTIAL_CANCELLED"] } }, select: { id: true } }))
    return { ok: false, reason: "already_paid" };
  if (order.status !== "PENDING_PAYMENT" || (order.paymentDueAt && order.paymentDueAt <= now)) return { ok: false, reason: "order_not_payable" };
  const amount = payableAmount(order);
  if (amount < 1 || amount !== order.totalAmount) return { ok: false, reason: "amount_mismatch" };
  const payment = await db.payment.create({ data: { sellerId: order.sellerId, orderId: order.id, provider: gw.name, method: "CARD", amount } });
  return { ok: true, paymentId: payment.id, clientId: gw.clientId, method: "card", orderId: payment.id, amount, goodsName: goodsNameOf(order.items), paymentDueAt: order.paymentDueAt };
}

async function fail(db: PrismaClient | Tx, p: Payment, code: string, from: ("READY" | "APPROVING")[] = ["READY", "APPROVING"]) {
  const moved = await db.payment.updateMany({ where: { id: p.id, status: { in: from } }, data: { status: "FAILED", failureCode: code.slice(0, 60) } });
  if (moved.count === 1) await writeAudit(db, { ...SYSTEM, sellerId: p.sellerId, action: "payment.failed", targetType: "Order", targetId: p.orderId, after: { paymentId: p.id, code } });
}

// returnUrl로 받은 결제 창 인증 결과 처리. 세션 쿠키 없이 오므로(PG에서 넘어오는 POST) 서명과 결제 행으로만 판단한다.
export async function confirmAuthResult(db: PrismaClient, gw: PaymentGateway, r: AuthResult): Promise<ConfirmResult> {
  if (!UUID.test(r.orderId)) return { ok: false, reason: "not_found" };
  const p = await db.payment.findUnique({ where: { id: r.orderId } });
  if (!p || p.provider !== gw.name) return { ok: false, reason: "not_found" };
  const done = (outcome: ConfirmOutcome): ConfirmResult => ({ ok: true, outcome, sellerId: p.sellerId, orderId: p.orderId });
  // 인증 실패 결과에는 서명이 없다(매뉴얼). 서명 없는 값으로 상태를 바꾸지 않는다: READY는 그대로 두고(버리는 시도) 지금 상태만 알린다.
  if (r.authResultCode !== "0000") return done(p.status === "READY" ? "failed" : outcomeOf(p));
  if (!gw.verifyAuthResult(r)) return { ok: false, reason: "invalid_signature" };
  if (!/^\d+$/.test(r.amount) || Number(r.amount) !== p.amount || !r.tid) {
    await fail(db, p, "amount_mismatch", ["READY"]);
    return done("failed");
  }
  return done(await approvePayment(db, gw, p.id, r.tid));
}

// 승인을 잡는다(READY → APPROVING). 주문이 결제 대기가 아니거나 같은 주문의 다른 결제가 이미 잡았으면 승인하지 않는다.
async function claimApproval(db: PrismaClient, p: Payment, tid: string): Promise<"claimed" | "order_not_payable" | "duplicate" | "taken"> {
  try {
    return await db.$transaction(async (tx) => {
      await lockSellerOrders(tx, p.sellerId);
      const order = await tx.order.findUniqueOrThrow({ where: { id: p.orderId }, select: { status: true } });
      if (order.status !== "PENDING_PAYMENT") return "order_not_payable" as const;
      const moved = await tx.payment.updateMany({ where: { id: p.id, status: "READY" }, data: { status: "APPROVING", pgTid: tid } });
      return moved.count === 1 ? ("claimed" as const) : ("taken" as const);
    });
  } catch (e) {
    if (isUniqueViolation(e)) return "duplicate";
    throw e;
  }
}

export async function approvePayment(db: PrismaClient, gw: PaymentGateway, paymentId: string, tid: string): Promise<ConfirmOutcome> {
  const p = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
  // 이미 처리한 결제(같은 인증 결과 재전송·새로 고침)는 지금 상태를 돌려준다
  if (p.status !== "READY") return outcomeOf(p);
  const claim = await claimApproval(db, p, tid);
  if (claim === "order_not_payable") {
    await fail(db, p, "order_not_payable", ["READY"]);
    return outcomeOf(await db.payment.findUniqueOrThrow({ where: { id: p.id } }));
  }
  if (claim === "duplicate") {
    // 같은 tid가 이미 다른 결제에 있거나, 같은 주문의 다른 결제가 승인 중·완료다. 이 결제는 승인하지 않는다(PG 인증만 된 거래는 돈이 안 움직인다).
    await fail(db, p, "duplicate_payment", ["READY"]);
    return outcomeOf(await db.payment.findUniqueOrThrow({ where: { id: p.id } }));
  }
  if (claim === "taken") return outcomeOf(await db.payment.findUniqueOrThrow({ where: { id: p.id } }));

  const r = await gw.approve({ tid, amount: p.amount });
  const claimed = { ...p, status: "APPROVING" as const, pgTid: tid };
  if (r.kind === "ok") return applyPgPayment(db, gw, claimed, r.value);
  if (r.kind === "rejected") {
    await fail(db, claimed, r.code, ["APPROVING"]);
    return "failed";
  }
  // 승인 응답을 모름: 매뉴얼대로 망 취소. 망 취소 결과도 모르면 APPROVING으로 두고 조회로 확정한다.
  const net = await gw.netCancel(p.id);
  if (net.kind === "ok") {
    await fail(db, claimed, "approve_timeout", ["APPROVING"]);
    return "failed";
  }
  return "pending";
}

function outcomeOf(p: Payment): ConfirmOutcome {
  if (p.status === "PAID" || p.status === "PARTIAL_CANCELLED") return "paid";
  if (p.status === "CANCELLED") return "cancelled";
  if (p.status === "APPROVING") return "pending";
  return "failed";
}

// PG가 알려 준 결제 상태를 APPROVING 결제에 반영한다(승인 응답·조회·웹훅 공통).
async function applyPgPayment(db: PrismaClient, gw: PaymentGateway, p: Payment, pg: PgPayment): Promise<ConfirmOutcome> {
  if (pg.tid !== p.pgTid || pg.orderId !== p.id) {
    await fail(db, p, "pg_mismatch", ["APPROVING"]);
    return "failed";
  }
  if (pg.status === "ready") return "pending";
  if (pg.status !== "paid") {
    await fail(db, p, `pg_${pg.status}`, ["APPROVING"]);
    return "failed";
  }
  if (pg.amount !== p.amount) {
    // 서명은 맞는데 금액이 다르다: 결제를 인정하지 않고 PG 쪽 결제를 전액 취소한다(취소 결과는 로그 추적에 남겨 사람이 확인).
    const c = await gw.cancel({ tid: pg.tid, cancelOrderId: `${p.id}-mismatch`, amount: pg.amount, partial: false, reason: "amount_mismatch" });
    await fail(db, p, c.kind === "ok" ? "amount_mismatch" : "amount_mismatch_cancel_unconfirmed", ["APPROVING"]);
    return "failed";
  }
  const moved = await db.payment.updateMany({ where: { id: p.id, status: "APPROVING" }, data: { status: "PAID", approvedAt: new Date() } });
  if (moved.count === 1)
    await writeAudit(db, { ...SYSTEM, sellerId: p.sellerId, action: "payment.approved", targetType: "Order", targetId: p.orderId, after: { paymentId: p.id, provider: p.provider, amount: p.amount } });
  return settleOrder(db, gw, await db.payment.findUniqueOrThrow({ where: { id: p.id } }));
}

// 결제 완료된 결제를 주문에 반영한다. 여러 번 불러도 같다(주문이 이미 결제 완료면 그대로).
// 주문이 그사이 취소됐으면 결제를 전액 취소한다.
export async function settleOrder(db: PrismaClient, gw: PaymentGateway, p: Payment): Promise<ConfirmOutcome> {
  if (p.status !== "PAID") return outcomeOf(p);
  let order = await db.order.findUniqueOrThrow({ where: { id: p.orderId }, select: { status: true, pgTxId: true, paymentMethod: true } });
  if (order.status === "PENDING_PAYMENT") {
    const r = await markOrderPaid(db, { sellerId: p.sellerId, orderId: p.orderId, paymentMethod: "CARD" });
    if (r.ok) {
      await db.order.updateMany({ where: { id: p.orderId, sellerId: p.sellerId }, data: { pgProvider: p.provider, pgTxId: p.pgTid } });
      return "paid";
    }
    // 그사이 상태가 바뀌었다(자동 취소 등). 다시 읽어 판단하고, 그래도 결제 대기면 다음 확정(정기 실행·웹훅)에 맡긴다.
    order = await db.order.findUniqueOrThrow({ where: { id: p.orderId }, select: { status: true, pgTxId: true, paymentMethod: true } });
    if (order.status === "PENDING_PAYMENT") throw new Error(`order_settle_failed:${r.reason}`);
  }
  // 주문이 이 카드 결제로 결제된 것이 아니다(그사이 판매자가 무통장 입금을 확인함): 카드 결제는 전액 돌려준다(이중 결제 방지).
  const paidByThis = order.paymentMethod === "CARD" && (order.pgTxId === null || order.pgTxId === p.pgTid);
  if ((order.status === "PAID" || order.status === "REFUNDED") && !paidByThis) {
    await requestCancelAndRun(db, gw, p, p.amount, "paid_by_other");
    return "cancelled";
  }
  if (order.status === "PAID" || order.status === "REFUNDED") {
    if (order.status === "PAID" && !order.pgTxId) await db.order.updateMany({ where: { id: p.orderId, pgTxId: null }, data: { pgProvider: p.provider, pgTxId: p.pgTid } });
    return "paid";
  }
  // 주문이 취소됐다(입금 기한 자동 취소·판매자 취소): 받은 돈을 돌려준다.
  await requestCancelAndRun(db, gw, p, p.amount, "order_cancelled");
  return "cancelled";
}

async function requestCancelAndRun(db: PrismaClient, gw: PaymentGateway, p: Payment, amount: number, reason: string) {
  const key = `system:${reason}`;
  const existing = await db.paymentCancel.findUnique({ where: { paymentId_idempotencyKey: { paymentId: p.id, idempotencyKey: key } } });
  const c = existing ?? (await db.paymentCancel.create({ data: { sellerId: p.sellerId, paymentId: p.id, amount: Math.min(amount, p.amount), reason, idempotencyKey: key } }).catch(async (e) => {
    if (!isUniqueViolation(e)) throw e;
    return db.paymentCancel.findUniqueOrThrow({ where: { paymentId_idempotencyKey: { paymentId: p.id, idempotencyKey: key } } });
  }));
  await processPaymentCancel(db, gw, c.id);
}

// 승인 중(APPROVING)이거나 결제됐는데 주문에 반영되지 않은 결제를 PG 조회로 확정한다(승인 타임아웃·웹훅·정기 실행).
export async function reconcilePayment(db: PrismaClient, gw: PaymentGateway, paymentId: string): Promise<ConfirmOutcome> {
  const p = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
  if (p.status === "PAID") return settleOrder(db, gw, p);
  if (p.status !== "APPROVING" || !p.pgTid) return outcomeOf(p);
  const r = await gw.getPayment(p.pgTid);
  if (r.kind === "ok") return applyPgPayment(db, gw, p, r.value);
  if (r.kind === "rejected") {
    await fail(db, p, r.code, ["APPROVING"]);
    return "failed";
  }
  return "pending";
}

// 웹훅 수신 기록(로그 추적, MASTER 2026-10-05). 결제 번호(tid)·웹훅 종류·우리 결제와 맞았는지·처리 뒤 결제 상태만 남기고 본문·카드·개인정보는 남기지 않는다.
// 서명이 틀린 요청은 누구나 보낼 수 있어 분당 개수를 막아 두고(WEBHOOK_REJECT_AUDIT_PER_MIN) 본문 값은 기록하지 않는다. 기록 실패는 웹훅 응답을 막지 않는다.
const WEBHOOK_REJECT_AUDIT_PER_MIN = 10;
async function auditWebhookSafely(db: PrismaClient, e: Parameters<typeof writeAudit>[1]) {
  try {
    await writeAudit(db, e);
  } catch {
    // 기록 실패로 PG에 오류를 돌려 재전송을 부르지 않는다
  }
}

// 처리 중 오류(route에서 부름): 오류 이름만 남긴다(메시지·본문 없음).
export async function auditWebhookFailure(db: PrismaClient, error: unknown) {
  await auditWebhookSafely(db, { ...SYSTEM, action: "payment.webhook_failed", after: { error: error instanceof Error ? error.name : "error" } });
}

// 웹훅: 서명이 맞으면 tid로 우리 결제를 찾아 PG 조회로 확정한다(본문 값은 믿지 않는다). 모르는 tid는 무시한다. 수신 결과는 로그 추적에 남긴다.
export async function handleWebhook(db: PrismaClient, gw: PaymentGateway, body: unknown): Promise<"ok" | "invalid_signature"> {
  const v = gw.verifyWebhook(body);
  if (!v) {
    const since = new Date(Date.now() - 60_000);
    if ((await db.auditLog.count({ where: { action: "payment.webhook_rejected", createdAt: { gte: since } } })) < WEBHOOK_REJECT_AUDIT_PER_MIN) {
      await auditWebhookSafely(db, { ...SYSTEM, action: "payment.webhook_rejected", after: { reason: "invalid_signature" } });
    }
    return "invalid_signature";
  }
  const p = await db.payment.findUnique({ where: { pgTid: v.tid }, select: { id: true, provider: true, sellerId: true, orderId: true } });
  const matched = !!p && p.provider === gw.name;
  if (p && matched) await reconcilePayment(db, gw, p.id);
  const now = matched ? await db.payment.findUnique({ where: { id: p!.id }, select: { status: true } }) : null;
  await auditWebhookSafely(db, {
    ...SYSTEM,
    sellerId: matched ? p!.sellerId : null,
    action: "payment.webhook_received",
    targetType: matched ? "Order" : undefined,
    targetId: matched ? p!.orderId : undefined,
    after: { tid: v.tid, kind: v.status ?? null, matched, paymentStatus: now?.status ?? null },
  });
  return "ok";
}

// ───────────── 취소·부분 취소 ─────────────

// 환불 트랜잭션 안에서 부른다(queue/service.ts refundOrder). 이 주문의 카드 결제가 있으면 환불액만큼 취소 요청을 남긴다.
// PG 호출은 하지 않는다(커밋 뒤 processPaymentCancel). 결제가 없으면(무통장 입금·시험 주문) 아무것도 하지 않는다.
export async function requestPaymentCancel(tx: Tx, input: { sellerId: string; orderId: string; amount: number; reason: string; idempotencyKey: string }) {
  if (input.amount <= 0) return null;
  const p = await tx.payment.findFirst({ where: { sellerId: input.sellerId, orderId: input.orderId, status: { in: ["PAID", "PARTIAL_CANCELLED"] } } });
  if (!p) return null;
  const existing = await tx.paymentCancel.findUnique({ where: { paymentId_idempotencyKey: { paymentId: p.id, idempotencyKey: input.idempotencyKey } } });
  if (existing) return existing;
  return tx.paymentCancel.create({
    data: { sellerId: p.sellerId, paymentId: p.id, amount: Math.min(input.amount, p.amount), reason: input.reason.slice(0, 200), idempotencyKey: input.idempotencyKey },
  });
}

async function markCancelDone(db: PrismaClient, cancelId: string, cancelledTid: string | null) {
  await db.$transaction(async (tx) => {
    const c = await tx.paymentCancel.findUniqueOrThrow({ where: { id: cancelId } });
    if (c.status === "DONE") return;
    // 같은 결제의 취소 반영은 결제 행 잠금 아래에서 차례로(취소 합계가 결제 금액을 넘지 않게, DB CHECK도 막는다)
    await tx.$queryRaw`SELECT 1 FROM "Payment" WHERE "id" = ${c.paymentId}::uuid FOR UPDATE`;
    const p = await tx.payment.findUniqueOrThrow({ where: { id: c.paymentId } });
    const cancelledAmount = p.cancelledAmount + c.amount;
    await tx.payment.update({
      where: { id: p.id },
      data: { cancelledAmount, status: cancelledAmount >= p.amount ? "CANCELLED" : "PARTIAL_CANCELLED", cancelledAt: new Date() },
    });
    await tx.paymentCancel.update({ where: { id: c.id }, data: { status: "DONE", pgCancelledTid: cancelledTid, doneAt: new Date(), failureCode: null } });
    await writeAudit(tx, { ...SYSTEM, sellerId: c.sellerId, action: "payment.cancelled", targetType: "Order", targetId: p.orderId, after: { paymentId: p.id, amount: c.amount, cancelledAmount } });
  });
}

// 취소 요청 하나를 PG에 보낸다. 같은 요청을 동시에 두 번 보내지 않고(lastTriedAt 조건으로 잡음), 결과를 모르면 PG 조회로 확정한다.
// 취소 주문번호는 요청 id로 고정이라, 다시 보내도 PG가 중복으로 거절한다(두 번 취소되지 않음).
export async function processPaymentCancel(db: PrismaClient, gw: PaymentGateway, cancelId: string, now = new Date()): Promise<"done" | "failed" | "pending"> {
  const retryBefore = new Date(now.getTime() - CANCEL_RETRY_AFTER_MS);
  const claimed = await db.paymentCancel.updateMany({
    where: { id: cancelId, status: "REQUESTED", OR: [{ lastTriedAt: null }, { lastTriedAt: { lt: retryBefore } }] },
    data: { attempts: { increment: 1 }, lastTriedAt: now },
  });
  const c = await db.paymentCancel.findUniqueOrThrow({ where: { id: cancelId }, include: { payment: true } });
  if (claimed.count === 0) return c.status === "DONE" ? "done" : c.status === "FAILED" ? "failed" : "pending";
  const p = c.payment;
  if (!p.pgTid || p.provider !== gw.name) {
    await db.paymentCancel.update({ where: { id: c.id }, data: { status: "FAILED", failureCode: "provider_mismatch" } });
    return "failed";
  }
  if (c.amount > p.amount - p.cancelledAmount) {
    await db.paymentCancel.update({ where: { id: c.id }, data: { status: "FAILED", failureCode: "over_balance" } });
    return "failed";
  }
  const partial = !(p.cancelledAmount === 0 && c.amount === p.amount);
  const r = await gw.cancel({ tid: p.pgTid, cancelOrderId: c.id, amount: c.amount, partial, reason: c.reason });
  if (r.kind === "ok") {
    await markCancelDone(db, c.id, r.value.cancelledTid);
    return "done";
  }
  // 거절·결과 모름: 이미 취소됐는지 PG 잔액으로 확인한다(앞선 시도가 성공했는데 응답만 잃은 경우).
  const look = await gw.getPayment(p.pgTid);
  if (look.kind === "ok" && look.value.amount - look.value.balanceAmt >= p.cancelledAmount + c.amount) {
    await markCancelDone(db, c.id, null);
    return "done";
  }
  if (r.kind === "rejected") {
    // 거절은 사람이 확인한다(로그 추적 기록). 다시 자동으로 보내지 않는다.
    await db.paymentCancel.update({ where: { id: c.id }, data: { status: "FAILED", failureCode: r.code.slice(0, 60) } });
    await writeAudit(db, { ...SYSTEM, sellerId: c.sellerId, action: "payment.cancel_failed", targetType: "Order", targetId: p.orderId, after: { paymentId: p.id, amount: c.amount, code: r.code } });
    return "failed";
  }
  return "pending";
}

// 환불 직후 그 주문의 취소 요청을 바로 PG에 보낸다(환불 라우트에서 커밋 뒤 부른다). 실패·결과 모름은 정기 처리(worker.ts)가 다시 한다.
export async function runPaymentCancelsForOrder(db: PrismaClient, gw: PaymentGateway, orderId: string): Promise<("done" | "failed" | "pending")[]> {
  const cancels = await db.paymentCancel.findMany({ where: { status: "REQUESTED", payment: { orderId } }, select: { id: true } });
  const out: ("done" | "failed" | "pending")[] = [];
  for (const c of cancels) out.push(await processPaymentCancel(db, gw, c.id));
  return out;
}

// 남은 취소 요청·승인 중 결제를 처리한다(환불 뒤·정기 실행에서 부른다). 한 건이 실패해도 나머지는 계속한다.
export async function processPendingPayments(db: PrismaClient, gw: PaymentGateway, now = new Date(), limit = 20) {
  const retryBefore = new Date(now.getTime() - CANCEL_RETRY_AFTER_MS);
  const cancels = await db.paymentCancel.findMany({
    where: { status: "REQUESTED", OR: [{ lastTriedAt: null }, { lastTriedAt: { lt: retryBefore } }] },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });
  const approving = await db.payment.findMany({ where: { status: "APPROVING", updatedAt: { lt: retryBefore } }, orderBy: { updatedAt: "asc" }, take: limit, select: { id: true } });
  const out = { cancels: 0, reconciled: 0, failed: 0 };
  for (const c of cancels) {
    try {
      if ((await processPaymentCancel(db, gw, c.id, now)) === "done") out.cancels++;
    } catch {
      out.failed++;
    }
  }
  for (const a of approving) {
    try {
      if ((await reconcilePayment(db, gw, a.id)) !== "pending") out.reconciled++;
    } catch {
      out.failed++;
    }
  }
  return out;
}
