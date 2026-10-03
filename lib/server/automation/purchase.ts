import { Prisma, type AutomationJob, type AutomationPayment, type PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import type { BillingProvider } from "../billing/provider";
import { openBillingKey } from "../billing/secret";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import {
  AUTOMATION_CONSENT,
  AUTOMATION_LIMITS,
  AUTOMATION_ORDER_NAME,
  AUTOMATION_PRICE,
  FREE_RECONNECT_DAYS,
  plannerConfig,
  REINSTALL_ORDER_NAME,
  REINSTALL_PRICE,
} from "./config";
import { playbookForShopUrl } from "./playbooks";
import { dbNow, writeJobEvent } from "./queue";

// 자동 연결 결제. 결제는 기존 billing 공통 구조(BillingProvider, 등록된 카드 빌링키, 청구 id = orderId로 PG 중복 방지)를 그대로 쓴다.
// 실행 권한(작업 QUEUED)은 서버가 PG에 결제 결과를 직접 조회해 PAID를 확인한 트랜잭션에서만 준다.
// 브라우저 성공 리다이렉트·클라이언트 값으로는 실행되지 않는다(그런 경로가 없다).

const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;
const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
const OPEN = { notIn: ["SUCCEEDED", "FAILED", "CANCELED"] as AutomationJob["status"][] };

type Failure = "bad_idempotency_key" | "consent_required" | "consent_outdated" | "card_required" | "job_in_progress" | "payment_failed";
export type PurchaseResult =
  | { ok: true; jobId: string; kind: AutomationJob["kind"]; paymentStatus: AutomationPayment["status"] | null; jobStatus: AutomationJob["status"]; replayed: boolean }
  | { ok: false; reason: Failure; jobId?: string };

// 실패 사유별 HTTP 상태(라우트용)
export const PURCHASE_FAILURE_STATUS: Record<Failure, number> = {
  bad_idempotency_key: 400,
  consent_required: 400,
  consent_outdated: 409,
  card_required: 409,
  job_in_progress: 409,
  payment_failed: 402,
};

const playbookFields = (shopUrl: unknown) => {
  const pb = typeof shopUrl === "string" && shopUrl.length <= 300 ? playbookForShopUrl(shopUrl) : null;
  return pb ? { playbookId: pb.id, playbookVersion: pb.version } : {};
};

const view = (p: AutomationPayment & { job: AutomationJob | null }, replayed: boolean): PurchaseResult =>
  p.job
    ? { ok: true, jobId: p.job.id, kind: p.job.kind, paymentStatus: p.status, jobStatus: p.job.status, replayed }
    : { ok: false, reason: "payment_failed" };

// 결제 전 고지 동의 확인. 체크 해제·문자열 true·예전 문구 버전은 거부한다.
function consentProblem(consent: unknown): "consent_required" | "consent_outdated" | null {
  const c = consent as { agreed?: unknown; noticeVersion?: unknown } | null | undefined;
  if (!c || c.agreed !== true) return "consent_required";
  return c.noticeVersion === AUTOMATION_CONSENT.version ? null : "consent_outdated";
}

type PaidJobInput = {
  idempotencyKey: unknown;
  consent: unknown;
  // 쇼핑몰 주소. 서버가 연결 작업서를 고른다(판매자는 플랫폼을 고르지 않음). 모르는 주소면 작업서 없이 진행.
  shopUrl?: unknown;
  kind: "INITIAL" | "REINSTALL";
  baseJobId?: string;
  obsTargetKey?: string;
};

// 판매자 대표자가 자동 연결을 산다(110,000원). 같은 Idempotency-Key로 다시 오면 처음 결과를 돌려준다(결제·작업을 새로 만들지 않음).
// 다른 키로 연타해도 판매자당 열린 작업 1개(부분 유니크)라 두 번째 결제가 생기지 않는다.
export async function purchaseAutomation(
  db: PrismaClient,
  provider: BillingProvider,
  ctx: TenantContext,
  input: { idempotencyKey: unknown; consent: unknown; shopUrl?: unknown },
): Promise<PurchaseResult> {
  return buyPaidJob(db, provider, ctx, { ...input, kind: "INITIAL" });
}

async function buyPaidJob(db: PrismaClient, provider: BillingProvider, ctx: TenantContext, input: PaidJobInput): Promise<PurchaseResult> {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  const key = input.idempotencyKey;
  if (typeof key !== "string" || !KEY_RE.test(key)) return { ok: false, reason: "bad_idempotency_key" };

  const replay = async () => {
    const p = await db.automationPayment.findUnique({ where: { sellerId_idempotencyKey: { sellerId: ctx.sellerId, idempotencyKey: key } }, include: { job: true } });
    return p ? view(p, true) : null;
  };
  const existing = await replay();
  if (existing) return existing;
  const problem = consentProblem(input.consent);
  if (problem) return { ok: false, reason: problem };

  const sub = await db.sellerSubscription.findUnique({ where: { sellerId: ctx.sellerId }, select: { billingKeyCipher: true } });
  if (!sub?.billingKeyCipher) return { ok: false, reason: "card_required" };
  const billingKey = openBillingKey(sub.billingKeyCipher, ctx.sellerId);
  const amount = input.kind === "INITIAL" ? AUTOMATION_PRICE : REINSTALL_PRICE;

  let created: { payment: AutomationPayment; job: AutomationJob };
  try {
    created = await db.$transaction(async (tx) => {
      const now = await dbNow(tx);
      const payment = await tx.automationPayment.create({
        data: { sellerId: ctx.sellerId, amount, idempotencyKey: key, consentNoticeVersion: AUTOMATION_CONSENT.version, consentAgreedAt: now },
      });
      const job = await tx.automationJob.create({
        // OBS 대상 키: 처음 연결은 판매자 단위(아직 PC를 모름), 재설치는 알고 있는 pairing 단위
        data: {
          sellerId: ctx.sellerId,
          kind: input.kind,
          paymentId: payment.id,
          costLimit: plannerConfig().costLimitWon,
          ...playbookFields(input.shopUrl),           baseJobId: input.baseJobId,
          obsTargetKey: input.obsTargetKey ?? `seller:${ctx.sellerId}`,
        },
      });
      await writeJobEvent(tx, job, null, "AWAITING_PAYMENT", 0);
      await writeAudit(tx, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        sellerId: ctx.sellerId,
        action: input.kind === "INITIAL" ? "automation.purchase" : "automation.reinstall_purchase",
        targetType: "AutomationJob",
        targetId: job.id,
        after: { amount, paymentId: payment.id, consentNoticeVersion: AUTOMATION_CONSENT.version },
      });
      return { payment, job };
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // 같은 키가 동시에 들어왔으면 먼저 만든 쪽을 돌려준다
    const again = await replay();
    if (again) return again;
    const open = await db.automationJob.findFirst({ where: { sellerId: ctx.sellerId, status: OPEN }, select: { id: true } });
    return { ok: false, reason: "job_in_progress", jobId: open?.id };
  }

  try {
    await provider.charge({
      billingKey,
      customerKey: ctx.sellerId,
      amount,
      orderId: created.payment.id,
      orderName: input.kind === "INITIAL" ? AUTOMATION_ORDER_NAME : REINSTALL_ORDER_NAME,
    });
  } catch {
    // 결과를 모른다. PENDING으로 두고 대사(reconcile)가 같은 청구 id로 PG에 확인한다.
  }
  // 조회도 실패하면 PENDING으로 두고 대사가 다시 묻는다
  await verifyAndSettle(db, provider, created.payment.id).catch(() => null);
  const p = await db.automationPayment.findUniqueOrThrow({ where: { id: created.payment.id }, include: { job: true } });
  return p.status === "FAILED" ? { ok: false, reason: "payment_failed", jobId: p.job?.id } : view(p, false);
}

// ───── 재연결·재설치 (확정 ②) ─────

export type ReconnectTarget = { shopKey: string; obsPairingId: string };
export type PaidReason = "no_completed_install" | "window_expired" | "shop_changed" | "pc_changed" | "connection_revoked";
export type FreeDecision = { free: true; baseJobId: string } | { free: false; reason: PaidReason; baseJobId: string | null };

// 무료 재연결 판정. 기준 = 가장 최근에 돈을 내고(처음 연결·재설치) 완료한 작업.
// 무료 재연결의 완료는 30일을 늘리지 않는다(연달아 무료로 이어 붙이지 못하게).
// 무료 조건: 그 완료 시각(DB 시계)부터 30일 안 + 같은 쇼핑몰 + 같은 PC(OBS pairing) + 연결 권한이 해제되지 않음.
export async function decideReconnect(db: PrismaClient | Prisma.TransactionClient, sellerId: string, target: ReconnectTarget): Promise<FreeDecision> {
  const base = await db.automationJob.findFirst({
    where: { sellerId, status: "SUCCEEDED", kind: { in: ["INITIAL", "REINSTALL"] } },
    orderBy: { finishedAt: "desc" },
  });
  if (!base?.finishedAt) return { free: false, reason: "no_completed_install", baseJobId: null };
  const now = await dbNow(db);
  if (now.getTime() - base.finishedAt.getTime() > FREE_RECONNECT_DAYS * 24 * 60 * 60_000) return { free: false, reason: "window_expired", baseJobId: base.id };
  if (base.shopKey !== target.shopKey) return { free: false, reason: "shop_changed", baseJobId: base.id };
  if (base.obsPairingId !== target.obsPairingId) return { free: false, reason: "pc_changed", baseJobId: base.id };
  if (base.connectionRevokedAt) return { free: false, reason: "connection_revoked", baseJobId: base.id };
  return { free: true, baseJobId: base.id };
}

const isTarget = (v: unknown): v is ReconnectTarget => {
  const t = v as Partial<ReconnectTarget> | null;
  const ok = (s: unknown) => typeof s === "string" && s.length > 0 && s.length <= 200;
  return !!t && ok(t.shopKey) && ok(t.obsPairingId);
};

export type ReconnectResult = PurchaseResult | { ok: false; reason: "bad_target" } | { ok: false; reason: "payment_required"; paidReason: PaidReason; price: number };

// 재연결 요청. 무료 대상이면 결제 없이 바로 대기열에 넣는다. 아니면 33,000원 재설치로 결제한다
// (결제 동의·Idempotency-Key가 있어야 하고, 동의 없이 오면 금액과 사유만 돌려준다 — 화면이 안내 후 다시 보낸다).
export async function reconnectAutomation(
  db: PrismaClient,
  provider: BillingProvider,
  ctx: TenantContext,
  input: { idempotencyKey: unknown; consent?: unknown; target: unknown; shopUrl?: unknown },
): Promise<ReconnectResult> {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  if (!isTarget(input.target)) return { ok: false, reason: "bad_target" };
  const target = input.target;
  const decision = await decideReconnect(db, ctx.sellerId, target);
  const obsTargetKey = `obs:${target.obsPairingId}`;
  if (!decision.free) {
    if (input.consent === undefined) return { ok: false, reason: "payment_required", paidReason: decision.reason, price: REINSTALL_PRICE };
    return buyPaidJob(db, provider, ctx, { idempotencyKey: input.idempotencyKey, consent: input.consent, shopUrl: input.shopUrl, kind: "REINSTALL", baseJobId: decision.baseJobId ?? undefined, obsTargetKey });
  }
  try {
    const job = await db.$transaction(async (tx) => {
      const now = await dbNow(tx);
      const j = await tx.automationJob.create({
        data: { sellerId: ctx.sellerId, kind: "RECONNECT_FREE", costLimit: plannerConfig().costLimitWon, ...playbookFields(input.shopUrl), baseJobId: decision.baseJobId, status: "QUEUED", runAfter: now, obsTargetKey },
      });
      await writeJobEvent(tx, j, null, "QUEUED", 0, { freeReconnectOf: decision.baseJobId });
      await writeAudit(tx, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        sellerId: ctx.sellerId,
        action: "automation.reconnect_free",
        targetType: "AutomationJob",
        targetId: j.id,
        after: { baseJobId: decision.baseJobId },
      });
      return j;
    });
    return { ok: true, jobId: job.id, kind: job.kind, paymentStatus: null, jobStatus: job.status, replayed: false };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const open = await db.automationJob.findFirst({ where: { sellerId: ctx.sellerId, status: OPEN }, select: { id: true } });
    return { ok: false, reason: "job_in_progress", jobId: open?.id };
  }
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
      // 결제 확정 전에 취소된(연결을 시작하지 않은) 작업에 결제가 들어왔다: 환불 처리 대기로 둔다(실제 환불은 승인 뒤)
      else if (status === "PAID") {
        await tx.automationPayment.update({ where: { id: paymentId }, data: { status: "REFUND_PENDING", refundReason: "canceled_before_start", refundRequestedAt: now } });
        await writeAudit(tx, {
          actorType: "SYSTEM",
          sellerId: payment.sellerId,
          action: "automation.paid_after_cancel",
          targetType: "AutomationPayment",
          targetId: payment.id,
          after: { jobStatus: job.status, amount: payment.amount },
        });
        return "REFUND_PENDING";
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
