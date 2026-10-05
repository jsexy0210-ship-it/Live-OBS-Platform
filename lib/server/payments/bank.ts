import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { lockSellerOrders } from "../orders/overdue";
import { markOrderPaid } from "../queue/service";
import { canViewCustomerPii, requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { payableAmount, shopOpenForPayment } from "./service";
import { orderNoLabel } from "../orders/orderNoLabel";

// 무통장 입금(기반-결제 2단계): 판매자 입금 계좌, 구매자 무통장 선택·안내, 판매자 입금 대기 목록·입금 확인(SA-026).
// - 입금 기한은 주문할 때 정한 값(Order.paymentDueAt)을 그대로 안내한다. 무통장을 다시 골라도 늘어나지 않는다.
// - 입금 확인은 기존 결제 완료 처리(markOrderPaid: 재고·주문대기·적립)를 그대로 쓴다. 이미 결제된 주문은 건너뛴다(멱등).
// - 카드 결제가 승인 중이거나 끝난 주문은 무통장으로 확인하지 않는다. 겹쳐서 둘 다 되면 카드 쪽이 전액 취소된다(payments/service.ts settleOrder).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEPOSIT_CONFIRM_MAX = 50;
export const DEPOSIT_PAGE_DEFAULT = 20;
export const DEPOSIT_PAGE_MAX = 50;

export type BankAccount = { bankName: string; accountNumber: string; accountHolder: string };

// 로그 추적에는 계좌번호 끝 4자리만 남긴다
export const maskAccountNumber = (n: string) => `****${n.replace(/\D/g, "").slice(-4)}`;

const CONTROL = /[\u0000-\u001f\u007f]/;

// 계좌 입력 검사: 은행 이름 1~20자, 계좌번호 숫자·하이픈 6~30자(숫자 6~20개), 예금주 1~30자. 앞뒤 공백은 지운다.
export function parseBankAccount(raw: unknown): BankAccount | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === "string" && !CONTROL.test(v) && v.trim().length >= 1 && v.trim().length <= max ? v.trim() : null);
  const bankName = text(r.bankName, 20);
  const accountHolder = text(r.accountHolder, 30);
  const accountNumber = typeof r.accountNumber === "string" ? r.accountNumber.replace(/\s/g, "") : "";
  const digits = accountNumber.replace(/-/g, "");
  if (!bankName || !accountHolder || !/^[0-9-]{6,30}$/.test(accountNumber) || !/^\d{6,20}$/.test(digits)) return null;
  return { bankName, accountNumber, accountHolder };
}

export async function readBankAccount(db: PrismaClient, ctx: TenantContext): Promise<BankAccount | null> {
  requireSellerRead(ctx, "SHOP_SETTINGS");
  return db.sellerBankAccount.findUnique({ where: { sellerId: ctx.sellerId }, select: { bankName: true, accountNumber: true, accountHolder: true } });
}

export async function saveBankAccount(db: PrismaClient, ctx: TenantContext, raw: unknown): Promise<{ ok: true; account: BankAccount } | { ok: false; reason: "invalid_bank_account" }> {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  const account = parseBankAccount(raw);
  if (!account) return { ok: false, reason: "invalid_bank_account" };
  await db.$transaction(async (tx) => {
    const before = await tx.sellerBankAccount.findUnique({ where: { sellerId: ctx.sellerId } });
    await tx.sellerBankAccount.upsert({ where: { sellerId: ctx.sellerId }, create: { sellerId: ctx.sellerId, ...account }, update: account });
    const view = (a: BankAccount) => ({ bankName: a.bankName, accountNumber: maskAccountNumber(a.accountNumber), accountHolder: a.accountHolder });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "seller.bank_account.update",
      targetType: "Seller",
      targetId: ctx.sellerId,
      before: before ? view(before) : null,
      after: view(account),
    });
  });
  return { ok: true, account };
}

// ───────────── 구매자: 무통장 입금 선택·안내 ─────────────

export type BankTransferRejection = "shop_unavailable" | "not_found" | "order_not_payable" | "already_paid" | "amount_mismatch" | "bank_account_missing";
export type BankTransferGuide = { orderId: string; amount: number; bankName: string; accountNumber: string; accountHolder: string; paymentDueAt: Date | null };

// 결제 대기 주문의 결제수단을 무통장 입금으로 정하고 입금 계좌·금액·기한을 돌려준다. 다시 불러도 같은 안내를 준다.
export async function chooseBankTransfer(
  db: PrismaClient,
  input: { sellerId: string; buyerMemberId: string; orderId: string; now?: Date },
): Promise<{ ok: true; value: BankTransferGuide } | { ok: false; reason: BankTransferRejection }> {
  if (!UUID.test(input.orderId)) return { ok: false, reason: "not_found" };
  const now = input.now ?? new Date();
  if (!(await shopOpenForPayment(db, input.sellerId))) return { ok: false, reason: "shop_unavailable" };
  const account = await db.sellerBankAccount.findUnique({ where: { sellerId: input.sellerId } });
  return db.$transaction(async (tx) => {
    // 카드 결제 승인(claimApproval)과 같은 잠금 아래에서 판단한다
    await lockSellerOrders(tx, input.sellerId);
    const order = await tx.order.findFirst({
      where: { id: input.orderId, sellerId: input.sellerId, buyerMemberId: input.buyerMemberId, legalHoldAt: null },
      include: { items: true, couponRedemption: { select: { discountAmount: true } } },
    });
    if (!order) return { ok: false as const, reason: "not_found" as const };
    if (await tx.payment.findFirst({ where: { orderId: order.id, status: { in: ["APPROVING", "PAID", "PARTIAL_CANCELLED"] } }, select: { id: true } }))
      return { ok: false as const, reason: "already_paid" as const };
    if (order.status !== "PENDING_PAYMENT" || (order.paymentDueAt && order.paymentDueAt <= now)) return { ok: false as const, reason: "order_not_payable" as const };
    const amount = payableAmount(order);
    if (amount < 1 || amount !== order.totalAmount) return { ok: false as const, reason: "amount_mismatch" as const };
    if (!account) return { ok: false as const, reason: "bank_account_missing" as const };
    if (order.paymentMethod !== "BANK_TRANSFER") {
      await tx.order.update({ where: { id: order.id }, data: { paymentMethod: "BANK_TRANSFER" } });
      await writeAudit(tx, { actorType: "BUYER", actorId: input.buyerMemberId, sellerId: input.sellerId, action: "order.payment_method", targetType: "Order", targetId: order.id, after: { paymentMethod: "BANK_TRANSFER" } });
    }
    return {
      ok: true as const,
      value: { orderId: order.id, amount, bankName: account.bankName, accountNumber: account.accountNumber, accountHolder: account.accountHolder, paymentDueAt: order.paymentDueAt },
    };
  });
}

// ───────────── 판매자: 입금 대기 목록·입금 확인 ─────────────

export type DepositRow = {
  orderId: string;
  orderNo: number;
  orderNoLabel: string;
  amount: number;
  nickname: string;
  depositorName?: string;
  paymentMethod: "CARD" | "BANK_TRANSFER" | null;
  paymentDueAt: Date | null;
  createdAt: Date;
};

// 입금 대기 = 결제 대기이면서 카드 결제가 승인 중·완료가 아닌 주문. 입금 기한 빠른 순(기한 없는 주문은 뒤), 같으면 주문 순.
// 입금자 확인용 구매자 이름은 CUSTOMER_PII_VIEW가 있을 때만 넣고, 넣었으면 customer.pii.view를 남긴다.
export async function listPendingDeposits(db: PrismaClient, ctx: TenantContext, query: { offset?: unknown; limit?: unknown }) {
  requireSellerRead(ctx, "ORDER_SHIPPING");
  const limit = query.limit == null || query.limit === "" ? DEPOSIT_PAGE_DEFAULT : Number(query.limit);
  const offset = query.offset == null || query.offset === "" ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > DEPOSIT_PAGE_MAX || !Number.isInteger(offset) || offset < 0 || offset > 100_000) return { ok: false as const };
  const where = {
    sellerId: ctx.sellerId,
    status: "PENDING_PAYMENT" as const,
    legalHoldAt: null,
    payments: { none: { status: { in: ["APPROVING" as const, "PAID" as const, "PARTIAL_CANCELLED" as const] } } },
  };
  const pii = canViewCustomerPii(ctx);
  const [total, rows] = await Promise.all([
    db.order.count({ where }),
    db.order.findMany({
      where,
      orderBy: [{ paymentDueAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }],
      skip: offset,
      take: limit,
      select: {
        id: true,
        orderNo: true,
        totalAmount: true,
        broadcastNicknameSnapshot: true,
        paymentMethod: true,
        paymentDueAt: true,
        createdAt: true,
        buyerMember: { select: { name: true } },
      },
    }),
  ]);
  const deposits: DepositRow[] = rows.map((o) => ({
    orderId: o.id,
    orderNo: o.orderNo,
    orderNoLabel: orderNoLabel(o.createdAt, o.orderNo),
    amount: o.totalAmount,
    nickname: o.broadcastNicknameSnapshot,
    ...(pii ? { depositorName: o.buyerMember.name } : {}),
    paymentMethod: o.paymentMethod,
    paymentDueAt: o.paymentDueAt,
    createdAt: o.createdAt,
  }));
  if (pii && deposits.length > 0) {
    await writeAudit(db, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "customer.pii.view",
      targetType: "OrderSearch",
      reason: "pending_deposits",
      after: { orderIds: deposits.map((d) => d.orderId), count: deposits.length },
    });
  }
  return { ok: true as const, value: { deposits, total } };
}

export type DepositResult = { orderId: string; result: "paid" | "stock_shortage" | "already_paid" | "card_in_progress" | "not_payable" | "not_found" };

// 입금 확인(단건·일괄). expectedVersion은 화면이 받은 판매자 liveVersion(다르면 409 conflict, 아무것도 바꾸지 않음).
// 주문마다 따로 처리해 한 건이 안 돼도 나머지는 계속한다. 같은 주문을 여러 번 보내도 한 번만 결제 완료된다.
export async function confirmDeposits(
  db: PrismaClient,
  ctx: TenantContext,
  input: { orderIds: unknown; expectedVersion: unknown },
): Promise<{ ok: true; results: DepositResult[] } | { ok: false; reason: "invalid_request" | "conflict" }> {
  requireSellerPermission(ctx, "ORDER_SHIPPING");
  const ids = input.orderIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > DEPOSIT_CONFIRM_MAX || !ids.every((v) => typeof v === "string" && UUID.test(v)) || !Number.isInteger(input.expectedVersion))
    return { ok: false, reason: "invalid_request" };
  const seller = await db.seller.findUniqueOrThrow({ where: { id: ctx.sellerId }, select: { liveVersion: true } });
  if (seller.liveVersion !== input.expectedVersion) return { ok: false, reason: "conflict" };

  const results: DepositResult[] = [];
  for (const orderId of [...new Set(ids as string[])]) {
    const check = await db.$transaction(async (tx) => {
      await lockSellerOrders(tx, ctx.sellerId);
      const order = await tx.order.findFirst({ where: { id: orderId, sellerId: ctx.sellerId, legalHoldAt: null }, select: { status: true } });
      if (!order) return "not_found" as const;
      if (order.status === "PAID") return "already_paid" as const;
      if (order.status !== "PENDING_PAYMENT") return "not_payable" as const;
      if (await tx.payment.findFirst({ where: { orderId, status: { in: ["APPROVING", "PAID", "PARTIAL_CANCELLED"] } }, select: { id: true } }))
        return "card_in_progress" as const;
      // 열려 있는 카드 결제 창(READY)은 여기서 닫는다: 카드 승인 잡기(claimApproval)도 같은 잠금을 잡으므로,
      // 이 뒤에 인증이 돌아와도 승인을 잡지 못해 PG 승인 자체를 부르지 않는다.
      await tx.payment.updateMany({ where: { orderId, status: "READY" }, data: { status: "FAILED", failureCode: "superseded_by_deposit" } });
      return null;
    });
    if (check) {
      results.push({ orderId, result: check });
      continue;
    }
    const r = await markOrderPaid(db, { sellerId: ctx.sellerId, orderId, paymentMethod: "BANK_TRANSFER" });
    if (!r.ok) {
      const now = await db.order.findUnique({ where: { id: orderId }, select: { status: true } });
      results.push({ orderId, result: now?.status === "PAID" ? "already_paid" : "not_payable" });
      continue;
    }
    await writeAudit(db, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "order.deposit_confirm", targetType: "Order", targetId: orderId });
    results.push({ orderId, result: r.value.stockShortage ? "stock_shortage" : "paid" });
  }
  return { ok: true, results };
}
