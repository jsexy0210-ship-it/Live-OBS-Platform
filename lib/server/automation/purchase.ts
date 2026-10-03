import { createHash } from "node:crypto";
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
import type { Playbook } from "./playbook";
import { findPlaybook, playbookForShopUrl, shopHostOf } from "./playbooks";
import { playbookReadiness } from "./practice";
import { dbNow, lockJob, writeJobEvent } from "./queue";

// 자동 연결 결제. 결제는 기존 billing 공통 구조(BillingProvider, 등록된 카드 빌링키, 청구 id = orderId로 PG 중복 방지)를 그대로 쓴다.
// 실행 권한(작업 QUEUED)은 서버가 PG에 결제 결과를 직접 조회해 PAID를 확인한 트랜잭션에서만 준다.
// 브라우저 성공 리다이렉트·클라이언트 값으로는 실행되지 않는다(그런 경로가 없다).

const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;
const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
const OPEN = { notIn: ["SUCCEEDED", "FAILED", "CANCELED"] as AutomationJob["status"][] };

type Failure = "bad_idempotency_key" | "idempotency_key_reused" | "shop_not_supported" | "consent_required" | "consent_outdated" | "card_required" | "job_in_progress" | "payment_failed";
export type PurchaseResult =
  | { ok: true; jobId: string; kind: AutomationJob["kind"]; paymentStatus: AutomationPayment["status"] | null; jobStatus: AutomationJob["status"]; replayed: boolean }
  | { ok: false; reason: Failure; jobId?: string };

// 실패 사유별 HTTP 상태(라우트용)
export const PURCHASE_FAILURE_STATUS: Record<Failure, number> = {
  bad_idempotency_key: 400,
  idempotency_key_reused: 409,
  shop_not_supported: 409,
  consent_required: 400,
  consent_outdated: 409,
  card_required: 409,
  job_in_progress: 409,
  payment_failed: 402,
};

// 지원 목록(연습으로 검증된 작업서)에 있는 쇼핑몰인지. 판매자는 플랫폼을 고르지 않고 쇼핑몰 주소만 낸다.
// 작업서가 없거나 검증 전이면 결제 전에 거부한다(MASTER 판단 2026-10-04: 대표님 원지시 「개별 검증 후 지원 목록에 추가」).
export async function supportedPlaybookFor(db: PrismaClient, shopUrl: unknown): Promise<Playbook | null> {
  const pb = typeof shopUrl === "string" && shopUrl.length <= 300 ? playbookForShopUrl(shopUrl) : null;
  return pb && (await playbookReadiness(db, pb)).verified ? pb : null;
}

// 거부 안내 문구(화면 문구 정본은 디자인 쪽). 플랫폼 이름을 넣지 않는다.
export const SHOP_NOT_SUPPORTED_MESSAGE = "아직 자동 연결할 수 없는 쇼핑몰이에요. 직접 설정으로 연결해 주세요";

// 결제가 실패한 요청은 재전송해도 실패로 돌려준다(처음 응답과 같게)
const view = (p: AutomationPayment & { job: AutomationJob | null }, replayed: boolean): PurchaseResult =>
  p.job && p.status !== "FAILED"
    ? { ok: true, jobId: p.job.id, kind: p.job.kind, paymentStatus: p.status, jobStatus: p.job.status, replayed }
    : { ok: false, reason: "payment_failed", jobId: p.job?.id };

// 결제 전 고지 동의 확인. 체크 해제·문자열 true·예전 문구 버전은 거부한다.
function consentProblem(consent: unknown): "consent_required" | "consent_outdated" | null {
  const c = consent as { agreed?: unknown; noticeVersion?: unknown } | null | undefined;
  if (!c || c.agreed !== true) return "consent_required";
  return c.noticeVersion === AUTOMATION_CONSENT.version ? null : "consent_outdated";
}

// 요청 지문: 같은 Idempotency-Key가 같은 요청(종류·쇼핑몰 주소·재설치 대상)에서 온 재전송인지 가린다.
export function requestFingerprint(kind: "INITIAL" | "REINSTALL" | "RECONNECT", shopUrl: unknown, target?: { shopKey: string; obsPairingId: string }): string {
  const url = typeof shopUrl === "string" ? shopUrl.trim() : "";
  return createHash("sha256")
    .update(JSON.stringify([kind, url, target?.shopKey ?? null, target?.obsPairingId ?? null]))
    .digest("hex");
}

// 키가 이미 쓰였는지: 유료 요청은 결제 행에, 무료 재연결은 작업 행에 키·지문이 있다. 같은 지문이면 처음 결과, 다르면 재사용 거부.
async function priorUse(db: PrismaClient, sellerId: string, key: string, fingerprint: string): Promise<PurchaseResult | null> {
  const p = await db.automationPayment.findUnique({ where: { sellerId_idempotencyKey: { sellerId, idempotencyKey: key } }, include: { job: true } });
  if (p) return p.requestFingerprint === fingerprint ? view(p, true) : { ok: false, reason: "idempotency_key_reused" };
  const j = await db.automationJob.findUnique({ where: { sellerId_idempotencyKey: { sellerId, idempotencyKey: key } } });
  if (j) return j.requestFingerprint === fingerprint ? { ok: true, jobId: j.id, kind: j.kind, paymentStatus: null, jobStatus: j.status, replayed: true } : { ok: false, reason: "idempotency_key_reused" };
  return null;
}

type PaidJobInput = {
  idempotencyKey: unknown;
  fingerprint: string;
  consent: unknown;
  // 지원 목록 작업서 고르기(결제 전에 부른다). 없으면 shop_not_supported
  resolvePlaybook: () => Promise<Playbook | null>;
  kind: "INITIAL" | "REINSTALL";
  baseJobId?: string;
  obsTargetKey?: string;
  shopHost: string | null;
};

// 판매자 대표자가 자동 연결을 산다(110,000원). 같은 Idempotency-Key로 다시 오면 처음 결과를 돌려준다(결제·작업을 새로 만들지 않음).
// 다른 키로 연타해도 판매자당 열린 작업 1개(부분 유니크)라 두 번째 결제가 생기지 않는다.
export async function purchaseAutomation(
  db: PrismaClient,
  provider: BillingProvider,
  ctx: TenantContext,
  input: { idempotencyKey: unknown; consent: unknown; shopUrl?: unknown },
): Promise<PurchaseResult> {
  return buyPaidJob(db, provider, ctx, {
    ...input,
    kind: "INITIAL",
    shopHost: shopHostOf(input.shopUrl),
    fingerprint: requestFingerprint("INITIAL", input.shopUrl),
    resolvePlaybook: () => supportedPlaybookFor(db, input.shopUrl),
  });
}

async function buyPaidJob(db: PrismaClient, provider: BillingProvider, ctx: TenantContext, input: PaidJobInput): Promise<PurchaseResult> {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  const key = input.idempotencyKey;
  if (typeof key !== "string" || !KEY_RE.test(key)) return { ok: false, reason: "bad_idempotency_key" };

  // 같은 키 재전송이면 처음 결과를 돌려준다. 같은 키를 다른 요청에 다시 쓰면 거부한다(엉뚱한 예전 작업을 돌려주지 않게).
  const replay = () => priorUse(db, ctx.sellerId, key, input.fingerprint);
  const existing = await replay();
  if (existing) return existing;
  const playbook = await input.resolvePlaybook();
  if (!playbook) return { ok: false, reason: "shop_not_supported" };
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
        data: { sellerId: ctx.sellerId, amount, idempotencyKey: key, requestFingerprint: input.fingerprint, consentNoticeVersion: AUTOMATION_CONSENT.version, consentAgreedAt: now },
      });
      const job = await tx.automationJob.create({
        // OBS 대상 키: 처음 연결은 판매자 단위(아직 PC를 모름), 재설치는 알고 있는 pairing 단위
        data: {
          sellerId: ctx.sellerId,
          kind: input.kind,
          paymentId: payment.id,
          costLimit: plannerConfig().costLimitWon,
          playbookId: playbook.id,
          playbookVersion: playbook.version,
          shopHost: input.shopHost,
          baseJobId: input.baseJobId,
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

  // 여기서 멈춰도(결제 요청 전) 결제 요청 기록이 비어 있어 대사가 같은 청구 id로 보낸다
  await submitCharge(db, provider, created.payment.id, billingKey, null);
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

export type ReconnectResult = PurchaseResult | { ok: false; reason: "bad_target" } | { ok: false; reason: "shop_not_supported"; jobId?: undefined } | { ok: false; reason: "payment_required"; paidReason: PaidReason; price: number };

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
  const key = input.idempotencyKey;
  if (typeof key !== "string" || !KEY_RE.test(key)) return { ok: false, reason: "bad_idempotency_key" };
  const fingerprint = requestFingerprint("REINSTALL", input.shopUrl, target);
  // 같은 요청 재전송이면 처음 결과(무료·유료 모두), 다른 요청에 쓰인 키면 무료·유료 판정 전에 거부한다
  const prior = await priorUse(db, ctx.sellerId, key, fingerprint);
  if (prior) return prior;
  const decision = await decideReconnect(db, ctx.sellerId, target);
  const obsTargetKey = `obs:${target.obsPairingId}`;
  const base = decision.baseJobId ? await db.automationJob.findFirst({ where: { id: decision.baseJobId, sellerId: ctx.sellerId }, select: { playbookId: true, shopHost: true } }) : null;
  // 비밀값을 넣을 쇼핑몰 호스트: 새 주소가 오면 그 주소, 없으면 이전 완료 작업의 것
  const shopHost = input.shopUrl !== undefined ? shopHostOf(input.shopUrl) : (base?.shopHost ?? null);
  // 쇼핑몰 주소가 오면 그 주소로, 없으면 이전 완료 작업의 작업서로. 어느 쪽이든 지금 지원 목록에 있어야 한다.
  const resolvePlaybook = async (): Promise<Playbook | null> => {
    if (input.shopUrl !== undefined) return supportedPlaybookFor(db, input.shopUrl);
    const pb = findPlaybook(base?.playbookId);
    return pb && (await playbookReadiness(db, pb)).verified ? pb : null;
  };
  const playbook = await resolvePlaybook();
  if (!playbook) return { ok: false, reason: "shop_not_supported" };
  if (!decision.free) {
    if (input.consent === undefined) return { ok: false, reason: "payment_required", paidReason: decision.reason, price: REINSTALL_PRICE };
    return buyPaidJob(db, provider, ctx, { idempotencyKey: input.idempotencyKey, consent: input.consent, fingerprint, resolvePlaybook: async () => playbook, kind: "REINSTALL", baseJobId: decision.baseJobId ?? undefined, obsTargetKey, shopHost });
  }
  try {
    const job = await db.$transaction(async (tx) => {
      const now = await dbNow(tx);
      const j = await tx.automationJob.create({
        data: { sellerId: ctx.sellerId, kind: "RECONNECT_FREE", costLimit: plannerConfig().costLimitWon, playbookId: playbook.id, playbookVersion: playbook.version, shopHost, baseJobId: decision.baseJobId, status: "QUEUED", runAfter: now, obsTargetKey, idempotencyKey: key, requestFingerprint: fingerprint },
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
    // 같은 키가 동시에 들어왔으면 먼저 만든 쪽을 돌려준다
    const again = await priorUse(db, ctx.sellerId, key, fingerprint);
    if (again) return again;
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
  // resentNow: 이번 회차에 결제 요청을 (다시) 보냈다. PG 반영이 늦을 수 있어 이번 회차에는 「결제 안 됨」으로 확정하지 않는다.
  opts: { notChargedAfterMs?: number; resentNow?: boolean } = {},
): Promise<AutomationPayment["status"]> {
  const found = await provider.getPayment(paymentId);
  return db.$transaction(async (tx) => {
    const now = await dbNow(tx);
    const payment = await tx.automationPayment.findUniqueOrThrow({ where: { id: paymentId }, include: { job: true } });
    if (payment.status !== "PENDING") return payment.status;
    // 「결제 안 됨」 마감은 마지막으로 결제 요청을 보낸 시각부터 센다(다시 보냈으면 그때부터 다시)
    const ageMs = now.getTime() - (payment.chargeSubmittedAt ?? payment.createdAt).getTime();
    let status: "PAID" | "FAILED" | null = null;
    let failureReason: string | null = null;
    if (found.status === "PAID") status = "PAID";
    else if (found.status === "FAILED") [status, failureReason] = ["FAILED", found.reason.slice(0, 200)];
    else if (!opts.resentNow && ageMs >= (opts.notChargedAfterMs ?? AUTOMATION_LIMITS.notChargedAfterMs)) [status, failureReason] = ["FAILED", "not_charged"];
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

// 결제 요청 보내기(outbox). 작업이 결제 대기(AWAITING_PAYMENT)이고 청구가 PENDING이며, 보낸 적이 없거나(null)
// 마지막으로 보낸 지 resendBefore보다 오래됐을 때만 「보냄」을 먼저 기록하고 같은 청구 id(orderId)로 보낸다.
// 같은 청구 id는 PG가 한 번만 결제하므로(공통 billing 계약) 다시 보내도 이중 결제가 없다. 작업자 둘이 동시에 보내지 않게 작업 행을 잠근다.
async function submitCharge(db: PrismaClient, provider: BillingProvider, paymentId: string, billingKey: string, resendBefore: Date | null): Promise<boolean> {
  const claimed = await db.$transaction(async (tx) => {
    const p = await tx.automationPayment.findUniqueOrThrow({ where: { id: paymentId }, include: { job: { select: { id: true, kind: true } } } });
    if (!p.job) return null;
    await lockJob(tx, p.job.id);
    const r = await tx.automationPayment.updateMany({
      where: {
        id: paymentId,
        status: "PENDING",
        job: { is: { status: "AWAITING_PAYMENT" } },
        OR: resendBefore ? [{ chargeSubmittedAt: null }, { chargeSubmittedAt: { lte: resendBefore } }] : [{ chargeSubmittedAt: null }],
      },
      data: { chargeSubmittedAt: await dbNow(tx) },
    });
    return r.count === 1 ? { sellerId: p.sellerId, amount: p.amount, kind: p.job.kind } : null;
  });
  if (!claimed) return false;
  try {
    await provider.charge({
      billingKey,
      customerKey: claimed.sellerId,
      amount: claimed.amount,
      orderId: paymentId,
      orderName: claimed.kind === "INITIAL" ? AUTOMATION_ORDER_NAME : REINSTALL_ORDER_NAME,
    });
  } catch {
    // 결과를 모른다. PENDING으로 두고 대사(reconcile)가 같은 청구 id로 PG에 확인한다.
  }
  return true;
}

// 결과를 못 받은(PENDING) 청구를 PG에 다시 묻는다. 작업자 반복에서 부른다. 확정한 건수를 돌려준다.
// PG에 기록이 없으면(결제 요청 전에 멈췄거나 요청이 PG에 닿지 않음) 결제 대기 작업에 한해 같은 청구 id로 다시 보낸다.
export async function reconcileAutomationPayments(db: PrismaClient, provider: BillingProvider, opts: { olderThanMs?: number } = {}): Promise<number> {
  const cutoff = new Date((await dbNow(db)).getTime() - (opts.olderThanMs ?? AUTOMATION_LIMITS.reconcileAfterMs));
  const stale = await db.automationPayment.findMany({ where: { status: "PENDING", createdAt: { lte: cutoff } }, select: { id: true, sellerId: true }, take: 50 });
  let settled = 0;
  for (const p of stale) {
    // 한 건 조회가 실패해도 나머지는 계속 확인한다
    let resentNow = false;
    try {
      if ((await provider.getPayment(p.id)).status === "NOT_FOUND") {
        const sub = await db.sellerSubscription.findUnique({ where: { sellerId: p.sellerId }, select: { billingKeyCipher: true } });
        if (sub?.billingKeyCipher) resentNow = await submitCharge(db, provider, p.id, openBillingKey(sub.billingKeyCipher, p.sellerId), cutoff);
      }
    } catch {
      // 조회·다시 보내기가 실패해도 아래 확인(마감 처리 포함)은 한다
    }
    const status = await verifyAndSettle(db, provider, p.id, { resentNow }).catch(() => "PENDING" as const);
    if (status !== "PENDING") settled++;
  }
  return settled;
}
