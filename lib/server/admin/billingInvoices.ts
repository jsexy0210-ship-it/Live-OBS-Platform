import { Prisma, type PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { writeAudit } from "../audit/log";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import type { BillingProvider } from "../billing/provider";
import { dbNow, lockSeller, renewDueSubscriptions } from "../billing/subscription";
import { kstDayStart } from "../orders/read";
import { formatCsv, guardText } from "../shop-bulk-io/csv";

// 마스터 관리자 청구·결제 내역(MA-024, 구독료). 월(또는 기간) 요약·표시 상태 필터·검색·매출전표·내보내기·실패 건 재시도.
// - 조회·내보내기는 platform.read(모든 마스터 역할), 재시도는 billing.manage(최고관리자·운영). 키·카드번호 원문은 어디에도 없다(카드 표시 이름 cardLabel만).
// - 목록은 기간(KST 날짜, 청구 시각 기준)으로 항상 제한하고 새 표 없이 SubscriptionPayment·SellerSubscription에서 계산한다(기간 인덱스 SubscriptionPayment_createdAt_idx).
// - 「예정」은 아직 청구가 생기지 않은 다음 자동결제(구독의 nextChargeAt이 기간 안이고 아직 안 지남)를 같은 표에 한 줄로 보여 준다(paymentId null, 금액은 예상).
export const BILLING_INVOICE_PAGE_DEFAULT = 20;
export const BILLING_INVOICE_PAGE_MAX = 100;
export const BILLING_INVOICE_RANGE_MAX_DAYS = 366;
export const BILLING_INVOICE_EXPORT_MAX = 5000;
export const RETRY_BULK_MAX = 50;
export const RETRY_MIN_GAP_MS = 5 * 60_000;
// 표시 상태: PAID 결제 완료 · PENDING 결제 진행 중 · RETRYING 실패(자동 재시도 남음) · OVERDUE 연체(재시도 끝났거나 유예 지남) · FAILED 실패(이후 결제됐거나 해지 등으로 더 시도하지 않음) · REFUNDED 환불 완료 · SCHEDULED 예정
export const INVOICE_STATES = ["PAID", "PENDING", "RETRYING", "OVERDUE", "FAILED", "REFUNDED", "SCHEDULED"] as const;
export type InvoiceState = (typeof INVOICE_STATES)[number];
const PLAN_CODES = ["OVERLAY_ONLY", "INTEGRATED", "STANDARD"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;
type Meta = { ip?: string | null; userAgent?: string | null };

export type InvoiceQuery = { month?: string | null; from?: string | null; to?: string | null; state?: string | null; plan?: string | null; q?: string | null; failedOnly?: string | null; sellerId?: string | null; cursor?: string | null; limit?: string | null };

function requireRead(admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
}
const esc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const kstDate = (d: Date) => new Date(d.getTime() + KST_MS).toISOString().slice(0, 10);

type Parsed = { from: Date; end: Date; state: InvoiceState | null; plan: string | null; q: string; failedOnly: boolean; sellerId: string | null; label: { from: string; to: string } };

function parse(query: InvoiceQuery, now: Date): Parsed | null {
  const state = query.state == null || query.state === "" ? null : (INVOICE_STATES as readonly string[]).includes(query.state) ? (query.state as InvoiceState) : undefined;
  const plan = query.plan == null || query.plan === "" ? null : (PLAN_CODES as readonly string[]).includes(query.plan) ? query.plan : undefined;
  const failedOnly = query.failedOnly == null || query.failedOnly === "" || query.failedOnly === "0" ? false : query.failedOnly === "1" ? true : undefined;
  const q = query.q?.trim() ?? "";
  if (state === undefined || plan === undefined || failedOnly === undefined || q.length > 50) return null;
  if (query.sellerId && !UUID.test(query.sellerId)) return null;
  let from: Date | null;
  let toStart: Date | null;
  if (query.from || query.to) {
    if (query.month) return null;
    from = query.from ? kstDayStart(query.from) : null;
    toStart = query.to ? kstDayStart(query.to) : from;
    if (!from || !toStart || toStart < from || (toStart.getTime() - from.getTime()) / DAY_MS >= BILLING_INVOICE_RANGE_MAX_DAYS) return null;
  } else {
    // 월 지정이 없으면 이번 달(KST)
    const m = query.month ? MONTH.exec(query.month) : null;
    if (query.month && !m) return null;
    const k = new Date(now.getTime() + KST_MS);
    const y = m ? Number(m[1]) : k.getUTCFullYear();
    const mo = m ? Number(m[2]) - 1 : k.getUTCMonth();
    from = new Date(Date.UTC(y, mo, 1) - KST_MS);
    toStart = new Date(Date.UTC(y, mo + 1, 0) - KST_MS);
  }
  return { from, end: new Date(toStart.getTime() + DAY_MS), state, plan, q, failedOnly, sellerId: query.sellerId || null, label: { from: kstDate(from), to: kstDate(toStart) } };
}

// 표시 행 원천: 기간 안 청구(PAYMENT)와 기간 안 예정 자동결제(SCHEDULED)를 같은 열로 합친다.
const source = (p: Parsed, now: Date) => Prisma.sql`
  inv AS (
    SELECT pay."id" AS id, pay."id" AS "paymentId", pay."createdAt" AS at, pay."amount" AS amount, pay."kind"::text AS kind, pay."scheduled" AS auto,
           pay."periodStart" AS "periodStart", pay."periodEnd" AS "periodEnd", pay."paidAt" AS "paidAt", pay."failureReason" AS "failureReason",
           pay."launchDiscount" AS "launchDiscount", pay."receiptUrl" AS "receiptUrl", pay."subscriptionId" AS "subscriptionId",
           se."id" AS "sellerId", se."slug" AS slug, se."shopName" AS "shopName",
           COALESCE(tp."code", pl."code") AS "planCode", COALESCE(tp."name", pl."name") AS "planName", sub."cardLabel" AS "cardLabel",
           rf."amount" AS "refundedAmount", rf."refundedAt" AS "refundedAt",
           CASE
             WHEN rf."id" IS NOT NULL THEN 'REFUNDED'
             WHEN pay."status" = 'PAID' THEN 'PAID'
             WHEN pay."status" = 'PENDING' THEN 'PENDING'
             WHEN pay."scheduled" AND pay."kind" = 'PERIOD' AND pay."id" = lastp."id" AND sub."status" = 'PAST_DUE' AND NOT sub."cancelAtPeriodEnd"
                  AND (sub."nextChargeAt" IS NULL OR sub."graceUntil" <= ${now}) THEN 'OVERDUE'
             WHEN pay."scheduled" AND pay."kind" = 'PERIOD' AND pay."id" = lastp."id" AND sub."status" IN ('ACTIVE', 'PAST_DUE') AND NOT sub."cancelAtPeriodEnd"
                  AND sub."nextChargeAt" IS NOT NULL THEN 'RETRYING'
             ELSE 'FAILED'
           END AS state,
           (pay."status" = 'FAILED' AND pay."id" = lastp."id" AND sub."status" IN ('ACTIVE', 'PAST_DUE') AND NOT sub."cancelAtPeriodEnd" AND sub."billingKeyCipher" IS NOT NULL
             AND se."status" <> 'SUSPENDED' AND pay."scheduled" AND pay."kind" = 'PERIOD') AS "canRetry"
      FROM "SubscriptionPayment" pay
      JOIN "Seller" se ON se."id" = pay."sellerId"
      JOIN "SellerSubscription" sub ON sub."id" = pay."subscriptionId"
      LEFT JOIN "SubscriptionPlan" pl ON pl."id" = sub."planId"
      LEFT JOIN "SubscriptionPlan" tp ON tp."id" = pay."targetPlanId"
      LEFT JOIN LATERAL (SELECT lp."id" FROM "SubscriptionPayment" lp WHERE lp."subscriptionId" = pay."subscriptionId" ORDER BY lp."createdAt" DESC, lp."id" DESC LIMIT 1) lastp ON TRUE
      LEFT JOIN LATERAL (SELECT r."id", r."amount", r."refundedAt" FROM "SubscriptionRefund" r WHERE r."paymentId" = pay."id" AND r."status" = 'REFUNDED' LIMIT 1) rf ON TRUE
     WHERE pay."createdAt" >= ${p.from} AND pay."createdAt" < ${p.end}
    UNION ALL
    SELECT sub."id", NULL::uuid, sub."nextChargeAt", CASE WHEN sub."regularPrice" THEN pl."listPrice" WHEN sub."legacyPrice" IS NOT NULL THEN sub."legacyPrice" ELSE pl."salePrice" END,
           'PERIOD', TRUE, NULL::timestamptz, NULL::timestamptz, NULL::timestamptz, NULL::text, FALSE, NULL::text, sub."id",
           se."id", se."slug", se."shopName", pl."code", pl."name", sub."cardLabel", NULL::int, NULL::timestamptz, 'SCHEDULED', FALSE
      FROM "SellerSubscription" sub
      JOIN "Seller" se ON se."id" = sub."sellerId"
      JOIN "SubscriptionPlan" pl ON pl."id" = sub."planId"
     WHERE sub."status" = 'ACTIVE' AND NOT sub."cancelAtPeriodEnd" AND sub."billingKeyCipher" IS NOT NULL AND se."status" = 'ACTIVE'
       AND sub."nextChargeAt" > ${now} AND sub."nextChargeAt" >= ${p.from} AND sub."nextChargeAt" < ${p.end}
       AND NOT EXISTS (SELECT 1 FROM "SubscriptionPayment" x WHERE x."subscriptionId" = sub."id" AND x."status" = 'PENDING')
  )`;

function filters(p: Parsed): Prisma.Sql {
  const w: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (p.state) w.push(Prisma.sql`state = ${p.state}`);
  if (p.failedOnly) w.push(Prisma.sql`state IN ('RETRYING', 'OVERDUE', 'FAILED')`);
  if (p.plan) w.push(Prisma.sql`"planCode" = ${p.plan}`);
  if (p.sellerId) w.push(Prisma.sql`"sellerId" = ${p.sellerId}::uuid`);
  if (p.q) {
    const like = `%${esc(p.q)}%`;
    w.push(Prisma.sql`("shopName" ILIKE ${like} OR slug ILIKE ${like})`);
  }
  return Prisma.join(w, " AND ");
}

type Row = {
  id: string;
  paymentId: string | null;
  at: Date;
  amount: number;
  kind: string;
  auto: boolean;
  periodStart: Date | null;
  periodEnd: Date | null;
  paidAt: Date | null;
  failureReason: string | null;
  launchDiscount: boolean;
  receiptUrl: string | null;
  sellerId: string;
  slug: string;
  shopName: string;
  planCode: string | null;
  planName: string | null;
  cardLabel: string | null;
  refundedAmount: number | null;
  refundedAt: Date | null;
  state: InvoiceState;
  canRetry: boolean;
};

// 매출전표 열: ISSUED 발행(결제 완료 + 전표 주소) · CANCELED 취소(환불 완료) · SCHEDULED 예정 · NOT_ISSUED 미발행
const receiptOf = (r: Row) => (r.state === "REFUNDED" ? "CANCELED" : r.state === "SCHEDULED" ? "SCHEDULED" : r.state === "PAID" && r.receiptUrl ? "ISSUED" : "NOT_ISSUED");
const view = (r: Row) => ({
  id: r.id,
  paymentId: r.paymentId,
  state: r.state,
  at: r.at,
  amount: r.amount,
  amountEstimated: r.state === "SCHEDULED",
  kind: r.kind,
  seller: { id: r.sellerId, slug: r.slug, shopName: r.shopName },
  planCode: r.planCode,
  planName: r.planName,
  periodStart: r.periodStart,
  periodEnd: r.periodEnd,
  paymentMethod: r.cardLabel,
  receipt: receiptOf(r),
  receiptUrl: receiptOf(r) === "ISSUED" ? r.receiptUrl : null,
  paidAt: r.paidAt,
  failureReason: r.failureReason,
  launchDiscount: r.launchDiscount,
  refund: r.refundedAmount === null ? null : { amount: r.refundedAmount, refundedAt: r.refundedAt },
  canRetry: r.canRetry,
});

// 월(기간) 요약: 총 청구(기간 안 청구 건수·금액)·결제 완료·실패(재시도 중·연체 따로)·진행 중·환불·예정(예상 금액). 검색·필터와 관계없이 기간 전체 기준.
async function summary(db: PrismaClient, p: Parsed, now: Date) {
  const all = wholeRange(p);
  const [s] = await db.$queryRaw<Record<string, bigint | number>[]>`
    WITH ${source(all, now)}
    SELECT count(*) FILTER (WHERE state <> 'SCHEDULED') AS "totalCount", coalesce(sum(amount::bigint) FILTER (WHERE state <> 'SCHEDULED'), 0) AS "totalAmount",
           count(*) FILTER (WHERE state IN ('PAID', 'REFUNDED')) AS "paidCount", coalesce(sum(amount::bigint) FILTER (WHERE state IN ('PAID', 'REFUNDED')), 0) AS "paidAmount",
           count(*) FILTER (WHERE state IN ('RETRYING', 'OVERDUE', 'FAILED')) AS "failedCount", coalesce(sum(amount::bigint) FILTER (WHERE state IN ('RETRYING', 'OVERDUE', 'FAILED')), 0) AS "failedAmount",
           count(*) FILTER (WHERE state = 'RETRYING') AS "retryingCount", count(*) FILTER (WHERE state = 'OVERDUE') AS "overdueCount",
           count(*) FILTER (WHERE state = 'PENDING') AS "pendingCount",
           count(*) FILTER (WHERE state = 'REFUNDED') AS "refundedCount", coalesce(sum("refundedAmount"::bigint) FILTER (WHERE state = 'REFUNDED'), 0) AS "refundedAmount",
           count(*) FILTER (WHERE state = 'SCHEDULED') AS "scheduledCount", coalesce(sum(amount::bigint) FILTER (WHERE state = 'SCHEDULED'), 0) AS "scheduledAmount"
      FROM inv`;
  const n = (k: string) => Number(s[k] ?? 0);
  return {
    total: { count: n("totalCount"), amount: n("totalAmount") },
    paid: { count: n("paidCount"), amount: n("paidAmount") },
    failed: { count: n("failedCount"), amount: n("failedAmount"), retrying: n("retryingCount"), overdue: n("overdueCount") },
    pending: { count: n("pendingCount") },
    refunded: { count: n("refundedCount"), amount: n("refundedAmount") },
    scheduled: { count: n("scheduledCount"), estimatedAmount: n("scheduledAmount") },
  };
}
const wholeRange = (p: Parsed): Parsed => ({ ...p, state: null, plan: null, q: "", failedOnly: false, sellerId: null });

// 청구 목록(오프셋 쪽 이동). at(청구 시각, 예정은 다음 결제 시각) 내림차순. 응답: { range, summary, items, total, nextCursor }. 환불 완료는 결제 완료 건수·금액에도 들어간다(환불액은 따로).
export async function listBillingInvoices(db: PrismaClient, admin: AdminSessionContext, query: InvoiceQuery) {
  requireRead(admin);
  const now = await dbNow(db);
  const p = parse(query, now);
  const limit = query.limit == null || query.limit === "" ? BILLING_INVOICE_PAGE_DEFAULT : Number(query.limit);
  const offset = query.cursor == null || query.cursor === "" ? 0 : Number(query.cursor);
  if (!p || !Number.isInteger(limit) || limit < 1 || limit > BILLING_INVOICE_PAGE_MAX || !Number.isInteger(offset) || offset < 0 || offset > 100_000) return { ok: false as const };
  const where = filters(p);
  const [rows, [{ total }], sum] = await Promise.all([
    db.$queryRaw<Row[]>`WITH ${source(p, now)} SELECT * FROM inv WHERE ${where} ORDER BY at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
    db.$queryRaw<{ total: bigint }[]>`WITH ${source(p, now)} SELECT count(*) AS total FROM inv WHERE ${where}`,
    summary(db, p, now),
  ]);
  return {
    ok: true as const,
    range: p.label,
    summary: sum,
    items: rows.map(view),
    total: Number(total),
    nextCursor: offset + rows.length < Number(total) ? String(offset + rows.length) : null,
  };
}

// 파트너스 상세 「구독」 탭(MA-012)용: 한 파트너스의 전체 기간 청구(예정 포함). 기간 상한(366일)·월 단위 없이 같은 원천(source)·같은 표시 모양(view)을 쓴다.
// 응답: { items, total, totals: { paidAmount, paidCount, refundedAmount, refundedCount } }. totals는 결제가 이뤄진 건(결제 완료 + 환불 완료) 합계와 환불 합계다.
export async function listSellerInvoices(db: PrismaClient, sellerId: string, opts: { offset: number; limit: number; now: Date }) {
  const p: Parsed = {
    from: new Date(0),
    end: new Date(opts.now.getTime() + 400 * DAY_MS),
    state: null,
    plan: null,
    q: "",
    failedOnly: false,
    sellerId,
    label: { from: "", to: "" },
  };
  const where = filters(p);
  const [rows, [t]] = await Promise.all([
    db.$queryRaw<Row[]>`WITH ${source(p, opts.now)} SELECT * FROM inv WHERE ${where} ORDER BY at DESC, id DESC LIMIT ${opts.limit} OFFSET ${opts.offset}`,
    db.$queryRaw<Record<string, bigint | number>[]>`
      WITH ${source(p, opts.now)}
      SELECT count(*) AS "total",
             count(*) FILTER (WHERE state IN ('PAID', 'REFUNDED')) AS "paidCount", coalesce(sum(amount::bigint) FILTER (WHERE state IN ('PAID', 'REFUNDED')), 0) AS "paidAmount",
             count(*) FILTER (WHERE state = 'REFUNDED') AS "refundedCount", coalesce(sum("refundedAmount"::bigint) FILTER (WHERE state = 'REFUNDED'), 0) AS "refundedAmount"
        FROM inv WHERE ${where}`,
  ]);
  const n = (k: string) => Number(t?.[k] ?? 0);
  return {
    items: rows.map(view),
    total: n("total"),
    totals: { paidAmount: n("paidAmount"), paidCount: n("paidCount"), refundedAmount: n("refundedAmount"), refundedCount: n("refundedCount") },
  };
}

// 내보내기(CSV, UTF-8 BOM, 같은 조건, 최대 5,000건, 수식 문자 방지). 조회 권한자 누구나, 로그 추적 admin.billing.export.
const STATE_LABEL: Record<InvoiceState, string> = { PAID: "결제 완료", PENDING: "결제 진행 중", RETRYING: "실패·재시도", OVERDUE: "연체", FAILED: "실패", REFUNDED: "환불 완료", SCHEDULED: "예정" };
const RECEIPT_LABEL = { ISSUED: "발행", CANCELED: "취소", SCHEDULED: "예정", NOT_ISSUED: "미발행" } as const;
export async function exportBillingInvoices(db: PrismaClient, admin: AdminSessionContext, query: InvoiceQuery, meta: Meta = {}) {
  requireRead(admin);
  const now = await dbNow(db);
  const p = parse(query, now);
  if (!p) return { ok: false as const };
  const rows = await db.$queryRaw<Row[]>`WITH ${source(p, now)} SELECT * FROM inv WHERE ${filters(p)} ORDER BY at DESC, id DESC LIMIT ${BILLING_INVOICE_EXPORT_MAX + 1}`;
  const truncated = rows.length > BILLING_INVOICE_EXPORT_MAX;
  const page = rows.slice(0, BILLING_INVOICE_EXPORT_MAX);
  const day = (d: Date | null) => (d ? kstDate(d) : "");
  const csv = formatCsv([
    ["청구일", "쇼핑몰", "주소", "요금제", "구분", "금액", "상태", "결제 수단", "매출전표", "결제일", "환불액", "실패 사유"],
    ...page.map((r) => [
      day(r.at),
      guardText(r.shopName),
      guardText(r.slug),
      guardText(r.planName ?? ""),
      r.kind === "PRORATION" ? "차액" : "구독료",
      String(r.amount),
      STATE_LABEL[r.state],
      guardText(r.cardLabel ?? ""),
      RECEIPT_LABEL[receiptOf(r)],
      day(r.paidAt),
      r.refundedAmount === null ? "" : String(r.refundedAmount),
      guardText(r.failureReason ?? ""),
    ]),
  ]);
  await writeAudit(db, {
    actorType: "PLATFORM_ADMIN",
    actorId: admin.admin.id,
    action: "admin.billing.export",
    targetType: "SubscriptionPayment",
    after: { range: p.label, count: page.length, truncated },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { ok: true as const, csv, count: page.length, truncated, range: p.label };
}

export type RetryResult = { paymentId: string; ok: boolean; reason?: string; result?: "PAID" | "FAILED" | "PENDING" };

// 실패 건 재시도(billing.manage = 최고관리자·운영). 실패한 자동결제(구독료) 청구 중 그 구독의 최신 청구이고, 구독이 살아 있고(해지 예약·정지 아님) 카드가 있는 것만.
// 자동결제 예약 실행과 같은 경로(renewDueSubscriptions)로 그 구독만 지금 결제한다 → 같은 잠금·중복 방지·결제 결과 반영. 5분 안에 만든 청구가 있으면 too_soon.
// 한 건이 실패해도 나머지는 계속한다(건별 결과, 1~50건). 결제 공급자는 부르는 쪽이 넘긴다(시험 환경은 가짜 공급자).
export async function retryFailedInvoices(db: PrismaClient, provider: BillingProvider, admin: AdminSessionContext, rawIds: unknown, meta: Meta = {}) {
  if (!adminCan(admin.admin.role, "billing.manage")) throw forbidden();
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > RETRY_BULK_MAX) return { ok: false as const, reason: "invalid_ids" as const };
  const ids = [...new Set(rawIds.map((v) => (typeof v === "string" ? v : "")))];
  const results: RetryResult[] = [];
  for (const paymentId of ids) {
    if (!UUID.test(paymentId)) {
      results.push({ paymentId, ok: false, reason: "not_found" });
      continue;
    }
    try {
      results.push(await retryOne(db, provider, admin, paymentId, meta));
    } catch (e) {
      console.error("[billing_invoice.retry]", paymentId, e instanceof Error ? e.message : e);
      results.push({ paymentId, ok: false, reason: "failed" });
    }
  }
  return { ok: true as const, results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

async function retryOne(db: PrismaClient, provider: BillingProvider, admin: AdminSessionContext, paymentId: string, meta: Meta): Promise<RetryResult> {
  // 잠그고 다시 읽은 뒤 구독을 「지금 결제 대상」으로 당긴다(nextChargeAt = 지금). 이후는 예약 실행 경로가 처리한다.
  const prepared = await db.$transaction(async (tx) => {
    const pay = await tx.subscriptionPayment.findUnique({ where: { id: paymentId }, select: { sellerId: true, subscriptionId: true, status: true, scheduled: true, kind: true } });
    if (!pay) return { reason: "not_found" as const };
    await lockSeller(tx, pay.sellerId);
    const now = await dbNow(tx);
    const cur = await tx.subscriptionPayment.findUniqueOrThrow({ where: { id: paymentId }, select: { status: true } });
    const latest = await tx.subscriptionPayment.findFirst({ where: { subscriptionId: pay.subscriptionId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, createdAt: true } });
    const sub = await tx.sellerSubscription.findUniqueOrThrow({ where: { id: pay.subscriptionId }, select: { status: true, cancelAtPeriodEnd: true, billingKeyCipher: true, seller: { select: { status: true } } } });
    if (cur.status !== "FAILED") return { reason: "not_failed" as const };
    if (latest?.id !== paymentId || !pay.scheduled || pay.kind !== "PERIOD") return { reason: "not_latest" as const };
    if (!["ACTIVE", "PAST_DUE"].includes(sub.status) || sub.cancelAtPeriodEnd || !sub.billingKeyCipher || sub.seller.status === "SUSPENDED") return { reason: "not_retryable" as const };
    if (now.getTime() - latest.createdAt.getTime() < RETRY_MIN_GAP_MS) return { reason: "too_soon" as const };
    await tx.sellerSubscription.update({ where: { id: pay.subscriptionId }, data: { nextChargeAt: now } });
    return { subscriptionId: pay.subscriptionId, sellerId: pay.sellerId };
  });
  if ("reason" in prepared) return { paymentId, ok: false, reason: prepared.reason };
  await renewDueSubscriptions(db, provider, { only: [prepared.subscriptionId] });
  const next = await db.subscriptionPayment.findFirst({ where: { subscriptionId: prepared.subscriptionId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, status: true } });
  const result = next && next.id !== paymentId ? next.status : null;
  await writeAudit(db, {
    actorType: "PLATFORM_ADMIN",
    actorId: admin.admin.id,
    sellerId: prepared.sellerId,
    action: "admin.billing.retry",
    targetType: "SubscriptionPayment",
    targetId: paymentId,
    after: { newPaymentId: next && next.id !== paymentId ? next.id : null, result },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  if (!result) return { paymentId, ok: false, reason: "not_charged" };
  return { paymentId, ok: result === "PAID", result, ...(result === "PAID" ? {} : { reason: result === "FAILED" ? "charge_failed" : "charge_pending" }) };
}
