import { Prisma, type PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { writeAudit } from "../audit/log";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { dbNow } from "../billing/subscription";
import { kstDayStart } from "../orders/read";
import { formatCsv, guardText } from "../shop-bulk-io/csv";

// 마스터 관리자 파트너스 목록(MA-011, platform.read 모든 마스터 역할). 요약 건수·추가 열·검색·필터·정렬·엑셀(CSV) 내려받기.
// 모든 값은 지금 있는 표에서 계산한다(새 표 없음). 대표자 연락처(전화·이메일)는 목록·내려받기에 넣지 않는다(검색어로만 이메일을 찾을 수 있다).
export const ADMIN_SELLER_PAGE_DEFAULT = 50;
export const ADMIN_SELLER_PAGE_MAX = 200;
export const ADMIN_SELLER_EXPORT_MAX = 5000;
const STATUSES = ["PENDING", "ACTIVE", "SUSPENDED", "REJECTED", "CLOSED"] as const;
const PLAN_CODES = ["OVERLAY_ONLY", "INTEGRATED", "STANDARD"] as const;
export const SELLER_LIST_SORTS = ["joined", "activity", "orders", "overdue"] as const;
export const SELLER_LIST_STATES = ["NORMAL", "TRIAL", "OVERDUE", "LOCKED", "SUSPENDED", "CLOSED"] as const;
const PG_STATES = ["OK", "ERROR", "NONE"] as const;
const ACTIVE_RANGES = ["7d", "30d", "inactive30"] as const;
const FIELDS = ["all", "shop", "rep", "email", "slug", "biz"] as const;
const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;

export type AdminSellerListQuery = {
  q?: string | null;
  field?: string | null;
  status?: string | null;
  state?: string | null;
  plan?: string | null;
  pg?: string | null;
  live?: string | null;
  payout?: string | null;
  note?: string | null;
  joinedFrom?: string | null;
  joinedTo?: string | null;
  active?: string | null;
  sort?: string | null;
  cursor?: string | null;
  limit?: string | null;
  summary?: string | null;
};

function requireRead(admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
}
const oneOf = <T extends string>(list: readonly T[], v: string | null | undefined): T | null | undefined => (v == null || v === "" ? null : (list as readonly string[]).includes(v) ? (v as T) : undefined);
const flag = (v: string | null | undefined): boolean | undefined => (v == null || v === "" || v === "0" ? false : v === "1" ? true : undefined);
const esc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// 표시용 상태: 이용 정지·탈퇴는 판매자 상태, 연체는 구독 연체, 체험 중은 구독 없이 체험 기간 안, 구독이 없고 체험도 끝나면 이용 잠김, 나머지는 정상.
// 파트너스(승인 전 신청·반려 포함 전체 쇼핑몰) 수만큼의 행에 인덱스로 한 줄씩 찾아 붙인다. 주문·결제·방송·회원 표를 통째로 GROUP BY하지 않는다(요청마다 전체 집계 금지, 검수 지적).
// 쓰는 인덱스: Order(sellerId, paidAt)·(sellerId, createdAt) · BroadcastSession(sellerId, status)·(sellerId, startedAt) · Payment(sellerId, approvedAt)·(sellerId, status, updatedAt).
// 회원 수는 정렬·필터에 쓰지 않으므로 화면에 나가는 쪽(최대 limit건)만 따로 센다(memberCounts).
const metricsCte = (now: Date) => {
  const nowKst = new Date(now.getTime() + KST_MS);
  const monthStart = new Date(Date.UTC(nowKst.getUTCFullYear(), nowKst.getUTCMonth(), 1) - KST_MS);
  const dayAgo = new Date(now.getTime() - DAY_MS);
  return Prisma.sql`
  WITH m AS (
    SELECT se."id", se."slug", se."shopName", se."status"::text AS status, se."createdAt", se."approvedAt", se."trialEndsAt",
      se."businessInfo"->>'representativeName' AS rep_name, se."businessInfo"->>'businessNumber' AS biz_no,
      (SELECT u."email" FROM "SellerUser" u WHERE u."sellerId" = se."id" AND u."isOwner" LIMIT 1) AS owner_email,
      pl."code" AS plan_code, pl."name" AS plan_name,
      ss."status"::text AS sub_status, ss."cancelAtPeriodEnd" AS sub_cancel, ss."currentPeriodEnd" AS sub_end,
      row_number() OVER (ORDER BY se."createdAt", se."id")::int AS seq,
      coalesce(ord.month_orders, 0) AS month_orders, coalesce(liv.live, false) AS live,
      greatest(usr.last_login, lst.last_start, lo.last_order) AS last_activity,
      pok.last_ok, pfl.last_fail,
      CASE WHEN coalesce(f24.fail24, 0) > 0 AND (pok.last_ok IS NULL OR pfl.last_fail > pok.last_ok) THEN 'ERROR' WHEN pok.last_ok IS NOT NULL THEN 'OK' ELSE 'NONE' END AS pg,
      coalesce(rp."livePayoutEnabled", false) AS payout, coalesce(nt.notes, 0) AS notes,
      CASE se."status"::text
        WHEN 'CLOSED' THEN 'CLOSED' WHEN 'SUSPENDED' THEN 'SUSPENDED' WHEN 'PENDING' THEN 'PENDING' WHEN 'REJECTED' THEN 'REJECTED'
        ELSE CASE WHEN ss."status"::text = 'PAST_DUE' THEN 'OVERDUE'
          WHEN (ss."id" IS NULL OR ss."status"::text = 'CANCELED') AND se."trialEndsAt" IS NOT NULL AND se."trialEndsAt" > ${now} THEN 'TRIAL'
          WHEN (ss."id" IS NULL OR ss."status"::text = 'CANCELED') AND (se."trialEndsAt" IS NULL OR se."trialEndsAt" <= ${now}) THEN 'LOCKED'
          ELSE 'NORMAL' END
      END AS state
    FROM "Seller" se
    LEFT JOIN "SubscriptionPlan" pl ON pl."id" = se."planId"
    LEFT JOIN "SellerSubscription" ss ON ss."sellerId" = se."id"
    LEFT JOIN LATERAL (SELECT count(*)::int AS month_orders FROM "Order" o WHERE o."sellerId" = se."id" AND o."paidAt" >= ${monthStart}) ord ON TRUE
    LEFT JOIN LATERAL (SELECT TRUE AS live FROM "BroadcastSession" b WHERE b."sellerId" = se."id" AND b."status"::text = 'LIVE' LIMIT 1) liv ON TRUE
    LEFT JOIN LATERAL (SELECT b."startedAt" AS last_start FROM "BroadcastSession" b WHERE b."sellerId" = se."id" ORDER BY b."startedAt" DESC LIMIT 1) lst ON TRUE
    LEFT JOIN LATERAL (SELECT o."createdAt" AS last_order FROM "Order" o WHERE o."sellerId" = se."id" ORDER BY o."createdAt" DESC, o."id" DESC LIMIT 1) lo ON TRUE
    LEFT JOIN LATERAL (SELECT max(u."lastLoginAt") AS last_login FROM "SellerUser" u WHERE u."sellerId" = se."id") usr ON TRUE
    LEFT JOIN LATERAL (SELECT p."approvedAt" AS last_ok FROM "Payment" p WHERE p."sellerId" = se."id" AND p."approvedAt" IS NOT NULL ORDER BY p."approvedAt" DESC LIMIT 1) pok ON TRUE
    LEFT JOIN LATERAL (SELECT p."updatedAt" AS last_fail FROM "Payment" p WHERE p."sellerId" = se."id" AND p."status"::text = 'FAILED' ORDER BY p."updatedAt" DESC LIMIT 1) pfl ON TRUE
    LEFT JOIN LATERAL (SELECT count(*)::int AS fail24 FROM "Payment" p WHERE p."sellerId" = se."id" AND p."status"::text = 'FAILED' AND p."updatedAt" > ${dayAgo}) f24 ON TRUE
    LEFT JOIN LATERAL (SELECT count(*)::int AS notes FROM "SellerAdminNote" n WHERE n."sellerId" = se."id") nt ON TRUE
    LEFT JOIN "RewardPolicy" rp ON rp."sellerId" = se."id"
  )`;
};

// 화면에 나가는 파트너스의 회원 수(탈퇴 제외). 전체 회원 표를 훑지 않고 해당 쇼핑몰만 센다.
async function memberCounts(db: PrismaClient, ids: string[]) {
  if (ids.length === 0) return new Map<string, number>();
  const rows = await db.$queryRaw<{ sellerId: string; n: number }[]>`
    SELECT "sellerId", count(*)::int AS n FROM "BuyerMember" WHERE "sellerId" = ANY(${ids}::uuid[]) AND "status"::text <> 'WITHDRAWN' GROUP BY "sellerId"`;
  return new Map(rows.map((r) => [r.sellerId, r.n]));
}

type Parsed = { where: Prisma.Sql; order: Prisma.Sql; sort: (typeof SELLER_LIST_SORTS)[number]; wantSummary: boolean };

function parse(query: AdminSellerListQuery, now: Date): Parsed | null {
  const status = oneOf(STATUSES, query.status);
  const state = oneOf(SELLER_LIST_STATES, query.state);
  const plan = oneOf(PLAN_CODES, query.plan);
  const pg = oneOf(PG_STATES, query.pg);
  const active = oneOf(ACTIVE_RANGES, query.active);
  const field = oneOf(FIELDS, query.field);
  const sort = oneOf(SELLER_LIST_SORTS, query.sort);
  const live = flag(query.live);
  const payout = flag(query.payout);
  const note = flag(query.note);
  const summary = flag(query.summary);
  if ([status, state, plan, pg, active, field, sort].includes(undefined as never) || [live, payout, note, summary].includes(undefined)) return null;
  const q = query.q?.trim() ?? "";
  if (q.length > 50) return null;
  const from = query.joinedFrom ? kstDayStart(query.joinedFrom) : null;
  const to = query.joinedTo ? kstDayStart(query.joinedTo) : null;
  if ((query.joinedFrom && !from) || (query.joinedTo && !to) || (from && to && from > to)) return null;

  const w: Prisma.Sql[] = [];
  // 파트너스 목록은 가입이 끝난 쇼핑몰만(가입 신청 중·반려는 가입 신청 화면, 요약 total과 같은 기준). status·state를 직접 고르면 그대로 따른다.
  if (!status && !state) w.push(Prisma.sql`status NOT IN ('PENDING', 'REJECTED')`);
  if (status) w.push(Prisma.sql`status = ${status}`);
  if (state) w.push(Prisma.sql`state = ${state}`);
  if (plan) w.push(Prisma.sql`plan_code = ${plan}`);
  if (pg) w.push(Prisma.sql`pg = ${pg}`);
  if (live) w.push(Prisma.sql`live`);
  if (payout) w.push(Prisma.sql`payout`);
  if (note) w.push(Prisma.sql`notes > 0`);
  if (from) w.push(Prisma.sql`"createdAt" >= ${from}`);
  if (to) w.push(Prisma.sql`"createdAt" < ${new Date(to.getTime() + DAY_MS)}`);
  if (active === "7d") w.push(Prisma.sql`last_activity >= ${new Date(now.getTime() - 7 * DAY_MS)}`);
  if (active === "30d") w.push(Prisma.sql`last_activity >= ${new Date(now.getTime() - 30 * DAY_MS)}`);
  if (active === "inactive30") w.push(Prisma.sql`(last_activity IS NULL OR last_activity < ${new Date(now.getTime() - 30 * DAY_MS)})`);
  if (q) {
    const like = `%${esc(q)}%`;
    const digits = q.replace(/\D/g, "");
    const parts = {
      shop: Prisma.sql`"shopName" ILIKE ${like}`,
      rep: Prisma.sql`rep_name ILIKE ${like}`,
      email: Prisma.sql`owner_email ILIKE ${like}`,
      slug: Prisma.sql`slug ILIKE ${like}`,
      biz: digits ? Prisma.sql`replace(coalesce(biz_no, ''), '-', '') LIKE ${`%${digits}%`}` : Prisma.sql`FALSE`,
    };
    const f = field ?? "all";
    w.push(f === "all" ? Prisma.sql`(${Prisma.join(Object.values(parts), " OR ")})` : parts[f]);
  }
  const s = sort ?? "joined";
  const order =
    s === "activity"
      ? Prisma.sql`last_activity DESC NULLS LAST, "createdAt" DESC, id DESC`
      : s === "orders"
        ? Prisma.sql`month_orders DESC, "createdAt" DESC, id DESC`
        : s === "overdue"
          ? Prisma.sql`(state = 'OVERDUE') DESC, "createdAt" DESC, id DESC`
          : Prisma.sql`"createdAt" DESC, id DESC`;
  return { where: w.length ? Prisma.sql`WHERE ${Prisma.join(w, " AND ")}` : Prisma.empty, order, sort: s, wantSummary: summary === true };
}

type Row = {
  id: string; slug: string; shopName: string; status: string; createdAt: Date; approvedAt: Date | null; trialEndsAt: Date | null; rep_name: string | null;
  plan_code: string | null; plan_name: string | null; sub_status: string | null; sub_cancel: boolean | null; sub_end: Date | null;
  seq: number; month_orders: number; live: boolean; last_activity: Date | null; last_ok: Date | null; last_fail: Date | null;
  pg: "OK" | "ERROR" | "NONE"; payout: boolean; notes: number; state: string; total: number;
};

const view = (r: Row, members: number) => ({
  id: r.id,
  slug: r.slug,
  shopName: r.shopName,
  status: r.status,
  // 표시용 상태: NORMAL 정상 · TRIAL 체험 중 · OVERDUE 연체 · LOCKED 이용 기간 끝(구독 없음) · SUSPENDED 이용 정지 · CLOSED 탈퇴(가입 신청 중인 PENDING·반려 REJECTED는 파트너스 목록 밖)
  displayStatus: r.state,
  seq: r.seq,
  representativeName: r.rep_name,
  plan: r.plan_code ? { code: r.plan_code, name: r.plan_name } : null,
  subscription: r.sub_status ? { status: r.sub_status, cancelAtPeriodEnd: r.sub_cancel, currentPeriodEnd: r.sub_end } : null,
  trialEndsAt: r.trialEndsAt,
  approvedAt: r.approvedAt,
  createdAt: r.createdAt,
  // 결제 연결 상태: 최근 24시간 결제 실패가 마지막 성공보다 새로우면 ERROR, 결제 성공이 있으면 OK, 결제 기록이 없으면 NONE(미연결)
  pg: { status: r.pg, lastSuccessAt: r.last_ok, lastFailureAt: r.last_fail },
  live: r.live,
  ordersThisMonth: r.month_orders,
  memberCount: members,
  // 최근 활동: 직원 마지막 로그인·방송 시작·주문 생성 중 가장 최근(없으면 null)
  lastActivityAt: r.last_activity,
  payoutEnabled: r.payout,
  noteCount: r.notes,
});

export async function listAdminSellers(db: PrismaClient, admin: AdminSessionContext, query: AdminSellerListQuery) {
  requireRead(admin);
  const limit = query.limit == null || query.limit === "" ? ADMIN_SELLER_PAGE_DEFAULT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1) return { ok: false as const };
  const take = Math.min(limit, ADMIN_SELLER_PAGE_MAX);
  const offset = query.cursor == null || query.cursor === "" ? 0 : /^\d{1,9}$/.test(query.cursor) ? Number(query.cursor) : NaN;
  if (!Number.isInteger(offset)) return { ok: false as const };
  const now = await dbNow(db);
  const p = parse(query, now);
  if (!p) return { ok: false as const };
  const rows = await db.$queryRaw<Row[]>`${metricsCte(now)}
    SELECT *, count(*) OVER ()::int AS total FROM m ${p.where} ORDER BY ${p.order} OFFSET ${offset} LIMIT ${take + 1}`;
  const page = rows.slice(0, take);
  const counts = await memberCounts(db, page.map((r) => r.id));
  const summary = p.wantSummary ? await sellerListSummary(db, now) : undefined;
  return {
    ok: true as const,
    sellers: page.map((r) => view(r, counts.get(r.id) ?? 0)),
    // 조건에 맞는 전체 수(번호형 페이지용). 쪽 이동은 cursor(= 건너뛸 개수)로 한다
    total: rows[0]?.total ?? (offset > 0 ? null : 0),
    nextCursor: rows.length > take ? String(offset + take) : null,
    ...(summary ? { summary } : {}),
  };
}

// 상단 요약 건수(파트너스 = 가입이 끝난 쇼핑몰: 이용 중·정지·탈퇴). 가입 신청 중은 pendingApplications로 따로.
export async function sellerListSummary(db: PrismaClient, now: Date) {
  const [r] = await db.$queryRaw<
    { total: number; normal: number; trial: number; overdue: number; locked: number; suspended: number; closed: number; pgError: number; pgNone: number; payout: number; live: number; pending: number }[]
  >`${metricsCte(now)}
    SELECT count(*) FILTER (WHERE state IN ('NORMAL','TRIAL','OVERDUE','LOCKED','SUSPENDED','CLOSED'))::int AS total,
      count(*) FILTER (WHERE state = 'NORMAL')::int AS normal, count(*) FILTER (WHERE state = 'TRIAL')::int AS trial,
      count(*) FILTER (WHERE state = 'OVERDUE')::int AS overdue, count(*) FILTER (WHERE state = 'LOCKED')::int AS locked,
      count(*) FILTER (WHERE state = 'SUSPENDED')::int AS suspended, count(*) FILTER (WHERE state = 'CLOSED')::int AS closed,
      count(*) FILTER (WHERE pg = 'ERROR' AND state IN ('NORMAL','TRIAL','OVERDUE','LOCKED'))::int AS "pgError",
      count(*) FILTER (WHERE pg = 'NONE' AND state IN ('NORMAL','TRIAL','OVERDUE','LOCKED'))::int AS "pgNone",
      count(*) FILTER (WHERE payout AND state IN ('NORMAL','TRIAL','OVERDUE','LOCKED'))::int AS payout,
      count(*) FILTER (WHERE live AND state IN ('NORMAL','TRIAL','OVERDUE','LOCKED'))::int AS live,
      count(*) FILTER (WHERE state = 'PENDING')::int AS pending
    FROM m`;
  return {
    total: r.total, normal: r.normal, trial: r.trial, overdue: r.overdue, locked: r.locked, suspended: r.suspended, closed: r.closed,
    pgError: r.pgError, pgNone: r.pgNone, payoutEnabled: r.payout, live: r.live, pendingApplications: r.pending,
  };
}

const KST_TEXT = (d: Date | null) => {
  if (!d) return "";
  const k = new Date(d.getTime() + KST_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${k.getUTCFullYear()}.${p(k.getUTCMonth() + 1)}.${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
};
const STATE_TEXT: Record<string, string> = { NORMAL: "정상", TRIAL: "체험 중", OVERDUE: "연체", LOCKED: "이용 기간 끝", SUSPENDED: "이용 정지", CLOSED: "탈퇴", PENDING: "가입 신청 중", REJECTED: "반려" };
const PG_TEXT = { OK: "정상", ERROR: "오류", NONE: "미연결" } as const;

// 엑셀(CSV) 내려받기: 같은 조건(검색·필터·정렬)으로 최대 5,000건. 대표자 연락처는 넣지 않는다. 내려받은 사실만 로그 추적에 남긴다(내용 없음).
export async function exportAdminSellers(db: PrismaClient, admin: AdminSessionContext, query: AdminSellerListQuery, meta: { ip?: string | null; userAgent?: string | null } = {}) {
  requireRead(admin);
  const now = await dbNow(db);
  const p = parse(query, now);
  if (!p) return { ok: false as const };
  const rows = await db.$queryRaw<Row[]>`${metricsCte(now)}
    SELECT *, count(*) OVER ()::int AS total FROM m ${p.where} ORDER BY ${p.order} LIMIT ${ADMIN_SELLER_EXPORT_MAX}`;
  const counts = await memberCounts(db, rows.map((r) => r.id));
  const head = ["번호", "쇼핑몰 이름", "쇼핑몰 주소", "상태", "구독", "결제 연결", "방송 중", "이번 달 주문", "회원 수", "가입일", "최근 활동"];
  const csv = formatCsv([
    head,
    ...rows.map((r) => [
      String(r.seq), guardText(r.shopName), r.slug, STATE_TEXT[r.state] ?? r.state, r.plan_name ?? "", PG_TEXT[r.pg], r.live ? "방송 중" : "", String(r.month_orders), String(counts.get(r.id) ?? 0), KST_TEXT(r.createdAt), KST_TEXT(r.last_activity),
    ]),
  ]);
  await writeAudit(db, {
    actorType: "PLATFORM_ADMIN",
    actorId: admin.admin.id,
    action: "admin.sellers.export",
    targetType: "SellerList",
    targetId: "export",
    after: { rows: rows.length, truncated: (rows[0]?.total ?? 0) > ADMIN_SELLER_EXPORT_MAX, filters: Object.fromEntries(Object.entries(query).filter(([k, v]) => v && k !== "cursor" && k !== "limit" && k !== "summary")) },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { ok: true as const, csv, rows: rows.length };
}
