import { Prisma, type PrismaClient, type SubscriptionPaymentKind, type SubscriptionPaymentStatus } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import type { SellerAccess } from "../billing/access";
import { dbNow } from "../billing/subscription";
import { decodeCursor, encodeCursor, kstDayStart } from "../orders/read";
import { effectiveMailQuota } from "../mail/quota";

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

function pageSize(limit: string | null | undefined) {
  const n = limit == null || limit === "" ? ADMIN_BILLING_PAGE_DEFAULT : Number(limit);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, ADMIN_BILLING_PAGE_MAX) : null;
}

// 이용 상태(sellerAccess와 같은 판정을 SQL로, billing/access.ts). 결제한 기간 > 체험 > 유예(연체) > 결제 처리 대기 > 만료·해지 순.
const accessSql = (now: Date) => Prisma.sql`CASE
  WHEN sub."currentPeriodEnd" > ${now} THEN 'paid'
  WHEN se."trialEndsAt" > ${now} THEN 'trial'
  WHEN sub."status" = 'PAST_DUE' AND NOT sub."cancelAtPeriodEnd" AND sub."graceUntil" > ${now} THEN 'grace'
  WHEN sub."status" = 'ACTIVE' AND NOT sub."cancelAtPeriodEnd" AND sub."nextChargeAt" <= ${now} THEN 'charging'
  ELSE 'expired' END`;

// 구독 현황 대상(승인된 파트너스: 운영 중·정지·종료)과 이용 상태별 수. 구독 현황 탭 숫자와 대시보드(MA-001)가 같은 기준을 쓴다.
const subscriptionBase = Prisma.sql`FROM "Seller" se
    LEFT JOIN "SellerSubscription" sub ON sub."sellerId" = se."id"
    LEFT JOIN "SubscriptionPlan" p ON p."id" = COALESCE(sub."planId", se."planId")
    WHERE se."approvedAt" IS NOT NULL AND se."status" IN ('ACTIVE', 'SUSPENDED', 'CLOSED')`;

export async function subscriptionAccessCounts(db: PrismaClient, now: Date): Promise<Record<SellerAccess, number>> {
  const rows = await db.$queryRaw<{ access: SellerAccess; n: number }[]>`SELECT ${accessSql(now)} AS "access", count(*)::int AS "n" ${subscriptionBase} GROUP BY 1`;
  return Object.fromEntries(ACCESS.map((a) => [a, rows.find((r) => r.access === a)?.n ?? 0])) as Record<SellerAccess, number>;
}

export type AdminSubscriptionQuery = { access?: string | null; plan?: string | null; q?: string | null; cursor?: string | null; limit?: string | null };

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
};

// 구독 현황: 승인된 파트너스(승인 대기·반려 제외)마다 이용 상태와 구독. 가입 시각 내림차순 커서. counts는 필터 전 상태별 수.
export async function listAdminSubscriptions(db: PrismaClient, admin: AdminSessionContext, query: AdminSubscriptionQuery, opts: { now?: Date } = {}) {
  requireRead(admin);
  const take = pageSize(query.limit);
  if (!take) return { ok: false as const };
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cursor) return { ok: false as const };
  if (query.access && !ACCESS.includes(query.access as SellerAccess)) return { ok: false as const };
  if (query.plan && !PLAN_CODES.includes(query.plan)) return { ok: false as const };
  const q = query.q?.trim() ?? "";
  if (q.length > 50) return { ok: false as const };
  const now = opts.now ?? (await dbNow(db));
  const access = accessSql(now);
  const base = subscriptionBase;
  const conds: Prisma.Sql[] = [];
  if (query.access) conds.push(Prisma.sql`(${access}) = ${query.access}`);
  if (query.plan) conds.push(Prisma.sql`p."code" = ${query.plan}`);
  if (q) conds.push(Prisma.sql`(se."shopName" ILIKE ${`%${q}%`} OR se."slug" LIKE ${`%${q.toLowerCase()}%`})`);
  if (cursor) conds.push(Prisma.sql`(se."createdAt" < ${cursor.createdAt} OR (se."createdAt" = ${cursor.createdAt} AND se."id" < ${cursor.id}::uuid))`);
  const extra = conds.length ? Prisma.sql` AND ${Prisma.join(conds, " AND ")}` : Prisma.empty;
  const rows = await db.$queryRaw<SubscriptionRow[]>`
    SELECT se."id" AS "sellerId", se."slug", se."shopName", se."status"::text AS "sellerStatus", se."createdAt", se."trialEndsAt",
      ${access} AS "access", p."code" AS "planCode", p."name" AS "planName",
      sub."status"::text AS "subStatus", sub."cardLabel", sub."currentPeriodEnd", sub."nextChargeAt", sub."cancelAtPeriodEnd", sub."graceUntil", sub."retryCount"
    ${base}${extra}
    ORDER BY se."createdAt" DESC, se."id" DESC LIMIT ${take + 1}`;
  const counts = await subscriptionAccessCounts(db, now);
  const page = rows.slice(0, take);
  const last = page[page.length - 1];
  return {
    ok: true as const,
    counts,
    subscriptions: page.map((r) => ({
      seller: { id: r.sellerId, slug: r.slug, shopName: r.shopName, status: r.sellerStatus },
      access: r.access,
      plan: r.planCode ? { code: r.planCode, name: r.planName } : null,
      trialEndsAt: r.trialEndsAt,
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
      subscription: { select: { status: true, cardLabel: true, plan: { select: { code: true, name: true } } } },
    },
  });
  if (!p) return null;
  const { targetPlan, ...rest } = p;
  return { ...rest, targetPlanCode: targetPlan?.code ?? null };
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
