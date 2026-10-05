import { Prisma, type PrismaClient } from "@prisma/client";
import { subscriptionAccessCounts } from "../admin/billing";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { dbNow } from "../billing/subscription";
import { kstDayStart } from "../orders/read";
import { paymentGateway } from "./registry";

// 마스터 관리자 결제 조회(MASTER 배정 2026-10-05): MA-031 PG 연결 상태, MA-032 구독료 수납 현황. 조회만 한다. 모든 마스터 역할(platform.read).
// 키 값·비밀정보·카드 번호는 내려주지 않는다(키가 설정됐는지만).
const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;
export const PG_STATUS_PAGE_DEFAULT = 50;
export const PG_STATUS_PAGE_MAX = 200;
export const BILLING_RANGE_MAX_DAYS = 366;

function requireRead(admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
}

// 결제 실패 코드 → 화면 문구(합니다체, 마스터 관리자). 나이스페이 결과 코드는 공식 매뉴얼(nicepayments/nicepay-manual common/code.md) 기준.
// 한도 초과·정지 카드 같은 카드사 거절은 나이스페이가 따로 나누지 않고 3095(카드사 실패 응답)로 준다.
const FAILURE_MESSAGES: Record<string, string> = {
  // 우리 서버가 정한 코드(payments/service.ts)
  amount_mismatch: "결제 금액이 주문 금액과 달라 승인하지 않았습니다",
  amount_mismatch_cancel_unconfirmed: "결제 금액이 달라 취소를 요청했고 취소 결과를 확인하고 있습니다",
  order_not_payable: "결제할 수 없는 주문이었습니다",
  duplicate_payment: "이미 결제된 주문이었습니다",
  approve_timeout: "결제사 응답이 늦어 승인하지 못했습니다",
  pg_mismatch: "결제사 거래 정보가 맞지 않았습니다",
  pg_cancelled: "결제사에서 취소된 거래입니다",
  pg_failed: "결제사에서 실패한 거래입니다",
  pg_expired: "결제 시간이 지나 거래가 끝났습니다",
  over_balance: "취소할 금액이 남은 결제 금액보다 큽니다",
  provider_mismatch: "다른 결제사로 받은 결제입니다",
  superseded_by_deposit: "무통장 입금 확인으로 결제가 끝났습니다",
  // 나이스페이 결과 코드
  nicepay_3011: "카드 번호가 맞지 않습니다",
  nicepay_3021: "카드 유효기간이 맞지 않습니다",
  nicepay_3022: "할부 개월이 맞지 않습니다",
  nicepay_3023: "할부 개월 한도를 넘었습니다",
  nicepay_3024: "할부는 5만 원 이상부터 됩니다",
  nicepay_3031: "무이자 할부가 되지 않는 카드입니다",
  nicepay_3032: "무이자 할부가 되지 않는 개월입니다",
  nicepay_3041: "1,000원 미만은 신용카드로 결제할 수 없습니다",
  nicepay_3053: "확인할 수 없는 해외 카드입니다",
  nicepay_3057: "인증할 수 없는 카드입니다",
  nicepay_3095: "카드사에서 승인을 거절했습니다(한도 초과·정지 카드 등)",
};

export function paymentFailureMessage(code: string | null): string | null {
  if (!code) return null;
  return FAILURE_MESSAGES[code] ?? (code.startsWith("nicepay_") ? "결제사에서 승인을 거절했습니다" : "결제가 완료되지 않았습니다");
}

type SellerRow = {
  sellerId: string;
  slug: string;
  shopName: string;
  status: string;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureCode: string | null;
  failures24h: number;
  cancelsPending: number;
  cancelsFailed: number;
};

// MA-031: 플랫폼 PG(나이스페이 키 하나) 상태와, 주문 결제가 있는 파트너스마다 최근 결과. 최근 실패가 있는 파트너스 먼저, 그다음 최근 결제 순.
// q: 쇼핑몰 이름·주소. cursor: 다음 쪽 시작 위치(응답의 nextCursor). 잘못된 값이면 { ok: false }.
export async function adminPgStatus(db: PrismaClient, admin: AdminSessionContext, query: { q?: string | null; cursor?: string | null; limit?: string | null }) {
  requireRead(admin);
  const limit = query.limit == null || query.limit === "" ? PG_STATUS_PAGE_DEFAULT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1) return { ok: false as const };
  const take = Math.min(limit, PG_STATUS_PAGE_MAX);
  const offset = query.cursor == null || query.cursor === "" ? 0 : /^\d{1,9}$/.test(query.cursor) ? Number(query.cursor) : NaN;
  if (!Number.isInteger(offset)) return { ok: false as const };
  const q = query.q?.trim() ?? "";
  if (q.length > 50) return { ok: false as const };
  const now = await dbNow(db);
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

  const [[g], rows] = await Promise.all([
    db.$queryRaw<{ lastSuccessAt: Date | null; lastFailureAt: Date | null; lastFailureCode: string | null }[]>`
      SELECT max("approvedAt") AS "lastSuccessAt",
        max("updatedAt") FILTER (WHERE "status" = 'FAILED') AS "lastFailureAt",
        (SELECT "failureCode" FROM "Payment" WHERE "status" = 'FAILED' ORDER BY "updatedAt" DESC, "id" DESC LIMIT 1) AS "lastFailureCode"
      FROM "Payment"`,
    db.$queryRaw<SellerRow[]>`
      WITH p AS (
        SELECT "sellerId",
          max("approvedAt") AS "lastSuccessAt",
          max("updatedAt") FILTER (WHERE "status" = 'FAILED') AS "lastFailureAt",
          count(*) FILTER (WHERE "status" = 'FAILED' AND "updatedAt" > ${new Date(now.getTime() - DAY_MS)})::int AS "failures24h"
        FROM "Payment" GROUP BY "sellerId"
      ),
      c AS (
        SELECT "sellerId",
          count(*) FILTER (WHERE "status" = 'REQUESTED')::int AS "cancelsPending",
          count(*) FILTER (WHERE "status" = 'FAILED')::int AS "cancelsFailed"
        FROM "PaymentCancel" GROUP BY "sellerId"
      )
      SELECT se."id" AS "sellerId", se."slug", se."shopName", se."status"::text AS "status",
        p."lastSuccessAt", p."lastFailureAt", p."failures24h",
        (SELECT "failureCode" FROM "Payment" x WHERE x."sellerId" = se."id" AND x."status" = 'FAILED' ORDER BY x."updatedAt" DESC, x."id" DESC LIMIT 1) AS "lastFailureCode",
        coalesce(c."cancelsPending", 0) AS "cancelsPending", coalesce(c."cancelsFailed", 0) AS "cancelsFailed"
      FROM p JOIN "Seller" se ON se."id" = p."sellerId"
      LEFT JOIN c ON c."sellerId" = p."sellerId"
      WHERE ${q === "" ? Prisma.sql`TRUE` : Prisma.sql`(se."shopName" ILIKE ${like} OR se."slug" ILIKE ${like})`}
      ORDER BY p."lastFailureAt" DESC NULLS LAST, p."lastSuccessAt" DESC NULLS LAST, se."id"
      OFFSET ${offset} LIMIT ${take + 1}`,
  ]);
  const page = rows.slice(0, take);
  return {
    ok: true as const,
    gateway: {
      provider: "nicepay" as const,
      configured: paymentGateway() !== null,
      // 실결제 모드는 대표님 승인 전에는 없다(샌드박스 어댑터만)
      mode: "sandbox" as const,
      lastSuccessAt: g?.lastSuccessAt ?? null,
      lastFailureAt: g?.lastFailureAt ?? null,
      lastFailureCode: g?.lastFailureCode ?? null,
      lastFailureMessage: paymentFailureMessage(g?.lastFailureCode ?? null),
    },
    sellers: page.map((r) => ({
      seller: { id: r.sellerId, slug: r.slug, shopName: r.shopName, status: r.status },
      lastSuccessAt: r.lastSuccessAt,
      lastFailureAt: r.lastFailureAt,
      lastFailureCode: r.lastFailureCode,
      lastFailureMessage: paymentFailureMessage(r.lastFailureCode),
      failures24h: r.failures24h,
      cancelsPending: r.cancelsPending,
      cancelsFailed: r.cancelsFailed,
    })),
    nextCursor: rows.length > take ? String(offset + take) : null,
  };
}

// MA-032: 구독료 수납 현황. 기간(from·to, KST 날짜, 청구 시각 기준, 끝 날짜 포함, 최대 366일, 없으면 오늘 하루).
// 목록은 기존 GET /api/admin/payments, 연체·유예 파트너스는 GET /api/admin/subscriptions?access=를 쓴다.
export async function adminSubscriptionBilling(db: PrismaClient, admin: AdminSessionContext, query: { from?: string | null; to?: string | null }) {
  requireRead(admin);
  const now = await dbNow(db);
  const today = new Date(Math.floor((now.getTime() + KST_MS) / DAY_MS) * DAY_MS - KST_MS);
  const from = query.from ? kstDayStart(query.from) : today;
  const toStart = query.to ? kstDayStart(query.to) : from;
  if (!from || !toStart || toStart < from || (toStart.getTime() - from.getTime()) / DAY_MS >= BILLING_RANGE_MAX_DAYS) return { ok: false as const };
  const end = new Date(toStart.getTime() + DAY_MS);

  const [[s], daily, [subs], access] = await Promise.all([
    db.$queryRaw<{ charged: number; paid: number; failed: number; pending: number; paidAmount: bigint; failedAmount: bigint }[]>`
      SELECT count(*)::int AS "charged",
        count(*) FILTER (WHERE "status" = 'PAID')::int AS "paid",
        count(*) FILTER (WHERE "status" = 'FAILED')::int AS "failed",
        count(*) FILTER (WHERE "status" = 'PENDING')::int AS "pending",
        coalesce(sum("amount"::bigint) FILTER (WHERE "status" = 'PAID'), 0) AS "paidAmount",
        coalesce(sum("amount"::bigint) FILTER (WHERE "status" = 'FAILED'), 0) AS "failedAmount"
      FROM "SubscriptionPayment" WHERE "createdAt" >= ${from} AND "createdAt" < ${end}`,
    db.$queryRaw<{ date: string; charged: number; paid: number; failed: number; paidAmount: bigint }[]>`
      SELECT to_char(("createdAt" AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD') AS "date",
        count(*)::int AS "charged",
        count(*) FILTER (WHERE "status" = 'PAID')::int AS "paid",
        count(*) FILTER (WHERE "status" = 'FAILED')::int AS "failed",
        coalesce(sum("amount"::bigint) FILTER (WHERE "status" = 'PAID'), 0) AS "paidAmount"
      FROM "SubscriptionPayment" WHERE "createdAt" >= ${from} AND "createdAt" < ${end}
      GROUP BY 1 ORDER BY 1`,
    db.$queryRaw<{ retrying: number; pastDue: number }[]>`
      SELECT count(*) FILTER (WHERE "retryCount" > 0 AND "status" IN ('ACTIVE', 'PAST_DUE'))::int AS "retrying",
        count(*) FILTER (WHERE "status" = 'PAST_DUE')::int AS "pastDue"
      FROM "SellerSubscription"`,
    subscriptionAccessCounts(db, now),
  ]);
  return {
    ok: true as const,
    range: { from: query.from ?? kstDate(from), to: query.to ?? kstDate(toStart) },
    summary: {
      charged: s.charged,
      paid: s.paid,
      failed: s.failed,
      pending: s.pending,
      paidAmount: Number(s.paidAmount),
      failedAmount: Number(s.failedAmount),
      retrying: subs.retrying,
      pastDue: subs.pastDue,
      grace: access.grace,
    },
    daily: daily.map((d) => ({ date: d.date, charged: d.charged, paid: d.paid, failed: d.failed, paidAmount: Number(d.paidAmount) })),
  };
}

const kstDate = (d: Date) => new Date(d.getTime() + KST_MS).toISOString().slice(0, 10);
