import { Prisma, type PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { dbNow } from "../billing/subscription";
import { kstDayStart } from "../orders/read";
import { kstDate } from "../stats/range";

// 마스터 관리자 파트너스 상세 「주문 현황」 탭(MA-012-6, platform.read, 읽기 전용). 구매자 정보는 방송 닉네임만 준다(주문 상세·연락처는 대리 조회).
// 판매자 격리: 모든 조회가 sellerId로 묶인다(플랫폼 평균만 전체 집계 비율). 마스터 관리자 전 역할(조회 전용 포함)이 읽는다.
const DAY_MS = 86_400_000;
const RANGES = { today: 0, "7d": 7, "1m": 30, "3m": 90 } as const;
const STATUSES = ["all", "paid", "failed", "refund_requested", "pending"] as const;
const OPEN_RETURN = ["REQUESTED", "ACCEPTED", "RECEIVED"] as const;
const PAGE_DEFAULT = 20;
const PAGE_MAX = 100;
// 이상 징후 기준
const REPEAT_CANCEL_MIN = 3; // 최근 7일 같은 구매자 취소 N건 이상
const SPIKE_RATIO = 3; // 오늘 결제액이 전일의 N배 이상이고
const SPIKE_MIN_AMOUNT = 1_000_000; // 오늘 결제액이 이 금액 이상
const FAIL_STREAK_MIN = 3; // 결제 실패 연속 N건 이상
const RETURN_STALE_MS = 48 * 3_600_000; // 환불 요청 N시간 넘게 미처리

export type SellerOrdersQuery = { range?: string | null; status?: string | null; q?: string | null; page?: string | null; pageSize?: string | null };
type Payment = "PAID" | "FAILED" | "REFUND_REQUESTED" | "PENDING" | "CANCELLED" | "REFUNDED";
type Queue = "OPENING" | "WAITING" | "DONE" | "CANCELLED" | null;

function requireRead(admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
}

const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
const intParam = (v: string | null | undefined, def: number, max: number) => {
  if (v == null || v === "") return def;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
};

// 상태 필터와 행의 「결제」 표시는 같은 규칙: 실패 = 결제 전(결제 대기·취소)이면서 실패한 결제가 있는 주문, 환불 요청 = 결제 완료 주문의 열린 반품 요청(교환 제외).
function statusWhere(status: (typeof STATUSES)[number]): Prisma.OrderWhereInput | null {
  const failed: Prisma.OrderWhereInput = { status: { in: ["PENDING_PAYMENT", "CANCELLED"] }, payments: { some: { status: "FAILED" } } };
  const refund: Prisma.OrderWhereInput = { status: "PAID", returnRequests: { some: { kind: "RETURN", status: { in: [...OPEN_RETURN] } } } };
  if (status === "failed") return failed;
  if (status === "refund_requested") return refund;
  if (status === "paid") return { status: "PAID", NOT: refund };
  if (status === "pending") return { status: "PENDING_PAYMENT", NOT: failed };
  return null;
}

function paymentState(o: { status: string; failed: boolean; openReturn: boolean }): Payment {
  if (o.status === "REFUNDED") return "REFUNDED";
  if (o.status === "PAID") return o.openReturn ? "REFUND_REQUESTED" : "PAID";
  if (o.failed) return "FAILED";
  return o.status === "CANCELLED" ? "CANCELLED" : "PENDING";
}

function queueState(items: { status: string }[]): Queue {
  for (const s of ["OPENING", "WAITING", "DONE", "CANCELLED"] as const) if (items.some((i) => i.status === s)) return s;
  return null;
}

// → { summary, orders, total, page, pageSize, anomalies, monthly }. 없는 파트너스는 null, 조회 조건이 잘못되면 { ok:false }.
// range: today·7d·1m·3m(기본 all, KST 기준 오늘 0시부터 거슬러), status: all·paid·failed·refund_requested·pending, q: 주문 번호(숫자) 또는 닉네임 일부, page(1부터)·pageSize(기본 20, 최대 100). 최신 주문 먼저.
export async function getSellerOrders(db: PrismaClient, admin: AdminSessionContext, sellerId: string, query: SellerOrdersQuery) {
  requireRead(admin);
  const range = query.range || "all";
  const status = (query.status || "all") as (typeof STATUSES)[number];
  const page = intParam(query.page, 1, 100_000);
  const pageSize = intParam(query.pageSize, PAGE_DEFAULT, PAGE_MAX);
  const q = (query.q ?? "").trim();
  if ((range !== "all" && !(range in RANGES)) || !STATUSES.includes(status) || page == null || pageSize == null || q.length > 50) return { ok: false as const };
  if (!(await db.seller.findUnique({ where: { id: sellerId }, select: { id: true } }))) return null;

  const now = await dbNow(db);
  const todayStart = kstDayStart(kstDate(now))!;
  const monthStart = kstDayStart(`${kstDate(now).slice(0, 7)}-01`)!;
  const yesterdayStart = new Date(todayStart.getTime() - DAY_MS);
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);

  const and: Prisma.OrderWhereInput[] = [{ sellerId }];
  if (range !== "all") and.push({ createdAt: { gte: new Date(todayStart.getTime() - RANGES[range as keyof typeof RANGES] * DAY_MS) } });
  const sw = statusWhere(status);
  if (sw) and.push(sw);
  if (q) and.push({ OR: [...(/^\d{1,9}$/.test(q) ? [{ orderNo: Number(q) }] : []), { broadcastNicknameSnapshot: { contains: q, mode: "insensitive" as const } }] });
  const where: Prisma.OrderWhereInput = { AND: and };

  const [rows, total, today, monthGroups, platformGroups, paid, failGroups, recentPay, cancelGroups, todayPaid, yesterdayPaid, staleReturns, monthly] = await Promise.all([
    db.order.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        orderNo: true,
        status: true,
        createdAt: true,
        paidAt: true,
        totalAmount: true,
        broadcastNicknameSnapshot: true,
        items: { orderBy: { createdAt: "asc" }, select: { productNameSnapshot: true, optionNameSnapshot: true, quantity: true } },
        payments: { where: { status: "FAILED" }, take: 1, select: { id: true } },
        returnRequests: { where: { kind: "RETURN", status: { in: [...OPEN_RETURN] } }, take: 1, select: { id: true } },
        queueItems: { select: { status: true } },
      },
    }),
    db.order.count({ where }),
    db.order.count({ where: { sellerId, createdAt: { gte: todayStart } } }),
    db.order.groupBy({ by: ["status"], where: { sellerId, createdAt: { gte: monthStart } }, _count: true }),
    db.order.groupBy({ by: ["status"], where: { createdAt: { gte: monthStart } }, _count: true }),
    db.order.aggregate({ where: { sellerId, paidAt: { gte: monthStart } }, _sum: { totalAmount: true, refundAmount: true } }),
    db.payment.groupBy({ by: ["status"], where: { sellerId, createdAt: { gte: weekAgo }, status: { in: ["PAID", "FAILED"] } }, _count: true }),
    db.payment.findMany({ where: { sellerId, status: { in: ["PAID", "FAILED"] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20, select: { status: true } }),
    db.order.groupBy({ by: ["buyerMemberId"], where: { sellerId, status: "CANCELLED", createdAt: { gte: weekAgo } }, _count: true }),
    db.order.aggregate({ where: { sellerId, paidAt: { gte: todayStart } }, _sum: { totalAmount: true } }),
    db.order.aggregate({ where: { sellerId, paidAt: { gte: yesterdayStart, lt: todayStart } }, _sum: { totalAmount: true } }),
    db.returnRequest.count({ where: { sellerId, kind: "RETURN", status: "REQUESTED", createdAt: { lt: new Date(now.getTime() - RETURN_STALE_MS) } } }),
    // 최근 4개월(KST 월) 주문 수
    db.$queryRaw<{ month: string; count: number }[]>(Prisma.sql`
      SELECT to_char("createdAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM') AS month, count(*)::int AS count
      FROM "Order" WHERE "sellerId" = ${sellerId}::uuid AND "createdAt" >= ${new Date(monthStart.getTime() - 100 * DAY_MS)}
      GROUP BY 1 ORDER BY 1`),
  ]);

  const sum = (g: { status: string; _count: number }[]) => g.reduce((a, x) => a + x._count, 0);
  const closed = (g: { status: string; _count: number }[]) => g.filter((x) => x.status === "CANCELLED" || x.status === "REFUNDED").reduce((a, x) => a + x._count, 0);
  const payOf = (s: string) => failGroups.find((x) => x.status === s)?._count ?? 0;
  let streak = 0;
  for (const p of recentPay) {
    if (p.status !== "FAILED") break;
    streak++;
  }
  const repeatBuyers = cancelGroups.filter((g) => g._count >= REPEAT_CANCEL_MIN).length;
  const todayAmount = todayPaid._sum.totalAmount ?? 0;
  const yesterdayAmount = yesterdayPaid._sum.totalAmount ?? 0;
  const spike = todayAmount >= SPIKE_MIN_AMOUNT && todayAmount >= SPIKE_RATIO * Math.max(yesterdayAmount, 1);
  const flag = (on: boolean) => (on ? ("WARN" as const) : ("OK" as const));

  return {
    ok: true as const,
    summary: {
      todayOrders: today,
      monthOrders: sum(monthGroups),
      monthAmount: (paid._sum.totalAmount ?? 0) - (paid._sum.refundAmount ?? 0),
      // 이번 달 주문 중 취소·환불 비율(%)과 플랫폼 전체 평균. 주문이 없으면 null
      cancelRefundRate: pct(closed(monthGroups), sum(monthGroups)),
      platformCancelRefundRate: pct(closed(platformGroups), sum(platformGroups)),
      // 최근 7일 결제 시도 중 실패 비율(%)
      paymentFailRate7d: pct(payOf("FAILED"), payOf("FAILED") + payOf("PAID")),
      // 환불 분쟁·신고: 아직 이를 담는 기록이 없다(서버 미지원)
      disputeCount: null,
      since: monthStart,
    },
    orders: rows.map((o) => ({
      id: o.id,
      orderNo: o.orderNo,
      createdAt: o.createdAt,
      nickname: o.broadcastNicknameSnapshot,
      productName: o.items[0]?.productNameSnapshot ?? null,
      optionName: o.items[0]?.optionNameSnapshot ?? null,
      quantity: o.items[0]?.quantity ?? 0,
      extraItems: Math.max(o.items.length - 1, 0),
      amount: o.totalAmount,
      payment: paymentState({ status: o.status, failed: o.payments.length > 0, openReturn: o.returnRequests.length > 0 }),
      queue: queueState(o.queueItems),
    })),
    total,
    page,
    pageSize,
    // 각 항목: WARN이면 count가 걸린 건수(반복 취소 구매자 수·연속 실패 건수·미처리 환불 요청 건수), 고액 급증은 오늘·전일 결제액
    anomalies: {
      repeatCancel: { status: flag(repeatBuyers > 0), count: repeatBuyers },
      highAmountSpike: { status: flag(spike), todayAmount, yesterdayAmount },
      paymentFailStreak: { status: flag(streak >= FAIL_STREAK_MIN), count: streak },
      refundRequestOverdue: { status: flag(staleReturns > 0), count: staleReturns },
    },
    monthly: monthly.slice(-4),
  };
}
