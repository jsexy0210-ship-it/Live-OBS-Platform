import { Prisma, type AutomationJob, type AutomationPayment, type PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import type { BillingProvider } from "../billing/provider";
import { openBillingKey } from "../billing/secret";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { AUTOMATION_LIMITS, AUTOMATION_ORDER_NAME, AUTOMATION_PRICE } from "./config";
import { dbNow, writeJobEvent } from "./queue";

// 자동 연결 결제. 결제는 기존 billing 공통 구조(BillingProvider, 등록된 카드 빌링키, 청구 id = orderId로 PG 중복 방지)를 그대로 쓴다.
// 실행 권한(작업 QUEUED)은 서버가 PG에 결제 결과를 직접 조회해 PAID를 확인한 트랜잭션에서만 준다.
// 브라우저 성공 리다이렉트·클라이언트 값으로는 실행되지 않는다(그런 경로가 없다).

const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;
const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

export type PurchaseResult =
  | { ok: true; jobId: string; paymentStatus: AutomationPayment["status"]; jobStatus: AutomationJob["status"]; replayed: boolean }
  | { ok: false; reason: "bad_idempotency_key" | "card_required" | "job_in_progress" | "payment_failed"; jobId?: string };

const view = (p: AutomationPayment & { job: AutomationJob | null }, replayed: boolean): PurchaseResult =>
  p.job
    ? { ok: true, jobId: p.job.id, paymentStatus: p.status, jobStatus: p.job.status, replayed }
    : { ok: false, reason: "payment_failed" };

// 판매자 대표자가 자동 연결을 산다. 같은 Idempotency-Key로 다시 오면 처음 결과를 돌려준다(결제·작업을 새로 만들지 않음).
// 다른 키로 연타해도 판매자당 열린 작업 1개(부분 유니크)라 두 번째 결제가 생기지 않는다.
export async function purchaseAutomation(
  db: PrismaClient,
  provider: BillingProvider,
  ctx: TenantContext,
  input: { idempotencyKey: unknown },
): Promise<PurchaseResult> {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  const key = input.idempotencyKey;
  if (typeof key !== "string" || !KEY_RE.test(key)) return { ok: false, reason: "bad_idempotency_key" };

  const replay = async () => {
    const p = await db.automationPayment.findUnique({ where: { sellerId_idempotencyKey: { sellerId: ctx.sellerId, idempotencyKey: key } }, include: { job: true } });
    return p ? view(p, true) : null;
  };
  const existing = await replay();
  if (existing) return existing;

  const sub = await db.sellerSubscription.findUnique({ where: { sellerId: ctx.sellerId }, select: { billingKeyCipher: true } });
  if (!sub?.billingKeyCipher) return { ok: false, reason: "card_required" };
  const billingKey = openBillingKey(sub.billingKeyCipher, ctx.sellerId);

  let created: { payment: AutomationPayment; job: AutomationJob };
  try {
    created = await db.$transaction(async (tx) => {
      const payment = await tx.automationPayment.create({ data: { sellerId: ctx.sellerId, amount: AUTOMATION_PRICE, idempotencyKey: key } });
      const job = await tx.automationJob.create({
        // OBS 대상 키: 판매자 OBS 연결 단위. 로컬 도구 pairing을 붙이면 기기 id로 바꾼다.
        data: { sellerId: ctx.sellerId, paymentId: payment.id, obsTargetKey: `seller:${ctx.sellerId}` },
      });
      await writeJobEvent(tx, job, null, "AWAITING_PAYMENT", 0);
      await writeAudit(tx, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        sellerId: ctx.sellerId,
        action: "automation.purchase",
        targetType: "AutomationJob",
        targetId: job.id,
        after: { amount: payment.amount, paymentId: payment.id },
      });
      return { payment, job };
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // 같은 키가 동시에 들어왔으면 먼저 만든 쪽을 돌려준다
    const again = await replay();
    if (again) return again;
    const open = await db.automationJob.findFirst({
      where: { sellerId: ctx.sellerId, status: { notIn: ["SUCCEEDED", "FAILED", "CANCELED"] } },
      select: { id: true },
    });
    return { ok: false, reason: "job_in_progress", jobId: open?.id };
  }

  try {
    await provider.charge({ billingKey, customerKey: ctx.sellerId, amount: created.payment.amount, orderId: created.payment.id, orderName: AUTOMATION_ORDER_NAME });
  } catch {
    // 결과를 모른다. PENDING으로 두고 대사(reconcile)가 같은 청구 id로 PG에 확인한다.
  }
  // 조회도 실패하면 PENDING으로 두고 대사가 다시 묻는다
  await verifyAndSettle(db, provider, created.payment.id).catch(() => null);
  const p = await db.automationPayment.findUniqueOrThrow({ where: { id: created.payment.id }, include: { job: true } });
  return p.status === "FAILED" ? { ok: false, reason: "payment_failed", jobId: p.job?.id } : view(p, false);
}

// PG에 청구 id로 결과를 직접 묻고 반영한다. PAID일 때만 작업을 대기열(QUEUED)에 넣는다.
// 여러 번 불러도 안전하다(PENDING인 청구만 바꾼다).
export async function verifyAndSettle(
  db: PrismaClient,
  provider: BillingProvider,
  paymentId: string,
  opts: { notChargedAfterMs?: number } = {},
): Promise<AutomationPayment["status"]> {
  const found = await provider.getPayment(paymentId);
  return db.$transaction(async (tx) => {
    const now = await dbNow(tx);
    const payment = await tx.automationPayment.findUniqueOrThrow({ where: { id: paymentId }, include: { job: true } });
    if (payment.status !== "PENDING") return payment.status;
    const ageMs = now.getTime() - payment.createdAt.getTime();
    let status: "PAID" | "FAILED" | null = null;
    let failureReason: string | null = null;
    if (found.status === "PAID") status = "PAID";
    else if (found.status === "FAILED") [status, failureReason] = ["FAILED", found.reason.slice(0, 200)];
    else if (ageMs >= (opts.notChargedAfterMs ?? AUTOMATION_LIMITS.notChargedAfterMs)) [status, failureReason] = ["FAILED", "not_charged"];
    if (!status) return "PENDING";

    const claimed = await tx.automationPayment.updateMany({
      where: { id: paymentId, status: "PENDING" },
      data: status === "PAID" ? { status, paidAt: now, providerPaymentId: found.status === "PAID" ? found.paymentId : null } : { status, failureReason },
    });
    if (claimed.count !== 1) return (await tx.automationPayment.findUniqueOrThrow({ where: { id: paymentId } })).status;

    const job = payment.job;
    if (job) {
      const to = status === "PAID" ? "QUEUED" : "FAILED";
      const moved = await tx.automationJob.updateMany({
        where: { id: job.id, status: "AWAITING_PAYMENT" },
        data: to === "QUEUED" ? { status: to, runAfter: now } : { status: to, lastError: "payment_failed", finishedAt: now },
      });
      if (moved.count === 1) await writeJobEvent(tx, job, "AWAITING_PAYMENT", to, job.fencingToken, { paymentStatus: status });
      // 결제 확정 전에 취소된 작업에 결제가 들어왔다: 환불 판단이 필요하다(자동 환불 안 함)
      else if (status === "PAID") {
        await writeAudit(tx, {
          actorType: "SYSTEM",
          sellerId: payment.sellerId,
          action: "automation.paid_after_cancel",
          targetType: "AutomationPayment",
          targetId: payment.id,
          after: { jobStatus: job.status, amount: payment.amount },
        });
      }
    }
    return status;
  });
}

// 결과를 못 받은(PENDING) 청구를 PG에 다시 묻는다. 작업자 반복에서 부른다. 확정한 건수를 돌려준다.
export async function reconcileAutomationPayments(db: PrismaClient, provider: BillingProvider, opts: { olderThanMs?: number } = {}): Promise<number> {
  const cutoff = new Date((await dbNow(db)).getTime() - (opts.olderThanMs ?? AUTOMATION_LIMITS.reconcileAfterMs));
  const stale = await db.automationPayment.findMany({ where: { status: "PENDING", createdAt: { lte: cutoff } }, select: { id: true }, take: 50 });
  let settled = 0;
  for (const p of stale) {
    // 한 건 조회가 실패해도 나머지는 계속 확인한다
    const status = await verifyAndSettle(db, provider, p.id).catch(() => "PENDING" as const);
    if (status !== "PENDING") settled++;
  }
  return settled;
}
