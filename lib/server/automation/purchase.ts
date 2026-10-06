import { createHash } from "node:crypto";
import { Prisma, type AutomationJob, type AutomationPayment, type PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import type { AuthResult, PaymentGateway, PgCard, PgPayment } from "../payments/gateway";
import type { BillingProvider, PaymentLookup } from "../billing/provider";
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
import { budgetOpen, PLANNER_PROVIDER } from "./budget";
import { externalId } from "./boundary";
import { callPort, valueOrThrow } from "./engine";
import type { Playbook } from "./playbook";
import { findPlaybook, playbookForShopUrl, shopHostOf } from "./playbooks";
import { playbookReadiness } from "./practice";
import { dbNow, lockJob, lockPlaybook, lockSellerAutomation, writeJobEvent } from "./queue";

// 자동 연결 결제. 결제는 기존 billing 공통 구조(BillingProvider, 등록된 카드 빌링키, 청구 id = orderId로 PG 중복 방지)를 그대로 쓴다.
// 실행 권한(작업 QUEUED)은 서버가 PG에 결제 결과를 직접 조회해 PAID를 확인한 트랜잭션에서만 준다.
// 브라우저 성공 리다이렉트·클라이언트 값으로는 실행되지 않는다(그런 경로가 없다).

const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;
const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
const OPEN = { notIn: ["SUCCEEDED", "FAILED", "CANCELED"] as AutomationJob["status"][] };

type Failure =
  | "bad_idempotency_key"
  | "idempotency_key_reused"
  | "shop_not_supported"
  | "consent_required"
  | "consent_outdated"
  | "card_required"
  | "job_in_progress"
  | "payment_failed"
  // 유료 재설치를 결제하려는 사이 무료 재연결 조건이 됐다(결제하지 않음, 무료 재연결로 다시 요청)
  | "free_reconnect_available"
  // 쇼핑몰이 바뀐 재설치인데 새 쇼핑몰 주소가 없다(이전 쇼핑몰로 설치하지 않음, 결제하지 않음)
  | "shop_url_required"
  // 외부 API 월 한도에 닿아 이번 달 새 구매를 받지 않는다(결제하지 않음)
  | "service_paused";
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
  free_reconnect_available: 409,
  shop_url_required: 400,
  service_paused: 503,
};

// 작업 확정 트랜잭션 안에서 다시 계산해 거절할 때(트랜잭션을 되돌린다)
class PurchaseAborted extends Error {
  constructor(
    readonly reason: "shop_not_supported" | "free_reconnect_available" | "payment_required" | "shop_url_required",
    readonly paidReason?: PaidReason,
  ) {
    super(reason);
  }
}

type CommitPlan = {
  kind: "INITIAL" | "REINSTALL" | "RECONNECT_FREE";
  key: string;
  fingerprint: string;
  playbook: Playbook;
  shopHost: string | null;
  obsTargetKey: string;
  // 재연결·재설치 대상. 있으면 잠금 안에서 무료 재연결 판정(기준 설치 포함)을 다시 계산하고 그 값으로 저장한다.
  target?: ReconnectTarget;
  // 재설치 요청에 새 쇼핑몰 주소가 있었는가(쇼핑몰이 바뀐 재설치는 주소가 있어야 한다)
  shopUrlGiven?: boolean;
  // 유료만: 금액
  amount?: number;
  // 유료만: 결제 수단(기본 구독 카드 빌링키)
  method?: AutomationPayment["method"];
};

// 작업 확정(유료 첫 연결·유료 재설치·무료 재연결 공통). 한 트랜잭션에서 순서대로:
// 판매자 잠금 → 작업서 공유 잠금 → 결제(유료만)·작업 행 → 무료 재연결 판정 재계산(기준 설치 포함) → 작업서 준비 상태 재계산.
// 바깥에서 미리 계산한 값은 화면 안내용일 뿐이고, 저장은 여기서 다시 계산한 값으로만 한다. 결제 제출은 커밋 뒤 호출자가 한다(유료만).
async function commitJob(db: PrismaClient, ctx: TenantContext, plan: CommitPlan): Promise<{ payment: AutomationPayment | null; job: AutomationJob }> {
  return db.$transaction(async (tx) => {
    await lockSellerAutomation(tx, ctx.sellerId);
    await lockPlaybook(tx, plan.playbook.id, "shared");
    const now = await dbNow(tx);
    const paid = plan.kind !== "RECONNECT_FREE";
    const payment = paid
      ? await tx.automationPayment.create({
          data: { sellerId: ctx.sellerId, amount: plan.amount!, method: plan.method ?? "BILLING_KEY", idempotencyKey: plan.key, requestFingerprint: plan.fingerprint, consentNoticeVersion: AUTOMATION_CONSENT.version, consentAgreedAt: now },
        })
      : null;
    let job = await tx.automationJob.create({
      // OBS 대상 키: 처음 연결은 판매자 단위(아직 PC를 모름), 재설치·재연결은 요청한 pairing 단위(실행 때 실제 PC로 옮김)
      data: {
        sellerId: ctx.sellerId,
        kind: plan.kind,
        paymentId: payment?.id,
        ...(plan.target ? { targetShopKey: plan.target.shopKey, targetObsPairingId: plan.target.obsPairingId } : {}),
        costLimit: plannerConfig().costLimitWon,
        playbookId: plan.playbook.id,
        playbookVersion: plan.playbook.version,
        shopHost: plan.shopHost,
        obsTargetKey: plan.obsTargetKey,
        ...(paid ? {} : { status: "QUEUED" as const, runAfter: now, queuedAt: now, idempotencyKey: plan.key, requestFingerprint: plan.fingerprint }),
      },
    });
    // 잠금 안에서 다시 계산한 판정으로만 저장한다
    if (plan.target) {
      const decision = await decideReconnect(tx, ctx.sellerId, plan.target);
      if (plan.kind === "RECONNECT_FREE" && !decision.free) throw new PurchaseAborted("payment_required", decision.reason);
      if (plan.kind === "REINSTALL" && decision.free) throw new PurchaseAborted("free_reconnect_available");
      // 쇼핑몰이 바뀐 재설치는 새 쇼핑몰 주소로만(주소가 없으면 이전 쇼핑몰 호스트로 설치하게 되므로 결제하지 않는다)
      if (plan.kind === "REINSTALL" && !decision.free && decision.reason === "shop_changed" && !plan.shopUrlGiven) throw new PurchaseAborted("shop_url_required");
      if (decision.baseJobId) job = await tx.automationJob.update({ where: { id: job.id }, data: { baseJobId: decision.baseJobId } });
    }
    if (!(await playbookReadiness(tx, plan.playbook)).verified) throw new PurchaseAborted("shop_not_supported");
    await writeJobEvent(tx, job, null, job.status, 0, plan.kind === "RECONNECT_FREE" ? { freeReconnectOf: job.baseJobId } : undefined);
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: plan.kind === "INITIAL" ? "automation.purchase" : plan.kind === "REINSTALL" ? "automation.reinstall_purchase" : "automation.reconnect_free",
      targetType: "AutomationJob",
      targetId: job.id,
      after: payment ? { amount: payment.amount, paymentId: payment.id, consentNoticeVersion: AUTOMATION_CONSENT.version } : { baseJobId: job.baseJobId },
    });
    return { payment, job };
  });
}

// 지원 목록(연습으로 검증된 작업서)에 있는 쇼핑몰인지. 판매자는 플랫폼을 고르지 않고 쇼핑몰 주소만 낸다.
// 작업서가 없거나 검증 전이면 결제 전에 거부한다(MASTER 판단 2026-10-04: 대표님 원지시 「개별 검증 후 지원 목록에 추가」).
export async function supportedPlaybookFor(db: PrismaClient, shopUrl: unknown): Promise<Playbook | null> {
  const pb = typeof shopUrl === "string" && shopUrl.length <= 300 ? playbookForShopUrl(shopUrl) : null;
  return pb && (await playbookReadiness(db, pb)).verified ? pb : null;
}

// 거부 안내 문구(화면 문구 정본은 디자인 쪽). 파트너스 관리자 API라 합니다체. 플랫폼 이름을 넣지 않는다.
export const SHOP_NOT_SUPPORTED_MESSAGE = "아직 자동 연결할 수 없는 쇼핑몰입니다. 직접 설정으로 연결해 주십시오";

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
export function requestFingerprint(kind: "INITIAL" | "INITIAL_ONE_TIME" | "REINSTALL" | "RECONNECT", shopUrl: unknown, target?: { shopKey: string; obsPairingId: string }): string {
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
  obsTargetKey?: string;
  shopHost: string | null;
  // 유료 재설치: 커밋 직전 무료 재연결 판정을 다시 계산할 대상
  reconnectTarget?: ReconnectTarget;
  shopUrlGiven?: boolean;
  // 「다른 카드로 결제」(일반 결제창): 저장 카드·빌링키를 쓰지 않고, 결제 행·작업 행만 만든 채 결제창 승인을 기다린다
  oneTime?: boolean;
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

async function buyPaidJob(db: PrismaClient, provider: BillingProvider | null, ctx: TenantContext, input: PaidJobInput): Promise<PurchaseResult> {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  const key = input.idempotencyKey;
  if (typeof key !== "string" || !KEY_RE.test(key)) return { ok: false, reason: "bad_idempotency_key" };

  // 같은 키 재전송이면 처음 결과를 돌려준다. 같은 키를 다른 요청에 다시 쓰면 거부한다(엉뚱한 예전 작업을 돌려주지 않게).
  const replay = () => priorUse(db, ctx.sellerId, key, input.fingerprint);
  const existing = await replay();
  if (existing) return existing;
  const playbook = await input.resolvePlaybook();
  if (!playbook) return { ok: false, reason: "shop_not_supported" };
  if (!(await budgetOpen(db, PLANNER_PROVIDER))) return { ok: false, reason: "service_paused" };
  const problem = consentProblem(input.consent);
  if (problem) return { ok: false, reason: problem };

  let billingKey = "";
  if (input.oneTime) {
    // 이전에 결제창을 열고 끝내지 않은 이번 한 번 결제(승인 요청 전)는 닫아 열린 작업 칸을 푼다. 늦게 인증이 와도 승인하지 않는다(돈이 움직이지 않음).
    await abandonOneTimeAttempts(db, ctx.sellerId);
  } else {
    const sub = await db.sellerSubscription.findUnique({ where: { sellerId: ctx.sellerId }, select: { billingKeyCipher: true } });
    if (!sub?.billingKeyCipher) return { ok: false, reason: "card_required" };
    billingKey = openBillingKey(sub.billingKeyCipher, ctx.sellerId);
  }
  const amount = input.kind === "INITIAL" ? AUTOMATION_PRICE : REINSTALL_PRICE;

  let created: { payment: AutomationPayment; job: AutomationJob };
  try {
    const r = await commitJob(db, ctx, {
      kind: input.kind,
      key,
      fingerprint: input.fingerprint,
      playbook,
      shopHost: input.shopHost,
      obsTargetKey: input.obsTargetKey ?? `seller:${ctx.sellerId}`,
      target: input.reconnectTarget,
      shopUrlGiven: input.shopUrlGiven,
      amount,
      method: input.oneTime ? "ONE_TIME_CARD" : "BILLING_KEY",
    });
    created = { payment: r.payment!, job: r.job };
  } catch (e) {
    if (e instanceof PurchaseAborted) {
      // 유료 첫 연결·재설치에서 payment_required는 나오지 않는다(무료 경로만)
      return { ok: false, reason: e.reason === "payment_required" ? "shop_not_supported" : e.reason };
    }
    if (!isUniqueViolation(e)) throw e;
    // 같은 키가 동시에 들어왔으면 먼저 만든 쪽을 돌려준다
    const again = await replay();
    if (again) return again;
    const open = await db.automationJob.findFirst({ where: { sellerId: ctx.sellerId, status: OPEN }, select: { id: true } });
    return { ok: false, reason: "job_in_progress", jobId: open?.id };
  }

  // 일반 결제창은 브라우저 인증 결과(returnUrl)가 와야 승인한다. 여기서는 만들기만 한다.
  if (input.oneTime) return view({ ...created.payment, job: created.job }, false);
  if (!provider) throw new Error("billing_provider_required");
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
  // 기준 작업이 만들어진 뒤에 온 해제(작업이 진행 중일 때 온 것 포함)도 무료가 아니다
  const revoked = base.shopKey ? await db.automationShopRevocation.findUnique({ where: { sellerId_shopKey: { sellerId, shopKey: base.shopKey } } }) : null;
  if (revoked && revoked.revokedAt >= base.createdAt) return { free: false, reason: "connection_revoked", baseJobId: base.id };
  return { free: true, baseJobId: base.id };
}

const isTarget = (v: unknown): v is ReconnectTarget => {
  const t = v as Partial<ReconnectTarget> | null;
  // 저장·대조에 쓰는 외부 식별자 규칙(boundary.ts externalId)과 같게: 1~200자, 제어 문자 없음. 결제·작업 생성 전에 거절한다
  const ok = (s: unknown) => { const r = externalId(s); return r.ok && r.value !== null; };
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
    // 쇼핑몰이 바뀐 재설치는 올바른 새 쇼핑몰 주소가 있어야 결제한다(없으면 이전 쇼핑몰로 설치하게 됨). 결제 0건으로 거절
    if (decision.reason === "shop_changed" && !shopHostOf(input.shopUrl)) return { ok: false, reason: "shop_url_required" };
    return buyPaidJob(db, provider, ctx, { idempotencyKey: input.idempotencyKey, consent: input.consent, fingerprint, resolvePlaybook: async () => playbook, kind: "REINSTALL", obsTargetKey, shopHost, reconnectTarget: target, shopUrlGiven: !!shopHostOf(input.shopUrl) });
  }
  try {
    // 무료 재연결도 같은 확정 함수로: 잠금 안에서 판정(기준 설치 포함)·준비 상태를 다시 계산한 값으로만 저장한다
    const { job } = await commitJob(db, ctx, { kind: "RECONNECT_FREE", key, fingerprint, playbook, shopHost, obsTargetKey, target });
    return { ok: true, jobId: job.id, kind: job.kind, paymentStatus: null, jobStatus: job.status, replayed: false };
  } catch (e) {
    if (e instanceof PurchaseAborted) {
      if (e.reason === "payment_required") return { ok: false, reason: "payment_required", paidReason: e.paidReason!, price: REINSTALL_PRICE };
      return { ok: false, reason: e.reason === "free_reconnect_available" ? "shop_not_supported" : e.reason };
    }
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
  opts: { notChargedAfterMs?: number } = {},
): Promise<AutomationPayment["status"]> {
  // 결제 조회도 외부 호출 계약(callPort)을 거친다: 상한을 넘기면 던져(결제는 PENDING 그대로) 대사가 다음 회차에 다시 묻는다
  const found = valueOrThrow(await callPort(() => provider.getPayment(paymentId)));
  return settleFound(db, paymentId, found, opts);
}

// PG(또는 결제창 승인)가 알려 준 결과를 결제·작업에 반영한다. 구독 카드(빌링키)·일반 결제창 모두 이 한 곳에서 확정한다.
async function settleFound(db: PrismaClient, paymentId: string, found: PaymentLookup, opts: { notChargedAfterMs?: number; card?: PgCard } = {}): Promise<AutomationPayment["status"]> {
  return db.$transaction(async (tx) => {
    // 잠금 순서(작업 행 → 결제 행)대로 잡은 뒤의 실제 시각으로 마감을 판단한다(잠금 대기 중 흐른 시간 포함)
    const head = await tx.automationPayment.findUniqueOrThrow({ where: { id: paymentId }, select: { job: { select: { id: true } } } });
    if (head.job) await lockJob(tx, head.job.id);
    await tx.$queryRaw`SELECT id FROM "AutomationPayment" WHERE id = ${paymentId}::uuid FOR UPDATE`;
    const now = await dbNow(tx);
    const payment = await tx.automationPayment.findUniqueOrThrow({ where: { id: paymentId }, include: { job: true } });
    if (payment.status !== "PENDING") return payment.status;
    // 「결제 안 됨」 마감은 첫 제출 + 30분으로 고정한다(다시 보내도 늘지 않음). 마감 뒤에도 마지막 제출에서 반영 지연 유예(2분)가 지나야 작업을 닫는다.
    // PG가 결과를 확정해 주지 않으면(조회 안 됨) 결제는 실패로 확정하지 않는다: 늦게 승인될 수 있어 대사 대상(PENDING)으로 남긴다.
    const sinceFirst = now.getTime() - (payment.chargeFirstSubmittedAt ?? payment.createdAt).getTime();
    const sinceLast = now.getTime() - (payment.chargeSubmittedAt ?? payment.createdAt).getTime();
    const notCharged = sinceFirst >= (opts.notChargedAfterMs ?? AUTOMATION_LIMITS.notChargedAfterMs) && sinceLast >= AUTOMATION_LIMITS.chargeLookupGraceMs;
    let status: "PAID" | "FAILED" | null = null;
    let failureReason: string | null = null;
    if (found.status === "PAID") status = "PAID";
    else if (found.status === "FAILED") [status, failureReason] = ["FAILED", found.reason.slice(0, 200)];
    if (!status) {
      // 마감이 지났으면 작업만 닫아 열린 작업 칸을 푼다(다시 보내지 않음). 그 뒤 승인이 확인되면 아래에서 환불 처리 대기로 간다
      if (notCharged && payment.job) {
        const closed = await tx.automationJob.updateMany({ where: { id: payment.job.id, status: "AWAITING_PAYMENT" }, data: { status: "FAILED", lastError: "payment_unresolved", finishedAt: now } });
        if (closed.count === 1) await writeJobEvent(tx, payment.job, "AWAITING_PAYMENT", "FAILED", payment.job.fencingToken, { paymentStatus: "PENDING" });
      }
      // 오래 미확정이면 마스터 관리자 알림 1건(대사는 계속)
      if (!payment.unresolvedAlertedAt && now.getTime() - payment.createdAt.getTime() >= AUTOMATION_LIMITS.paymentUnresolvedAlertMs) {
        await tx.automationPayment.update({ where: { id: paymentId }, data: { unresolvedAlertedAt: now } });
        await writeAudit(tx, { actorType: "SYSTEM", sellerId: payment.sellerId, action: "automation.payment_unresolved", targetType: "AutomationPayment", targetId: payment.id, after: { amount: payment.amount } });
      }
      return "PENDING";
    }

    const claimed = await tx.automationPayment.updateMany({
      where: { id: paymentId, status: "PENDING" },
      data:
        status === "PAID"
          ? { status, paidAt: now, providerPaymentId: found.status === "PAID" ? found.paymentId : null, ...(opts.card ? { cardName: opts.card.name, cardLast4: opts.card.last4 } : {}) }
          : { status, failureReason },
    });
    if (claimed.count !== 1) return (await tx.automationPayment.findUniqueOrThrow({ where: { id: paymentId } })).status;

    const job = payment.job;
    if (job) {
      const to = status === "PAID" ? "QUEUED" : "FAILED";
      const moved = await tx.automationJob.updateMany({
        where: { id: job.id, status: "AWAITING_PAYMENT" },
        data: to === "QUEUED" ? { status: to, runAfter: now, queuedAt: now } : { status: to, lastError: "payment_failed", finishedAt: now },
      });
      if (moved.count === 1) await writeJobEvent(tx, job, "AWAITING_PAYMENT", to, job.fencingToken, { paymentStatus: status });
      // 결제 확정 전에 취소됐거나 미확정 마감으로 닫힌(연결을 시작하지 않은) 작업에 결제가 들어왔다: 환불 처리 대기로 둔다(실제 환불은 승인 뒤)
      else if (status === "PAID") {
        const canceled = job.status === "CANCELED";
        await tx.automationPayment.update({ where: { id: paymentId }, data: { status: "REFUND_PENDING", refundReason: canceled ? "canceled_before_start" : "payment_unresolved", refundRequestedAt: now } });
        await writeAudit(tx, {
          actorType: "SYSTEM",
          sellerId: payment.sellerId,
          action: canceled ? "automation.paid_after_cancel" : "automation.paid_after_close",
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
    const now = await dbNow(tx);
    const r = await tx.automationPayment.updateMany({
      where: {
        id: paymentId,
        status: "PENDING",
        job: { is: { status: "AWAITING_PAYMENT" } },
        AND: [
          { OR: resendBefore ? [{ chargeSubmittedAt: null }, { chargeSubmittedAt: { lte: resendBefore } }] : [{ chargeSubmittedAt: null }] },
          // 다시 보내기는 고정 마감(첫 제출 + 30분) 전까지만
          { OR: [{ chargeFirstSubmittedAt: null }, { chargeFirstSubmittedAt: { gt: new Date(now.getTime() - AUTOMATION_LIMITS.notChargedAfterMs) } }] },
        ],
      },
      data: { chargeSubmittedAt: now, chargeFirstSubmittedAt: p.chargeFirstSubmittedAt ?? now },
    });
    return r.count === 1 ? { sellerId: p.sellerId, amount: p.amount, kind: p.job.kind } : null;
  });
  if (!claimed) return false;
  // 결과를 못 받으면(상한 초과·오류) PENDING으로 두고 대사(reconcile)가 같은 청구 id로 PG에 확인한다(같은 청구 id는 한 번만 결제됨)
  await callPort(() =>
    provider.charge({
      billingKey,
      customerKey: claimed.sellerId,
      amount: claimed.amount,
      orderId: paymentId,
      orderName: claimed.kind === "INITIAL" ? AUTOMATION_ORDER_NAME : REINSTALL_ORDER_NAME,
    }),
  );
  return true;
}

// 결과를 못 받은(PENDING) 청구를 PG에 다시 묻는다. 작업자 반복에서 부른다. 확정한 건수를 돌려준다.
// PG에 기록이 없으면(결제 요청 전에 멈췄거나 요청이 PG에 닿지 않음) 결제 대기 작업에 한해 같은 청구 id로 다시 보낸다.
export async function reconcileAutomationPayments(db: PrismaClient, provider: BillingProvider, opts: { olderThanMs?: number } = {}): Promise<number> {
  const cutoff = new Date((await dbNow(db)).getTime() - (opts.olderThanMs ?? AUTOMATION_LIMITS.reconcileAfterMs));
  // 고르기와 점유를 한 문장으로: 확인 간격이 지난 PENDING 청구를 확인한 지 오래된 순(처음이면 먼저)·id 순으로 50건 골라
  // 확인 시각을 남기고 그 행만 돌려준다(다른 작업자가 잠근 행은 건너뜀). 여러 작업자가 동시에 돌아도 같은 청구는 한 작업자만 PG에 묻고,
  // 오류가 난 건도 다음 회차에는 뒤로 간다.
  // 고르는 질의는 MATERIALIZED로 한 번만 돈다. 「WHERE id IN (… LIMIT … FOR UPDATE SKIP LOCKED)」는 실행 계획에 따라 하위 질의가 다시 돌며
  // 이미 바꾼 행을 건너뛰고 다음 행을 집어 50건을 넘길 수 있다.
  const stale = await db.$queryRaw<{ id: string; sellerId: string }[]>`
    WITH picked AS MATERIALIZED (
      SELECT id FROM "AutomationPayment"
      WHERE status = 'PENDING' AND method = 'BILLING_KEY' AND "createdAt" <= ${cutoff} AND ("lastCheckedAt" IS NULL OR "lastCheckedAt" <= ${cutoff})
      ORDER BY "lastCheckedAt" ASC NULLS FIRST, id ASC
      LIMIT 50
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "AutomationPayment" p SET "lastCheckedAt" = clock_timestamp()
    FROM picked WHERE p.id = picked.id
    RETURNING p.id, p."sellerId"`;
  let settled = 0;
  for (const p of stale) {
    // 한 건 조회가 실패해도 나머지는 계속 확인한다
    try {
      // 조회가 상한을 넘기면 던져 이 건은 PENDING으로 두고 다음 건으로 넘어간다
      if (valueOrThrow(await callPort(() => provider.getPayment(p.id))).status === "NOT_FOUND") {
        const sub = await db.sellerSubscription.findUnique({ where: { sellerId: p.sellerId }, select: { billingKeyCipher: true } });
        if (sub?.billingKeyCipher) await submitCharge(db, provider, p.id, openBillingKey(sub.billingKeyCipher, p.sellerId), cutoff);
      }
    } catch {
      // 조회·다시 보내기가 실패해도 아래 확인(마감 처리 포함)은 한다
    }
    const status = await verifyAndSettle(db, provider, p.id).catch(() => "PENDING" as const);
    if (status !== "PENDING") settled++;
  }
  return settled;
}

// ───── 다른 카드로 결제 (SA-151, 나이스페이 일반 결제창) ─────
// 저장한 구독 카드(빌링키)를 바꾸지 않고 이번 한 번만 다른 카드로 결제한다. 카드 정보는 PG 결제창에서만 입력되고 우리는 카드사·끝 4자리만 기록한다.
// 흐름: 시작(결제·작업 행 생성, 결제창 값 반환) → PG 인증 결과(returnUrl) → 서버 승인 → 서버가 결과를 확인한 트랜잭션에서만 작업 QUEUED(구독 카드 경로와 같은 settleFound).
// 승인 응답을 못 받으면 PENDING으로 두고 대사(reconcileOneTimeAutomationPayments)가 거래 id로 PG에 묻는다.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYSTEM = { actorType: "SYSTEM" as const };

export type OneTimeStartResult =
  | { ok: true; jobId: string; paymentId: string; replayed: boolean; paymentStatus: AutomationPayment["status"]; window: { clientId: string; method: "card"; orderId: string; amount: number; goodsName: string } | null }
  | { ok: false; reason: Failure; jobId?: string };

export async function startOneTimeCardPurchase(
  db: PrismaClient,
  gw: PaymentGateway,
  ctx: TenantContext,
  input: { idempotencyKey: unknown; consent: unknown; shopUrl?: unknown },
): Promise<OneTimeStartResult> {
  const r = await buyPaidJob(db, null, ctx, {
    ...input,
    kind: "INITIAL",
    oneTime: true,
    shopHost: shopHostOf(input.shopUrl),
    fingerprint: requestFingerprint("INITIAL_ONE_TIME", input.shopUrl),
    resolvePlaybook: () => supportedPlaybookFor(db, input.shopUrl),
  });
  if (!r.ok) return r;
  const p = await db.automationPayment.findFirstOrThrow({ where: { sellerId: ctx.sellerId, job: { is: { id: r.jobId } } } });
  // 승인 요청이 이미 나간 결제(pgTid)·이미 확정된 결제에는 결제창을 다시 열어 주지 않는다
  const open = p.status === "PENDING" && !p.pgTid;
  return {
    ok: true,
    jobId: r.jobId,
    paymentId: p.id,
    replayed: r.replayed,
    paymentStatus: p.status,
    window: open ? { clientId: gw.clientId, method: "card", orderId: p.id, amount: p.amount, goodsName: AUTOMATION_ORDER_NAME } : null,
  };
}

// 결제창을 열고 끝내지 않은 시도(승인 요청 전, pgTid 없음)를 실패로 닫고 작업도 닫는다. 승인 요청이 나간 결제는 건드리지 않는다.
async function abandonOneTimeAttempts(db: PrismaClient, sellerId: string): Promise<void> {
  const stale = await db.automationPayment.findMany({ where: { sellerId, method: "ONE_TIME_CARD", status: "PENDING", pgTid: null }, select: { id: true } });
  for (const { id } of stale) await closeUnapproved(db, id, "window_abandoned");
}

// 승인 요청 전(pgTid 없음)인 결제를 실패로 닫는다. 이미 승인 요청이 나갔거나 확정된 결제는 바꾸지 않는다.
async function closeUnapproved(db: PrismaClient, paymentId: string, reason: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const head = await tx.automationPayment.findUnique({ where: { id: paymentId }, select: { job: { select: { id: true } } } });
    if (head?.job) await lockJob(tx, head.job.id);
    const now = await dbNow(tx);
    const moved = await tx.automationPayment.updateMany({ where: { id: paymentId, method: "ONE_TIME_CARD", status: "PENDING", pgTid: null }, data: { status: "FAILED", failureReason: reason.slice(0, 200) } });
    if (moved.count !== 1) return;
    const job = await tx.automationJob.findFirst({ where: { paymentId, status: "AWAITING_PAYMENT" } });
    if (job) {
      await tx.automationJob.update({ where: { id: job.id }, data: { status: "FAILED", lastError: "payment_failed", finishedAt: now } });
      await writeJobEvent(tx, job, "AWAITING_PAYMENT", "FAILED", job.fencingToken, { paymentStatus: "FAILED" });
    }
    const p = await tx.automationPayment.findUniqueOrThrow({ where: { id: paymentId }, select: { sellerId: true, amount: true } });
    await writeAudit(tx, { ...SYSTEM, sellerId: p.sellerId, action: "automation.one_time_payment_failed", targetType: "AutomationPayment", targetId: paymentId, after: { reason, amount: p.amount } });
  });
}

export type OneTimeOutcome = "paid" | "failed" | "pending";
export type OneTimeConfirmResult = { ok: true; outcome: OneTimeOutcome; jobId: string | null; shopHost: string | null } | { ok: false; reason: "not_found" | "invalid_signature" };

const outcomeOfStatus = (s: AutomationPayment["status"]): OneTimeOutcome => (s === "FAILED" ? "failed" : s === "PENDING" ? "pending" : "paid");

// returnUrl로 받은 결제창 인증 결과. 세션 쿠키 없이 PG에서 넘어오므로 서명과 결제 행으로만 판단한다.
export async function confirmOneTimeAuthResult(db: PrismaClient, gw: PaymentGateway, r: AuthResult): Promise<OneTimeConfirmResult> {
  if (!UUID.test(r.orderId)) return { ok: false, reason: "not_found" };
  const p = await db.automationPayment.findFirst({ where: { id: r.orderId, method: "ONE_TIME_CARD" }, include: { job: { select: { id: true, shopHost: true } } } });
  if (!p) return { ok: false, reason: "not_found" };
  const done = (outcome: OneTimeOutcome): OneTimeConfirmResult => ({ ok: true, outcome, jobId: p.job?.id ?? null, shopHost: p.job?.shopHost ?? null });
  // 인증 실패 결과에는 서명이 없다. 서명 없는 값으로 상태를 바꾸지 않는다(결제는 PENDING 그대로, 다음 시도 때 닫힌다). 사유만 로그 추적에 남긴다.
  if (r.authResultCode !== "0000") {
    if (p.status === "PENDING" && !p.pgTid) {
      console.warn("[automation-pay] auth failed", JSON.stringify({ paymentId: p.id, code: r.authResultCode.slice(0, 20), message: (r.authResultMsg ?? "").slice(0, 100) }));
      await writeAudit(db, { ...SYSTEM, sellerId: p.sellerId, action: "automation.one_time_auth_failed", targetType: "AutomationPayment", targetId: p.id, after: { code: r.authResultCode.slice(0, 20), message: (r.authResultMsg ?? "").slice(0, 100) } }).catch(() => null);
      return done("failed");
    }
    return done(outcomeOfStatus(p.status));
  }
  if (!gw.verifyAuthResult(r)) return { ok: false, reason: "invalid_signature" };
  if (p.status !== "PENDING") return done(outcomeOfStatus(p.status));
  if (!/^\d+$/.test(r.amount) || Number(r.amount) !== p.amount || !r.tid) {
    await closeUnapproved(db, p.id, "amount_mismatch");
    return done("failed");
  }
  return done(await approveOneTime(db, gw, p.id, r.tid));
}

// 승인을 잡고(pgTid 기록) PG에 승인을 요청한다. 같은 인증 결과가 다시 와도 승인은 한 번만 나간다.
async function approveOneTime(db: PrismaClient, gw: PaymentGateway, paymentId: string, tid: string): Promise<OneTimeOutcome> {
  const claimed = await db
    .$transaction(async (tx) => {
      const head = await tx.automationPayment.findUniqueOrThrow({ where: { id: paymentId }, select: { job: { select: { id: true } } } });
      if (head.job) await lockJob(tx, head.job.id);
      const now = await dbNow(tx);
      const moved = await tx.automationPayment.updateMany({
        where: { id: paymentId, method: "ONE_TIME_CARD", status: "PENDING", pgTid: null, job: { is: { status: "AWAITING_PAYMENT" } } },
        data: { pgTid: tid, chargeSubmittedAt: now, chargeFirstSubmittedAt: now },
      });
      return moved.count === 1;
    })
    .catch((e) => {
      // 같은 거래 id가 다른 결제에 이미 있다: 이 결제는 승인하지 않는다(인증만 된 거래는 돈이 움직이지 않는다)
      if (isUniqueViolation(e)) return "duplicate" as const;
      throw e;
    });
  if (claimed === "duplicate") {
    await closeUnapproved(db, paymentId, "duplicate_payment");
    return "failed";
  }
  const current = await db.automationPayment.findUniqueOrThrow({ where: { id: paymentId } });
  if (!claimed) return outcomeOfStatus(current.status);

  const res = await gw.approve({ tid, amount: current.amount });
  if (res.kind === "ok") return applyApproved(db, gw, current, res.value);
  if (res.kind === "rejected") return outcomeOfStatus(await settleFound(db, paymentId, { status: "FAILED", reason: res.code }));
  // 승인 응답을 모름: 망 취소로 거둔다. 망 취소 결과도 모르면 PENDING으로 두고 대사가 거래 id로 확정한다.
  const net = await gw.netCancel(paymentId);
  if (net.kind === "ok") return outcomeOfStatus(await settleFound(db, paymentId, { status: "FAILED", reason: "approve_timeout" }));
  return "pending";
}

// PG가 알려 준 거래를 결제에 반영한다(승인 응답·대사 조회 공통). 확인된 PAID만 작업을 대기열에 넣는다.
async function applyApproved(db: PrismaClient, gw: PaymentGateway, p: AutomationPayment, pg: PgPayment): Promise<OneTimeOutcome> {
  if (pg.tid !== p.pgTid || pg.orderId !== p.id) return outcomeOfStatus(await settleFound(db, p.id, { status: "FAILED", reason: "pg_mismatch" }));
  if (pg.status === "ready") return "pending";
  if (pg.status !== "paid") return outcomeOfStatus(await settleFound(db, p.id, { status: "FAILED", reason: `pg_${pg.status}` }));
  if (pg.amount !== p.amount) {
    // 서명은 맞는데 금액이 다르다: 결제를 인정하지 않고 PG 쪽 결제를 전액 취소한다
    const c = await gw.cancel({ tid: pg.tid, cancelOrderId: `${p.id}-mismatch`, amount: pg.amount, partial: false, reason: "amount_mismatch" });
    return outcomeOfStatus(await settleFound(db, p.id, { status: "FAILED", reason: c.kind === "ok" ? "amount_mismatch" : "amount_mismatch_cancel_unconfirmed" }));
  }
  const status = await settleFound(db, p.id, { status: "PAID", paymentId: pg.tid, receiptUrl: null }, { card: pg.card });
  return outcomeOfStatus(status);
}

// 결과를 못 받은 일반 결제창 결제를 정리한다(작업자 반복에서 부른다). 확정한 건수를 돌려준다.
// - 승인 요청이 나간 건(pgTid): PG에 거래 id로 묻는다. 결제됨 → 확정, 실패·취소 → 실패, 승인 대기(ready)가 30분 넘으면 망 취소 뒤 실패.
// - 승인 요청 전(pgTid 없음)인 건: 결제창을 열고 끝내지 않은 것이라 30분이 지나면 실패로 닫는다.
export async function reconcileOneTimeAutomationPayments(db: PrismaClient, gw: PaymentGateway, opts: { olderThanMs?: number; notChargedAfterMs?: number } = {}): Promise<number> {
  const now = await dbNow(db);
  const cutoff = new Date(now.getTime() - (opts.olderThanMs ?? AUTOMATION_LIMITS.reconcileAfterMs));
  const stale = await db.$queryRaw<{ id: string }[]>`
    WITH picked AS MATERIALIZED (
      SELECT id FROM "AutomationPayment"
      WHERE status = 'PENDING' AND method = 'ONE_TIME_CARD' AND "createdAt" <= ${cutoff} AND ("lastCheckedAt" IS NULL OR "lastCheckedAt" <= ${cutoff})
      ORDER BY "lastCheckedAt" ASC NULLS FIRST, id ASC
      LIMIT 50
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "AutomationPayment" p SET "lastCheckedAt" = clock_timestamp()
    FROM picked WHERE p.id = picked.id
    RETURNING p.id`;
  const limit = opts.notChargedAfterMs ?? AUTOMATION_LIMITS.notChargedAfterMs;
  let settled = 0;
  for (const { id } of stale) {
    try {
      const p = await db.automationPayment.findUniqueOrThrow({ where: { id } });
      if (p.status !== "PENDING") continue;
      const age = now.getTime() - (p.chargeFirstSubmittedAt ?? p.createdAt).getTime();
      let status: AutomationPayment["status"] = "PENDING";
      if (!p.pgTid) {
        if (age >= limit) {
          await closeUnapproved(db, id, "window_abandoned");
          status = (await db.automationPayment.findUniqueOrThrow({ where: { id } })).status;
        }
      } else {
        const r = await gw.getPayment(p.pgTid);
        if (r.kind === "ok") {
          const o = await applyApproved(db, gw, p, r.value);
          // 승인 대기(ready)로 30분이 지났다: 망 취소로 거두고 실패로 닫는다(늦게 결제되지 않게). 망 취소 결과를 모르면 다음 회차에 다시 한다.
          if (o === "pending" && r.value.status === "ready" && age >= limit && (await gw.netCancel(id)).kind === "ok") await settleFound(db, id, { status: "FAILED", reason: "approve_timeout" });
        } else if (r.kind === "rejected" && age >= limit) await settleFound(db, id, { status: "FAILED", reason: r.code });
        status = (await db.automationPayment.findUniqueOrThrow({ where: { id } })).status;
      }
      if (status !== "PENDING") settled++;
    } catch {
      // 한 건이 실패해도 나머지는 계속 확인한다(이 건은 다음 회차)
    }
  }
  return settled;
}

// 웹훅(거래 id)이 일반 결제창 결제에 해당하면 PG에 다시 확인해 반영한다. 해당하지 않으면 false.
export async function reconcileOneTimeByTid(db: PrismaClient, gw: PaymentGateway, tid: string): Promise<boolean> {
  const p = await db.automationPayment.findUnique({ where: { pgTid: tid } });
  if (!p || p.method !== "ONE_TIME_CARD") return false;
  if (p.status === "PENDING") {
    const r = await gw.getPayment(tid);
    if (r.kind === "ok") await applyApproved(db, gw, p, r.value);
  }
  return true;
}
