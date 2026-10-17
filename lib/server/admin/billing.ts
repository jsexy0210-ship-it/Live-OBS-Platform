import { Prisma, type PrismaClient, type SubscriptionPaymentKind, type SubscriptionPaymentStatus } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import type { SellerAccess } from "../billing/access";
import { dbNow } from "../billing/subscription";
import { decodeCursor, encodeCursor, kstDayStart } from "../orders/read";
import { effectiveMailQuota } from "../mail/quota";
import { invoiceRetryReason, RETRY_MIN_GAP_MS } from "./billingInvoices";

// 마스터 관리자 구독 현황(MA-023)·청구·결제 내역(MA-024)·청구 상세(MA-025). 조회만 한다(결제 실행·환불 없음). platform.read.
export const ADMIN_BILLING_PAGE_DEFAULT = 50;
export const ADMIN_BILLING_PAGE_MAX = 200;
const ACCESS: readonly SellerAccess[] = ["trial", "paid", "charging", "grace", "expired"];
const PAY_STATUSES: readonly SubscriptionPaymentStatus[] = ["PENDING", "PAID", "FAILED"];
const PAY_KINDS: readonly SubscriptionPaymentKind[] = ["PERIOD", "PRORATION"];
const PLAN_CODES = ["OVERLAY_ONLY", "INTEGRATED", "STANDARD"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

function requireRead(admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
}

function pageSize(limit: string | null | undefined, fallback = ADMIN_BILLING_PAGE_DEFAULT) {
  const n = limit == null || limit === "" ? fallback : Number(limit);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, ADMIN_BILLING_PAGE_MAX) : null;
}

// 이용 상태(sellerAccess와 같은 판정을 SQL로, billing/access.ts). 결제한 기간 > 체험 > 유예(연체) > 결제 처리 대기 > 만료·해지 순.
const accessSql = (now: Date) => Prisma.sql`CASE
  WHEN sub."currentPeriodEnd" > ${now} THEN 'paid'
  WHEN se."trialEndsAt" > ${now} THEN 'trial'
  WHEN sub."status" = 'PAST_DUE' AND NOT sub."cancelAtPeriodEnd" AND sub."graceUntil" > ${now} THEN 'grace'
  WHEN sub."status" = 'ACTIVE' AND NOT sub."cancelAtPeriodEnd" AND sub."nextChargeAt" <= ${now} THEN 'charging'
  ELSE 'expired' END`;

// 잠금: 결제 실패로 연체(PAST_DUE)가 됐고 유예 기간이 끝나 이용이 막힌 구독(해지 예약·체험·결제한 기간이 남은 건 제외). 이용 상태로는 expired다(MA-032 잠금 목록).
export const lockedSql = (now: Date) => Prisma.sql`(sub."status" = 'PAST_DUE' AND NOT sub."cancelAtPeriodEnd" AND sub."graceUntil" <= ${now}
  AND sub."currentPeriodEnd" <= ${now} AND (se."trialEndsAt" IS NULL OR se."trialEndsAt" <= ${now}))`;

// 구독 현황 대상(승인된 파트너스: 운영 중·정지·종료)과 이용 상태별 수. 구독 현황 탭 숫자와 대시보드(MA-001)가 같은 기준을 쓴다.
const subscriptionFrom = Prisma.sql`FROM "Seller" se
    LEFT JOIN "SellerSubscription" sub ON sub."sellerId" = se."id"
    LEFT JOIN "SubscriptionPlan" p ON p."id" = COALESCE(sub."planId", se."planId")`;
const subscriptionWhere = Prisma.sql`WHERE se."approvedAt" IS NOT NULL AND se."status" IN ('ACTIVE', 'SUSPENDED', 'CLOSED')`;
const subscriptionBase = Prisma.sql`${subscriptionFrom}
    ${subscriptionWhere}`;

export async function subscriptionAccessCounts(db: PrismaClient, now: Date): Promise<Record<SellerAccess, number>> {
  const rows = await db.$queryRaw<{ access: SellerAccess; n: number }[]>`SELECT ${accessSql(now)} AS "access", count(*)::int AS "n" ${subscriptionBase} GROUP BY 1`;
  return Object.fromEntries(ACCESS.map((a) => [a, rows.find((r) => r.access === a)?.n ?? 0])) as Record<SellerAccess, number>;
}

// 해지 예정: 기간 끝에 해지하기로 했고 아직 끝나지 않은 구독(isCancelScheduled와 같은 기준: 해지 완료·기간 끝이 지난 건 제외). 이용 상태와 겹칠 수 있어 따로 센다(MA-023 상태 체크 「해지 예정」).
export const cancellingSql = (now: Date) => Prisma.sql`(sub."id" IS NOT NULL AND sub."cancelAtPeriodEnd" AND sub."status" <> 'CANCELED' AND (sub."currentPeriodEnd" IS NULL OR sub."currentPeriodEnd" > ${now}))`;

export type SubscriptionCounts = Record<SellerAccess, number> & { locked: number; cancelling: number };

async function subscriptionExtraCounts(db: PrismaClient, now: Date): Promise<{ locked: number; cancelling: number }> {
  const [r] = await db.$queryRaw<{ locked: number; cancelling: number }[]>`SELECT
    (count(*) FILTER (WHERE ${lockedSql(now)}))::int AS "locked", (count(*) FILTER (WHERE ${cancellingSql(now)}))::int AS "cancelling" ${subscriptionBase}`;
  return { locked: r?.locked ?? 0, cancelling: r?.cancelling ?? 0 };
}

export type AdminSubscriptionQuery = { access?: string | null; plan?: string | null; q?: string | null; nextFrom?: string | null; nextTo?: string | null; cursor?: string | null; limit?: string | null };
const ACCESS_FILTERS = [...ACCESS, "locked", "cancelling"] as const;

type SubscriptionRow = {
  sellerId: string;
  slug: string;
  shopName: string;
  sellerStatus: string;
  createdAt: Date;
  trialEndsAt: Date | null;
  access: SellerAccess;
  planCode: string | null;
  planName: string | null;
  subStatus: string | null;
  cardLabel: string | null;
  currentPeriodEnd: Date | null;
  nextChargeAt: Date | null;
  cancelAtPeriodEnd: boolean | null;
  graceUntil: Date | null;
  retryCount: number | null;
  planListPrice: number | null;
  planSalePrice: number | null;
  payAmount: number | null;
  payStatus: string | null;
  payPaidAt: Date | null;
  payCreatedAt: Date | null;
};

// 구독 현황: 승인된 파트너스(승인 대기·반려 제외)마다 이용 상태와 구독. 가입 시각 내림차순 커서. counts는 필터 전 상태별 수.
export async function listAdminSubscriptions(db: PrismaClient, admin: AdminSessionContext, query: AdminSubscriptionQuery, opts: { now?: Date } = {}) {
  requireRead(admin);
  const take = pageSize(query.limit, 10);
  if (!take) return { ok: false as const };
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cursor) return { ok: false as const };
  // access는 쉼표로 여러 개(체험,연체 유예 …)를 고를 수 있다: 하나라도 맞으면 나온다. locked(잠금)·cancelling(해지 예정)은 이용 상태와 겹칠 수 있다.
  const accessList = query.access ? [...new Set(query.access.split(",").map((a) => a.trim()))] : [];
  if (accessList.some((a) => !(ACCESS_FILTERS as readonly string[]).includes(a))) return { ok: false as const };
  const nextFrom = query.nextFrom ? kstDayStart(query.nextFrom) : null;
  const nextTo = query.nextTo ? kstDayStart(query.nextTo) : null;
  if ((query.nextFrom && !nextFrom) || (query.nextTo && !nextTo)) return { ok: false as const };
  if (nextFrom && nextTo && nextTo < nextFrom) return { ok: false as const };
  if (query.plan && !PLAN_CODES.includes(query.plan)) return { ok: false as const };
  const q = query.q?.trim() ?? "";
  if (q.length > 50) return { ok: false as const };
  const now = opts.now ?? (await dbNow(db));
  const access = accessSql(now);
  // 최근 결제: 이 파트너스의 가장 최근 구독 청구(상태 무관, 청구 시각 기준)
  const base = Prisma.sql`${subscriptionFrom}
    LEFT JOIN LATERAL (SELECT sp."amount", sp."status", sp."paidAt", sp."createdAt" FROM "SubscriptionPayment" sp WHERE sp."sellerId" = se."id" ORDER BY sp."createdAt" DESC, sp."id" DESC LIMIT 1) lp ON true
    ${subscriptionWhere}`;
  const conds: Prisma.Sql[] = [];
  if (accessList.length) {
    const any = accessList.map((a) => (a === "locked" ? lockedSql(now) : a === "cancelling" ? cancellingSql(now) : Prisma.sql`(${access}) = ${a}`));
    conds.push(Prisma.sql`(${Prisma.join(any, " OR ")})`);
  }
  if (nextFrom) conds.push(Prisma.sql`sub."nextChargeAt" >= ${nextFrom}`);
  if (nextTo) conds.push(Prisma.sql`sub."nextChargeAt" < ${new Date(nextTo.getTime() + DAY_MS)}`);
  if (query.plan) conds.push(Prisma.sql`p."code" = ${query.plan}`);
  if (q) conds.push(Prisma.sql`(se."shopName" ILIKE ${`%${q}%`} OR se."slug" LIKE ${`%${q.toLowerCase()}%`})`);
  if (cursor) conds.push(Prisma.sql`(se."createdAt" < ${cursor.createdAt} OR (se."createdAt" = ${cursor.createdAt} AND se."id" < ${cursor.id}::uuid))`);
  const extra = conds.length ? Prisma.sql` AND ${Prisma.join(conds, " AND ")}` : Prisma.empty;
  const rows = await db.$queryRaw<SubscriptionRow[]>`
    SELECT se."id" AS "sellerId", se."slug", se."shopName", se."status"::text AS "sellerStatus", se."createdAt", se."trialEndsAt",
      ${access} AS "access", p."code" AS "planCode", p."name" AS "planName",
      sub."status"::text AS "subStatus", sub."cardLabel", sub."currentPeriodEnd", sub."nextChargeAt", sub."cancelAtPeriodEnd", sub."graceUntil", sub."retryCount",
      p."listPrice" AS "planListPrice", p."salePrice" AS "planSalePrice",
      lp."amount" AS "payAmount", lp."status"::text AS "payStatus", lp."paidAt" AS "payPaidAt", lp."createdAt" AS "payCreatedAt"
    ${base}${extra}
    ORDER BY se."createdAt" DESC, se."id" DESC LIMIT ${take + 1}`;
  const counts: SubscriptionCounts = { ...(await subscriptionAccessCounts(db, now)), ...(await subscriptionExtraCounts(db, now)) };
  const page = rows.slice(0, take);
  const last = page[page.length - 1];
  return {
    ok: true as const,
    counts,
    subscriptions: page.map((r) => ({
      seller: { id: r.sellerId, slug: r.slug, shopName: r.shopName, status: r.sellerStatus },
      access: r.access,
      plan: r.planCode ? { code: r.planCode, name: r.planName, listPrice: r.planListPrice, salePrice: r.planSalePrice } : null,
      trialEndsAt: r.trialEndsAt,
      lastPayment: r.payCreatedAt ? { amount: r.payAmount, status: r.payStatus, paidAt: r.payPaidAt, createdAt: r.payCreatedAt } : null,
      subscription: r.subStatus
        ? {
            status: r.subStatus,
            cardLabel: r.cardLabel,
            currentPeriodEnd: r.currentPeriodEnd,
            nextChargeAt: r.nextChargeAt,
            cancelAtPeriodEnd: r.cancelAtPeriodEnd,
            graceUntil: r.graceUntil,
            retryCount: r.retryCount,
          }
        : null,
    })),
    nextCursor: rows.length > take && last ? encodeCursor(last.createdAt, last.sellerId) : null,
  };
}

export type AdminPaymentQuery = {
  status?: string | null;
  kind?: string | null;
  sellerId?: string | null;
  from?: string | null;
  to?: string | null;
  cursor?: string | null;
  limit?: string | null;
};

const PAYMENT_SELECT = {
  id: true,
  amount: true,
  status: true,
  kind: true,
  periodStart: true,
  periodEnd: true,
  scheduled: true,
  launchDiscount: true,
  failureReason: true,
  paidAt: true,
  createdAt: true,
  seller: { select: { id: true, slug: true, shopName: true } },
  targetPlan: { select: { code: true } },
} as const satisfies Prisma.SubscriptionPaymentSelect;

// 청구·결제 내역: 청구 시각 내림차순 커서. status·kind·sellerId·기간(from·to, KST 날짜, 청구 시각 기준, 끝 날짜 포함).
export async function listAdminPayments(db: PrismaClient, admin: AdminSessionContext, query: AdminPaymentQuery) {
  requireRead(admin);
  const take = pageSize(query.limit);
  if (!take) return { ok: false as const };
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cursor) return { ok: false as const };
  if (query.status && !PAY_STATUSES.includes(query.status as SubscriptionPaymentStatus)) return { ok: false as const };
  if (query.kind && !PAY_KINDS.includes(query.kind as SubscriptionPaymentKind)) return { ok: false as const };
  if (query.sellerId && !UUID_RE.test(query.sellerId)) return { ok: false as const };
  const from = query.from ? kstDayStart(query.from) : null;
  const toStart = query.to ? kstDayStart(query.to) : null;
  if ((query.from && !from) || (query.to && !toStart)) return { ok: false as const };
  const and: Prisma.SubscriptionPaymentWhereInput[] = [];
  if (query.status) and.push({ status: query.status as SubscriptionPaymentStatus });
  if (query.kind) and.push({ kind: query.kind as SubscriptionPaymentKind });
  if (query.sellerId) and.push({ sellerId: query.sellerId });
  if (from) and.push({ createdAt: { gte: from } });
  if (toStart) and.push({ createdAt: { lt: new Date(toStart.getTime() + DAY_MS) } });
  if (cursor) and.push({ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] });
  const rows = await db.subscriptionPayment.findMany({
    where: { AND: and },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    select: PAYMENT_SELECT,
  });
  const page = rows.slice(0, take);
  const last = page[page.length - 1];
  return {
    ok: true as const,
    payments: page.map(({ targetPlan, ...p }) => ({ ...p, targetPlanCode: targetPlan?.code ?? null })),
    nextCursor: rows.length > take && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

// 청구 상세: 청구·파트너스·구독(상태·카드·플랜)·결제사 결제 번호·카드 매출전표 주소. 없으면 null.
export async function getAdminPayment(db: PrismaClient, admin: AdminSessionContext, paymentId: string) {
  requireRead(admin);
  const p = await db.subscriptionPayment.findUnique({
    where: { id: paymentId },
    select: {
      ...PAYMENT_SELECT,
      providerPaymentId: true,
      receiptUrl: true,
      subscriptionId: true,
      targetPlanId: true,
      subscription: { select: { status: true, cardLabel: true, cancelAtPeriodEnd: true, billingKeyCipher: true,
        nextChargeAt: true, graceUntil: true, retryCount: true, seller: { select: { status: true } }, plan: { select: { code: true, name: true } } } },
    },
  });
  if (!p) return null;
  const { targetPlan, subscriptionId, targetPlanId, subscription, ...rest } = p;
  const [now, latest, attempts] = await Promise.all([
    dbNow(db),
    db.subscriptionPayment.findFirst({ where: { sellerId: p.seller.id, subscriptionId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, createdAt: true } }),
    db.subscriptionPayment.findMany({
      where: { sellerId: p.seller.id, subscriptionId, periodStart: p.periodStart, periodEnd: p.periodEnd, kind: p.kind, targetPlanId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 101,
      select: { id: true, createdAt: true, status: true, scheduled: true, amount: true, paidAt: true, failureReason: true },
    }),
  ]);
  const retryReason = adminCan(admin.admin.role, "billing.manage") ? invoiceRetryReason(p, latest, subscription, now) : "permission_denied";
  const { billingKeyCipher, seller, ...safeSubscription } = subscription;
  return { ...rest, subscription: safeSubscription, targetPlanCode: targetPlan?.code ?? null,
    canRetry: retryReason === null, retryUnavailableReason: retryReason,
    canRetryAt: retryReason === "too_soon" && latest ? new Date(latest.createdAt.getTime() + RETRY_MIN_GAP_MS) : null,
    attemptHistorySource: "SUBSCRIPTION_PERIOD_PAYMENTS" as const, attemptHistoryTruncated: attempts.length > 100,
    attemptHistory: attempts.slice(0, 100).reverse().map(({ createdAt, ...attempt }) => ({ ...attempt, at: createdAt })),
  };
}

// 요금제 목록(MA-021·022, 마스터 관리자 전 역할 조회). 판매가·정가·체험 일수·체험 한도·월 거래 메일 제공량.
// 메일 제공량은 적용 예정일이 지났으면 새 값이 지금 값이고, 아직이면 next로 준다(발송 설정 GET /api/admin/message-settings와 같은 기준).
export async function listAdminPlans(db: PrismaClient, admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
  const now = await dbNow(db);
  const plans = await db.subscriptionPlan.findMany({ orderBy: { code: "asc" } });
  return {
    plans: plans.map((p) => {
      const pending = p.nextMailQuota !== null && !!p.nextMailQuotaAt && p.nextMailQuotaAt > now;
      return {
        code: p.code,
        name: p.name,
        listPrice: p.listPrice,
        salePrice: p.salePrice,
        trialDays: p.trialDays,
        trialMessageLimit: p.trialMessageLimit,
        trialIdentityLimit: p.trialIdentityLimit,
        trialStorageMb: p.trialStorageMb,
        mailMonthlyQuota: effectiveMailQuota(p, now),
        next: pending ? { mailMonthlyQuota: p.nextMailQuota!, effectiveAt: p.nextMailQuotaAt! } : null,
        updatedAt: p.updatedAt,
      };
    }),
  };
}
