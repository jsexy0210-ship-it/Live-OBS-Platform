import { Prisma, type PrismaClient, type SubscriptionRefund, type SubscriptionRefundStatus } from "@prisma/client";
import { writeAudit } from "../audit/log";
import type { AdminSessionContext } from "../auth/session";
import { forbidden, notFound } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import type { BillingProvider } from "../billing/provider";
import { dbNow } from "../billing/subscription";
import { cleanText } from "../text/clean";

// 구독 환불 요청·처리(MA-026 목록 · MA-027 처리). 규칙:
// - 보기는 마스터 관리자 전 역할(platform.read), 요청 만들기·승인·반려는 요금·청구 변경 권한(billing.manage: 최고관리자·운영).
//   바꿀 때마다 로그 추적에 남긴다.
// - 요청은 두 곳에서 생긴다. 시스템: 해지 뒤 확정된 결제(subscription.ts settlePayment, 사유 paid_after_cancel).
//   마스터 관리자: 결제된(PAID) 청구에 직접(법이 요구하는 환불 등, 사유 필수). 결제당 진행 중이거나 끝난 환불은 하나(DB 부분 유니크).
// - 승인하면 처리 중(PROCESSING)으로 커밋한 뒤 결제 공급자에 취소를 요청한다(환불 id = 멱등키). 결과로 환불됨·실패를 남긴다.
//   응답이 끊겨 처리 중으로 남거나 실패한 환불은 다시 승인하면 같은 멱등키로 다시 요청한다(두 번 취소되지 않음).
// - 지금 결제 공급자는 시험용 가짜뿐이라 실제 돈은 오가지 않는다. 실제 업체 연결·실제 환불 실행은 대표님 승인 뒤.
// - 구독 상태(이용 기간·해지)는 바꾸지 않는다. 시스템 요청은 이미 해지된 구독의 결제다.
type Db = PrismaClient | Prisma.TransactionClient;
export type AuditMeta = { ip?: string | null; userAgent?: string | null };

export const REFUND_PAGE_SIZE = 50;
export const REASON_MAX = 200;
const STATUSES: readonly SubscriptionRefundStatus[] = ["REQUESTED", "PROCESSING", "REFUNDED", "FAILED", "REJECTED"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const obj = (raw: unknown) => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});

export type RefundRejection =
  | "invalid_status"
  | "invalid_cursor"
  | "invalid_amount"
  | "invalid_reason"
  | "payment_not_found"
  | "payment_not_paid"
  | "already_requested"
  | "version_conflict"
  | "not_decidable"
  | "provider_payment_missing";

// 마스터 관리자 화면 문구(명사형·합니다체)
export const REFUND_MESSAGES: Record<RefundRejection, string> = {
  invalid_status: "상태를 다시 선택해 주십시오",
  invalid_cursor: "목록을 다시 불러와 주십시오",
  invalid_amount: "환불 금액은 1원 이상, 결제 금액 이하로 입력해 주십시오",
  invalid_reason: `사유를 ${REASON_MAX}자 안에서 입력해 주십시오`,
  payment_not_found: "청구를 찾을 수 없습니다",
  payment_not_paid: "결제가 끝난 청구만 환불할 수 있습니다",
  already_requested: "이 청구에는 이미 환불 요청이 있습니다",
  version_conflict: "다른 곳에서 먼저 처리했습니다. 새로고침한 뒤 다시 시도해 주십시오",
  not_decidable: "이미 끝난 환불입니다",
  provider_payment_missing: "결제 공급자 결제 번호가 없어 환불할 수 없습니다",
};

const VIEW = {
  id: true,
  sellerId: true,
  paymentId: true,
  amount: true,
  source: true,
  reason: true,
  status: true,
  decisionNote: true,
  failureReason: true,
  version: true,
  createdAt: true,
  decidedAt: true,
  refundedAt: true,
  requestedByAdminId: true,
  decidedByAdminId: true,
  seller: { select: { shopName: true, slug: true } },
  payment: { select: { amount: true, kind: true, periodStart: true, periodEnd: true, paidAt: true, receiptUrl: true } },
} as const satisfies Prisma.SubscriptionRefundSelect;
type Row = Prisma.SubscriptionRefundGetPayload<{ select: typeof VIEW }>;

const view = ({ seller, payment, ...r }: Row) => ({ ...r, shopName: seller.shopName, slug: seller.slug, payment });
const auditView = (r: Pick<SubscriptionRefund, "amount" | "status" | "source" | "reason" | "decisionNote" | "failureReason">) => ({
  amount: r.amount,
  status: r.status,
  source: r.source,
  reason: r.reason,
  decisionNote: r.decisionNote,
  failureReason: r.failureReason,
});

function audit(db: Db, admin: AdminSessionContext | null, meta: AuditMeta, action: string, r: { id: string; sellerId: string }, before: unknown, after: unknown) {
  return writeAudit(db, {
    actorType: admin ? "PLATFORM_ADMIN" : "SYSTEM",
    actorId: admin?.admin.id ?? null,
    sellerId: r.sellerId,
    action,
    targetType: "SubscriptionRefund",
    targetId: r.id,
    before,
    after,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
}

const requireRead = (admin: AdminSessionContext) => {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
};
const requireWrite = (admin: AdminSessionContext) => {
  if (!adminCan(admin.admin.role, "billing.manage")) throw forbidden();
};

// MA-026: 환불 요청 목록. ?status=(없으면 전부)&cursor=. 요청 최신 순 50건.
export async function listSubscriptionRefunds(db: PrismaClient, admin: AdminSessionContext, q: { status?: string | null; cursor?: string | null }) {
  requireRead(admin);
  if (q.status && !STATUSES.includes(q.status as SubscriptionRefundStatus)) return { ok: false as const, reason: "invalid_status" as const };
  let after: Prisma.SubscriptionRefundWhereInput = {};
  if (q.cursor) {
    const i = q.cursor.lastIndexOf("_");
    const at = new Date(q.cursor.slice(0, i));
    const id = q.cursor.slice(i + 1);
    if (i <= 0 || Number.isNaN(at.getTime()) || !UUID.test(id)) return { ok: false as const, reason: "invalid_cursor" as const };
    after = { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: id } }] };
  }
  const rows = await db.subscriptionRefund.findMany({
    where: { ...(q.status ? { status: q.status as SubscriptionRefundStatus } : {}), ...after },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: REFUND_PAGE_SIZE + 1,
    select: VIEW,
  });
  const page = rows.slice(0, REFUND_PAGE_SIZE);
  const last = page[page.length - 1];
  const counts = await db.subscriptionRefund.groupBy({ by: ["status"], _count: { _all: true } });
  return {
    ok: true as const,
    items: page.map(view),
    counts: Object.fromEntries(STATUSES.map((s) => [s, counts.find((c) => c.status === s)?._count._all ?? 0])),
    nextCursor: rows.length > REFUND_PAGE_SIZE && last ? `${last.createdAt.toISOString()}_${last.id}` : null,
  };
}

export async function getSubscriptionRefund(db: PrismaClient, admin: AdminSessionContext, id: string) {
  requireRead(admin);
  if (!UUID.test(id)) throw notFound();
  const row = await db.subscriptionRefund.findUnique({ where: { id }, select: VIEW });
  if (!row) throw notFound();
  return view(row);
}

// 마스터 관리자가 직접 만드는 요청. 본문 { paymentId, amount, reason }.
export async function createSubscriptionRefund(db: PrismaClient, admin: AdminSessionContext, raw: unknown, meta: AuditMeta = {}) {
  requireWrite(admin);
  const b = obj(raw);
  if (typeof b.paymentId !== "string" || !UUID.test(b.paymentId)) return { ok: false as const, reason: "payment_not_found" as const };
  const reason = cleanText(b.reason, REASON_MAX, "memo");
  if (!reason) return { ok: false as const, reason: "invalid_reason" as const };
  const amount = b.amount;
  const paymentId = b.paymentId;
  try {
    return await db.$transaction(async (tx) => {
      const [p] = await tx.$queryRaw<{ sellerId: string; amount: number; status: string }[]>`
        SELECT "sellerId", "amount", "status"::text AS "status" FROM "SubscriptionPayment" WHERE "id" = ${paymentId}::uuid FOR UPDATE`;
      if (!p) return { ok: false as const, reason: "payment_not_found" as const };
      if (p.status !== "PAID") return { ok: false as const, reason: "payment_not_paid" as const };
      if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1 || amount > p.amount) return { ok: false as const, reason: "invalid_amount" as const };
      const now = await dbNow(tx);
      const row = await tx.subscriptionRefund.create({
        data: { sellerId: p.sellerId, paymentId, amount, source: "ADMIN", reason, requestedByAdminId: admin.admin.id, createdAt: now },
      });
      await audit(tx, admin, meta, "subscription.refund.request", row, undefined, auditView(row));
      return { ok: true as const, refund: view(await tx.subscriptionRefund.findUniqueOrThrow({ where: { id: row.id }, select: VIEW })) };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false as const, reason: "already_requested" as const };
    throw e;
  }
}

// 반려. REQUESTED·FAILED만. 본문 { note, expectedVersion }.
export async function rejectSubscriptionRefund(db: PrismaClient, admin: AdminSessionContext, id: string, raw: unknown, meta: AuditMeta = {}) {
  requireWrite(admin);
  if (!UUID.test(id)) throw notFound();
  const b = obj(raw);
  const note = cleanText(b.note, REASON_MAX, "memo");
  if (!note) return { ok: false as const, reason: "invalid_reason" as const };
  return db.$transaction(async (tx) => {
    const [cur] = await tx.$queryRaw<SubscriptionRefund[]>`SELECT * FROM "SubscriptionRefund" WHERE "id" = ${id}::uuid FOR UPDATE`;
    if (!cur) throw notFound();
    if (b.expectedVersion !== cur.version) return { ok: false as const, reason: "version_conflict" as const, currentVersion: cur.version };
    if (cur.status !== "REQUESTED" && cur.status !== "FAILED") return { ok: false as const, reason: "not_decidable" as const };
    const now = await dbNow(tx);
    const row = await tx.subscriptionRefund.update({
      where: { id },
      data: { status: "REJECTED", decisionNote: note, decidedByAdminId: admin.admin.id, decidedAt: now, version: { increment: 1 } },
    });
    await audit(tx, admin, meta, "subscription.refund.reject", row, auditView(cur), auditView(row));
    return { ok: true as const, refund: view(await tx.subscriptionRefund.findUniqueOrThrow({ where: { id }, select: VIEW })) };
  });
}

// 승인 = 결제 공급자에 취소 요청. REQUESTED·FAILED·PROCESSING(응답이 끊겼던 것)만. 본문 { expectedVersion, note? }.
export async function approveSubscriptionRefund(db: PrismaClient, provider: BillingProvider, admin: AdminSessionContext, id: string, raw: unknown, meta: AuditMeta = {}) {
  requireWrite(admin);
  if (!UUID.test(id)) throw notFound();
  const b = obj(raw);
  const note = b.note === undefined || b.note === null || b.note === "" ? null : cleanText(b.note, REASON_MAX, "memo");
  if (note === null && b.note !== undefined && b.note !== null && b.note !== "") return { ok: false as const, reason: "invalid_reason" as const };
  const claimed = await db.$transaction(async (tx) => {
    const [cur] = await tx.$queryRaw<SubscriptionRefund[]>`SELECT * FROM "SubscriptionRefund" WHERE "id" = ${id}::uuid FOR UPDATE`;
    if (!cur) throw notFound();
    if (b.expectedVersion !== cur.version) return { ok: false as const, reason: "version_conflict" as const, currentVersion: cur.version };
    if (cur.status !== "REQUESTED" && cur.status !== "FAILED" && cur.status !== "PROCESSING") return { ok: false as const, reason: "not_decidable" as const };
    const pay = await tx.subscriptionPayment.findUniqueOrThrow({ where: { id: cur.paymentId }, select: { providerPaymentId: true } });
    if (!pay.providerPaymentId) return { ok: false as const, reason: "provider_payment_missing" as const };
    const now = await dbNow(tx);
    const row = await tx.subscriptionRefund.update({
      where: { id },
      data: { status: "PROCESSING", decisionNote: note ?? cur.decisionNote, decidedByAdminId: admin.admin.id, decidedAt: now, failureReason: null, version: { increment: 1 } },
    });
    await audit(tx, admin, meta, "subscription.refund.approve", row, auditView(cur), auditView(row));
    return { ok: true as const, refund: row, providerPaymentId: pay.providerPaymentId };
  });
  if (!claimed.ok) return claimed;
  const { refund, providerPaymentId } = claimed;
  let result: Awaited<ReturnType<BillingProvider["cancelPayment"]>>;
  try {
    result = await provider.cancelPayment({ paymentId: providerPaymentId, amount: refund.amount, refundId: refund.id, reason: refund.reason });
  } catch (e) {
    // 취소됐는지 모른다. 처리 중으로 두고, 다시 승인하면 같은 멱등키로 다시 요청한다.
    console.error("[subscription_refund.unresolved]", refund.id, e instanceof Error ? e.message : e);
    return { ok: true as const, refund: await getSubscriptionRefund(db, admin, id) };
  }
  await db.$transaction(async (tx) => {
    const [cur] = await tx.$queryRaw<SubscriptionRefund[]>`SELECT * FROM "SubscriptionRefund" WHERE "id" = ${id}::uuid FOR UPDATE`;
    if (cur.status !== "PROCESSING") return;
    const now = await dbNow(tx);
    const row = await tx.subscriptionRefund.update({
      where: { id },
      data: result.ok
        ? { status: "REFUNDED", providerRefundId: result.cancelId, refundedAt: now, version: { increment: 1 } }
        : { status: "FAILED", failureReason: result.reason.slice(0, REASON_MAX), version: { increment: 1 } },
    });
    await audit(tx, null, {}, result.ok ? "subscription.refund.refunded" : "subscription.refund.failed", row, auditView(cur), auditView(row));
  });
  return { ok: true as const, refund: await getSubscriptionRefund(db, admin, id) };
}
