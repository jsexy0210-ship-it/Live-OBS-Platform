import type { Prisma, PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { writeAudit } from "../audit/log";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { dbNow } from "../billing/subscription";
import { mailSender } from "../mail/registry";
import { sendMail, type MailSender } from "../mail/quota";
import { kstDayStart } from "../orders/read";
import { approveSeller, rejectSeller } from "./approval";
import type { ReviewReason } from "./application";

// 마스터 관리자 가입 신청(MA-013·014): 처리 대기 목록·요약(KPI)·이력, 보완 요청·재촉 메일·선택 승인·승인 되돌리기(10초).
// 가입 신청 = 승인 대기(PENDING) 쇼핑몰. 상태는 계산한다: 보완 요청 중(SUPPLEMENT) > 확인 필요(REVIEW, reviewReasons 있음) > 이상 없음(CLEAR).
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const KST_MS = 9 * HOUR_MS;
export const SUPPLEMENT_DAYS = 7;
export const REMIND_COOLDOWN_MS = DAY_MS;
export const REMIND_MAX = 3;
export const UNDO_WINDOW_MS = 10_000;
// 서버·화면 시계 차이를 받아 주는 여유(응답을 받아 되돌리기를 누르기까지)
const UNDO_GRACE_MS = 2_000;
export const BULK_APPROVE_MAX = 50;
export const APPLICATION_LIST_MAX = 1000;
const HISTORY_DAYS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Meta = { ip?: string | null; userAgent?: string | null };

// 걸린 항목 문구(마스터 관리자, 합니다체)
export const REVIEW_REASON_TEXT: Record<ReviewReason, string> = {
  business_lookup_failed: "국세청 조회가 잠시 안 됐습니다 · 다시 조회 필요",
  business_info_mismatch: "사업자 정보(사업자번호·대표자명·개업일자)가 국세청 기록과 다릅니다",
  business_not_active: "사업자 상태가 휴업 또는 폐업입니다",
  business_duplicate: "같은 사업자번호로 운영 중이거나 신청 중인 쇼핑몰이 있습니다",
  mail_order_number_invalid: "통신판매업 신고번호를 확인할 수 없습니다",
  mail_order_lookup_failed: "통신판매업 조회가 잠시 안 됐습니다 · 다시 조회 필요",
  mail_order_not_registered: "통신판매업 신고 내역이 없거나 사업자번호와 다릅니다",
  mail_order_not_active: "통신판매업 영업 상태가 정상이 아닙니다",
};
export const APPLICATION_MESSAGES = {
  reason_required: "사유를 입력해 주십시오(200자 이내)",
  not_found: "가입 신청을 찾을 수 없습니다",
  not_pending: "이미 처리된 가입 신청입니다",
  already_requested: "이미 보완을 요청했습니다",
  not_requested: "보완을 요청한 신청이 아닙니다",
  remind_too_soon: "재촉 메일은 하루에 한 번만 보낼 수 있습니다",
  remind_limit: "재촉 메일은 최대 3번까지 보낼 수 있습니다",
  mail_unavailable: "메일을 보낼 수 없습니다. 메일 서비스가 연결되지 않았습니다",
  mail_limit: "메일 발송 한도에 이르러 보내지 못했습니다. 잠시 뒤 다시 시도해 주십시오",
  mail_failed: "메일을 보내지 못했습니다. 잠시 뒤 다시 시도해 주십시오",
  needs_review: "확인 필요·보완 요청 건은 한꺼번에 승인할 수 없습니다. 하나씩 확인해 주십시오",
  undo_expired: "승인을 되돌릴 수 있는 시간(10초)이 지났습니다",
  not_undoable: "되돌릴 수 없는 승인입니다",
  invalid_input: "입력한 내용을 확인해 주십시오",
} as const;
export type ApplicationFailure = keyof typeof APPLICATION_MESSAGES;

function needModerate(admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "seller.moderate")) throw forbidden();
}
function needRead(admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
}
const kstDayStartOf = (now: Date) => {
  const k = new Date(now.getTime() + KST_MS);
  return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()) - KST_MS);
};
const kstMonthStartOf = (now: Date) => {
  const k = new Date(now.getTime() + KST_MS);
  return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), 1) - KST_MS);
};
const biz = (v: unknown) => (typeof v === "string" ? v.replace(/\D/g, "") : "");
const fmtBiz = (d: string) => (d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : d);
const info = (j: Prisma.JsonValue | null) => (j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : {});

type Pending = {
  id: string; slug: string; shopName: string; createdAt: Date; businessInfo: Prisma.JsonValue | null; reviewReasons: string[];
  owner: string | null; rev: { supplementReason: string | null; supplementRequestedAt: Date | null; supplementDueAt: Date | null; supplementResolvedAt: Date | null; reminderCount: number; lastReminderAt: Date | null } | null;
};
async function loadPending(db: PrismaClient): Promise<Pending[]> {
  const sellers = await db.seller.findMany({
    where: { status: "PENDING" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: APPLICATION_LIST_MAX,
    select: { id: true, slug: true, shopName: true, createdAt: true, businessInfo: true, reviewReasons: true },
  });
  const ids = sellers.map((s) => s.id);
  const [owners, revs] = await Promise.all([
    db.sellerUser.findMany({ where: { sellerId: { in: ids }, isOwner: true }, select: { sellerId: true, email: true } }),
    db.sellerApplicationReview.findMany({ where: { sellerId: { in: ids } } }),
  ]);
  const o = new Map(owners.map((u) => [u.sellerId, u.email]));
  const r = new Map(revs.map((x) => [x.sellerId, x]));
  return sellers.map((s) => ({ ...s, owner: o.get(s.id) ?? null, rev: r.get(s.id) ?? null }));
}
const supplementOpen = (p: Pending) => !!p.rev?.supplementRequestedAt && !p.rev.supplementResolvedAt;
const stateOf = (p: Pending): "SUPPLEMENT" | "REVIEW" | "CLEAR" => (supplementOpen(p) ? "SUPPLEMENT" : p.reviewReasons.length > 0 ? "REVIEW" : "CLEAR");

export type ApplicationListQuery = {
  tab?: string | null; sort?: string | null; q?: string | null; field?: string | null; industry?: string | null;
  receivedFrom?: string | null; receivedTo?: string | null; result?: string | null; cursor?: string | null; limit?: string | null;
};
const TABS = ["all", "clear", "review", "supplement", "over48h", "today", "history"] as const;
const SORTS = ["oldest", "newest"] as const;
const RESULTS = ["auto", "approved", "rejected"] as const;
const FIELDS = ["all", "shop", "applicant", "biz"] as const;
const one = <T extends string>(l: readonly T[], v: string | null | undefined, d: T): T | undefined => (v == null || v === "" ? d : (l as readonly string[]).includes(v) ? (v as T) : undefined);

// 가입 신청 목록(MA-013, platform.read). tab: all(전체)·clear(이상 없음)·review(확인 필요)·supplement(보완 요청)·over48h(48시간 초과)·today(오늘 접수)·history(자동 승인·승인·반려 이력).
// result(이력만): auto(자동 승인)·approved(승인)·rejected(반려). 응답 { chips, kpi, industries, applications | history, total, nextCursor }. 잘못된 값이면 { ok: false }.
export async function listApplications(db: PrismaClient, admin: AdminSessionContext, query: ApplicationListQuery) {
  needRead(admin);
  const tab = one(TABS, query.tab, "all");
  const sort = one(SORTS, query.sort, "oldest");
  const field = one(FIELDS, query.field, "all");
  const limit = query.limit == null || query.limit === "" ? 20 : Number(query.limit);
  const offset = query.cursor == null || query.cursor === "" ? 0 : /^\d{1,9}$/.test(query.cursor) ? Number(query.cursor) : NaN;
  const q = query.q?.trim() ?? "";
  const from = query.receivedFrom ? kstDayStart(query.receivedFrom) : null;
  const to = query.receivedTo ? kstDayStart(query.receivedTo) : null;
  const industry = query.industry?.trim() ?? "";
  const result = one(RESULTS, query.result, "" as never);
  if (query.result && !result) return { ok: false as const };
  if (!tab || !sort || !field || !Number.isInteger(limit) || limit < 1 || !Number.isInteger(offset) || q.length > 50 || industry.length > 30) return { ok: false as const };
  if ((query.receivedFrom && !from) || (query.receivedTo && !to) || (from && to && from > to)) return { ok: false as const };
  const now = await dbNow(db);
  const take = Math.min(limit, 100);
  const dayStart = kstDayStartOf(now);
  const over48 = new Date(now.getTime() - 48 * HOUR_MS);

  const all = await loadPending(db);
  const chips = {
    all: all.length,
    clear: all.filter((p) => stateOf(p) === "CLEAR").length,
    review: all.filter((p) => stateOf(p) === "REVIEW").length,
    supplement: all.filter((p) => stateOf(p) === "SUPPLEMENT").length,
    over48h: all.filter((p) => p.createdAt < over48 && stateOf(p) !== "SUPPLEMENT").length,
    today: all.filter((p) => p.createdAt >= dayStart).length,
  };
  const kpi = await applicationKpi(db, now, chips);
  const industries = [...new Set(all.map((p) => String(info(p.businessInfo).industry ?? "")).filter(Boolean))].sort();

  if (tab === "history") {
    const want = result === "auto" ? "AUTO_APPROVED" : result === "approved" ? "APPROVED" : result === "rejected" ? "REJECTED" : null;
    const h = (await applicationHistory(db, now, { q, field, from, to, industry })).filter((x) => !want || x.result === want);
    const page = h.slice(offset, offset + take);
    return { ok: true as const, chips, kpi, industries, history: page, total: h.length, nextCursor: offset + take < h.length ? String(offset + take) : null };
  }

  let rows = all.filter((p) => {
    const st = stateOf(p);
    if (tab === "clear" && st !== "CLEAR") return false;
    if (tab === "review" && st !== "REVIEW") return false;
    if (tab === "supplement" && st !== "SUPPLEMENT") return false;
    if (tab === "over48h" && !(p.createdAt < over48 && st !== "SUPPLEMENT")) return false;
    if (tab === "today" && p.createdAt < dayStart) return false;
    if (from && p.createdAt < from) return false;
    if (to && p.createdAt >= new Date(to.getTime() + DAY_MS)) return false;
    const i = info(p.businessInfo);
    if (industry && i.industry !== industry) return false;
    if (q) {
      const lc = q.toLowerCase();
      const hit = {
        shop: p.shopName.toLowerCase().includes(lc) || p.slug.includes(lc),
        applicant: String(i.representativeName ?? "").toLowerCase().includes(lc) || (p.owner ?? "").toLowerCase().includes(lc),
        biz: biz(q).length > 0 && biz(i.businessNumber).includes(biz(q)),
      };
      if (!(field === "all" ? hit.shop || hit.applicant || hit.biz : hit[field])) return false;
    }
    return true;
  });
  if (sort === "newest") rows = [...rows].reverse();
  const page = rows.slice(offset, offset + take).map((p) => viewApplication(p, now));
  return { ok: true as const, chips, kpi, industries, applications: page, total: rows.length, nextCursor: offset + take < rows.length ? String(offset + take) : null };
}

function viewApplication(p: Pending, now: Date) {
  const i = info(p.businessInfo);
  const st = stateOf(p);
  const rev = p.rev;
  return {
    id: p.id,
    slug: p.slug,
    shopName: p.shopName,
    state: st,
    applicantName: typeof i.representativeName === "string" ? i.representativeName : null,
    applicantEmail: p.owner,
    businessNumber: fmtBiz(biz(i.businessNumber)) || null,
    industry: typeof i.industry === "string" && i.industry ? i.industry : null,
    receivedAt: p.createdAt,
    elapsedHours: Math.floor((now.getTime() - p.createdAt.getTime()) / HOUR_MS),
    over48h: st !== "SUPPLEMENT" && now.getTime() - p.createdAt.getTime() > 48 * HOUR_MS,
    reasons: p.reviewReasons.map((c) => ({ code: c, text: REVIEW_REASON_TEXT[c as ReviewReason] ?? "확인할 내용이 있습니다" })),
    supplement:
      st === "SUPPLEMENT" && rev
        ? {
            reason: rev.supplementReason,
            requestedAt: rev.supplementRequestedAt,
            dueAt: rev.supplementDueAt,
            dueExpired: !!rev.supplementDueAt && rev.supplementDueAt.getTime() <= now.getTime(),
            daysLeft: rev.supplementDueAt ? Math.max(0, Math.ceil((rev.supplementDueAt.getTime() - now.getTime()) / DAY_MS)) : null,
            reminderCount: rev.reminderCount,
            lastReminderAt: rev.lastReminderAt,
            canRemindAt: rev.lastReminderAt ? new Date(rev.lastReminderAt.getTime() + REMIND_COOLDOWN_MS) : null,
          }
        : null,
  };
}

// 상단 요약(KPI). 평균 처리 시간은 사람이 처리(승인·반려)한 건의 접수→결정 시간, 이번 주(최근 7일)와 지난주(그 앞 7일).
async function applicationKpi(db: PrismaClient, now: Date, chips: { all: number; clear: number; review: number; supplement: number; over48h: number; today: number }) {
  const day = kstDayStartOf(now);
  const month = kstMonthStartOf(now);
  const w1 = new Date(now.getTime() - 7 * DAY_MS);
  const w2 = new Date(now.getTime() - 14 * DAY_MS);
  const [autoToday, manualToday, autoMonth, rejToday, rejMonth, handled] = await Promise.all([
    db.seller.count({ where: { approvedAt: { gte: day }, approvedByAdminId: null } }),
    db.seller.count({ where: { approvedAt: { gte: day }, approvedByAdminId: { not: null } } }),
    db.seller.count({ where: { approvedAt: { gte: month }, approvedByAdminId: null } }),
    db.seller.count({ where: { rejectedAt: { gte: day } } }),
    db.seller.count({ where: { rejectedAt: { gte: month } } }),
    db.$queryRaw<{ wk: number; hours: number | null }[]>`
      SELECT CASE WHEN t >= ${w1} THEN 1 ELSE 0 END AS wk, avg(extract(epoch FROM (t - "createdAt")) / 3600)::float AS hours
      FROM (SELECT "createdAt", coalesce("approvedAt", "rejectedAt") AS t FROM "Seller"
            WHERE ("approvedAt" IS NOT NULL AND "approvedByAdminId" IS NOT NULL) OR "rejectedAt" IS NOT NULL) x
      WHERE t >= ${w2} GROUP BY 1`,
  ]);
  const hrs = (wk: number) => {
    const v = handled.find((r) => r.wk === wk)?.hours;
    return v == null ? null : Math.round(v * 10) / 10;
  };
  return {
    pending: chips.all,
    needsReview: chips.review,
    clear: chips.clear,
    supplement: chips.supplement,
    over48h: chips.over48h,
    receivedToday: chips.today,
    autoApprovedToday: autoToday,
    autoApprovedMonth: autoMonth,
    approvedToday: autoToday + manualToday,
    rejectedToday: rejToday,
    rejectedMonth: rejMonth,
    avgHandlingHours: { thisWeek: hrs(1), lastWeek: hrs(0) },
  };
}

// 이력: 최근 30일 자동 승인·승인(마스터)·반려. 방금 한 마스터 승인은 undoableUntil(10초)까지 되돌릴 수 있다.
async function applicationHistory(db: PrismaClient, now: Date, f: { q: string; field: string; from: Date | null; to: Date | null; industry: string }) {
  const since = new Date(now.getTime() - HISTORY_DAYS * DAY_MS);
  const rows = await db.seller.findMany({
    where: { OR: [{ approvedAt: { gte: since } }, { rejectedAt: { gte: since } }], status: { in: ["ACTIVE", "SUSPENDED", "CLOSED", "REJECTED"] } },
    select: { id: true, slug: true, shopName: true, status: true, createdAt: true, approvedAt: true, approvedByAdminId: true, rejectedAt: true, rejectedReason: true, businessInfo: true },
    take: 500,
  });
  const out = rows
    .map((s) => {
      const rejected = !!s.rejectedAt && s.status === "REJECTED";
      const at = rejected ? s.rejectedAt! : s.approvedAt!;
      return {
        id: s.id, slug: s.slug, shopName: s.shopName, result: rejected ? ("REJECTED" as const) : s.approvedByAdminId ? ("APPROVED" as const) : ("AUTO_APPROVED" as const),
        at, receivedAt: s.createdAt, reason: rejected ? s.rejectedReason : null, industry: (info(s.businessInfo).industry as string | undefined) ?? null,
        applicantName: (info(s.businessInfo).representativeName as string | undefined) ?? null,
        undoableUntil: !rejected && s.approvedByAdminId && s.status === "ACTIVE" ? new Date(s.approvedAt!.getTime() + UNDO_WINDOW_MS) : null,
        biz: biz(info(s.businessInfo).businessNumber),
      };
    })
    .filter((r) => r.at && (!f.from || r.receivedAt >= f.from) && (!f.to || r.receivedAt < new Date(f.to.getTime() + DAY_MS)) && (!f.industry || r.industry === f.industry))
    .filter((r) => {
      if (!f.q) return true;
      const lc = f.q.toLowerCase();
      const hit = { shop: r.shopName.toLowerCase().includes(lc) || r.slug.includes(lc), applicant: (r.applicantName ?? "").toLowerCase().includes(lc), biz: biz(f.q).length > 0 && r.biz.includes(biz(f.q)) };
      return f.field === "all" ? hit.shop || hit.applicant || hit.biz : hit[f.field as "shop" | "applicant" | "biz"];
    })
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  return out.map(({ biz: _b, ...r }) => r);
}

// 보완 요청(마스터 seller.moderate): 승인 대기 신청에 사유를 남기고 7일 기한을 건다. 기한이 지나면 정기 작업이 자동 반려한다(디자인 정본 「7일 안에 보완하지 않으면 자동 반려됩니다」).
export async function requestSupplement(db: PrismaClient, admin: AdminSessionContext, sellerId: string, rawReason: unknown, meta: Meta = {}) {
  needModerate(admin);
  const reason = typeof rawReason === "string" ? rawReason.trim() : "";
  if (!reason || reason.length > 200) return { ok: false as const, reason: "reason_required" as const };
  return db.$transaction(async (tx) => {
    const [s] = await tx.$queryRaw<{ status: string }[]>`SELECT "status"::text AS status FROM "Seller" WHERE "id" = ${sellerId}::uuid FOR UPDATE`;
    if (!s) return { ok: false as const, reason: "not_found" as const };
    if (s.status !== "PENDING") return { ok: false as const, reason: "not_pending" as const };
    const now = await dbNow(tx);
    const cur = await tx.sellerApplicationReview.findUnique({ where: { sellerId } });
    if (cur?.supplementRequestedAt && !cur.supplementResolvedAt) return { ok: false as const, reason: "already_requested" as const };
    const dueAt = new Date(now.getTime() + SUPPLEMENT_DAYS * DAY_MS);
    const data = { supplementReason: reason, supplementRequestedAt: now, supplementDueAt: dueAt, supplementResolvedAt: null, supplementByAdminId: admin.admin.id, reminderCount: 0, lastReminderAt: null };
    await tx.sellerApplicationReview.upsert({ where: { sellerId }, create: { sellerId, ...data }, update: data });
    await writeAudit(tx, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, sellerId, action: "admin.seller.supplement_request", targetType: "Seller", targetId: sellerId, reason, after: { dueAt }, ip: meta.ip, userAgent: meta.userAgent });
    return { ok: true as const, dueAt };
  });
}

// 보완 확인(신청자가 보완을 마친 것을 확인): 보완 요청 상태를 풀고 다시 확인 필요·이상 없음 대기로 돌린다.
export async function resolveSupplement(db: PrismaClient, admin: AdminSessionContext, sellerId: string, meta: Meta = {}) {
  needModerate(admin);
  return db.$transaction(async (tx) => {
    const now = await dbNow(tx);
    const moved = await tx.sellerApplicationReview.updateMany({ where: { sellerId, supplementRequestedAt: { not: null }, supplementResolvedAt: null }, data: { supplementResolvedAt: now } });
    if (moved.count !== 1) {
      const s = await tx.seller.findUnique({ where: { id: sellerId }, select: { status: true } });
      return { ok: false as const, reason: !s ? ("not_found" as const) : ("not_requested" as const) };
    }
    await writeAudit(tx, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, sellerId, action: "admin.seller.supplement_resolve", targetType: "Seller", targetId: sellerId, ip: meta.ip, userAgent: meta.userAgent });
    return { ok: true as const };
  });
}

// 재촉 메일: 보완 요청 중인 신청자(대표자 이메일)에게 하루 한 번. 실제로 보낸 때만 횟수·시각을 올린다(공급자 없음·한도·실패는 기록하지 않는다). 메일 주소는 기록에 남기지 않는다.
export async function remindSupplement(db: PrismaClient, admin: AdminSessionContext, sellerId: string, opts: { sender?: MailSender | null; meta?: Meta } = {}) {
  needModerate(admin);
  const now = await dbNow(db);
  const [s, rev, owner] = await Promise.all([
    db.seller.findUnique({ where: { id: sellerId }, select: { status: true, shopName: true } }),
    db.sellerApplicationReview.findUnique({ where: { sellerId } }),
    db.sellerUser.findFirst({ where: { sellerId, isOwner: true }, select: { email: true } }),
  ]);
  if (!s) return { ok: false as const, reason: "not_found" as const };
  if (s.status !== "PENDING") return { ok: false as const, reason: "not_pending" as const };
  if (!rev?.supplementRequestedAt || rev.supplementResolvedAt || !owner) return { ok: false as const, reason: "not_requested" as const };
  if (rev.reminderCount >= REMIND_MAX) return { ok: false as const, reason: "remind_limit" as const };
  if (rev.lastReminderAt && now.getTime() - rev.lastReminderAt.getTime() < REMIND_COOLDOWN_MS) {
    return { ok: false as const, reason: "remind_too_soon" as const, canRemindAt: new Date(rev.lastReminderAt.getTime() + REMIND_COOLDOWN_MS) };
  }
  const sender = opts.sender === undefined ? mailSender() : opts.sender;
  if (!sender) return { ok: false as const, reason: "mail_unavailable" as const };
  const due = rev.supplementDueAt ? new Date(rev.supplementDueAt.getTime() + KST_MS) : null;
  const dueText = due ? `${due.getUTCMonth() + 1}월 ${due.getUTCDate()}일` : "기한";
  const r = await sendMail(db, sender, {
    sellerId: null,
    kind: "application.supplement_reminder",
    refId: sellerId,
    message: {
      to: owner.email,
      subject: "[ONQ] 가입 신청 보완이 필요합니다",
      text: `${s.shopName} 가입 신청에 보완이 필요합니다.\n보완할 내용: ${rev.supplementReason ?? ""}\n${dueText}까지 보완하지 않으면 가입 신청이 자동으로 반려됩니다.`,
      html: `<p>${esc(s.shopName)} 가입 신청에 보완이 필요합니다.</p><p>보완할 내용: ${esc(rev.supplementReason ?? "")}</p><p>${dueText}까지 보완하지 않으면 가입 신청이 자동으로 반려됩니다.</p>`,
    },
  });
  if (r.status === "SKIPPED_PLATFORM_LIMIT" || r.status === "SKIPPED_BALANCE") return { ok: false as const, reason: "mail_limit" as const };
  if (r.status !== "SENT") return { ok: false as const, reason: "mail_failed" as const };
  // 하루 한 번 제한은 조건부 갱신으로 지킨다(동시에 두 번 눌러도 한 번만 센다)
  const stamp = await db.sellerApplicationReview.updateMany({
    where: { sellerId, supplementResolvedAt: null, reminderCount: { lt: REMIND_MAX }, OR: [{ lastReminderAt: null }, { lastReminderAt: { lte: new Date(now.getTime() - REMIND_COOLDOWN_MS) } }] },
    data: { reminderCount: { increment: 1 }, lastReminderAt: now },
  });
  await writeAudit(db, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, sellerId, action: "admin.seller.supplement_remind", targetType: "Seller", targetId: sellerId, after: { mail: r.status, counted: stamp.count === 1 }, ip: opts.meta?.ip, userAgent: opts.meta?.userAgent });
  return { ok: true as const, sentAt: now, reminderCount: rev.reminderCount + (stamp.count === 1 ? 1 : 0) };
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// 선택 승인: 이상 없음(CLEAR) 신청만 한꺼번에 승인한다. 건마다 따로 처리해 한 건이 실패해도 나머지는 계속한다(결과를 건별로 돌려준다).
export async function bulkApprove(db: PrismaClient, admin: AdminSessionContext, rawIds: unknown, meta: Meta = {}) {
  needModerate(admin);
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > BULK_APPROVE_MAX || !rawIds.every((x) => typeof x === "string" && UUID.test(x))) return { ok: false as const, reason: "invalid_input" as const };
  const ids = [...new Set(rawIds as string[])];
  const results: { id: string; ok: boolean; reason?: ApplicationFailure; approvedAt?: Date; undoableUntil?: Date }[] = [];
  for (const id of ids) {
    const s = await db.seller.findUnique({ where: { id }, select: { status: true, reviewReasons: true } });
    if (!s) { results.push({ id, ok: false, reason: "not_found" }); continue; }
    if (s.status !== "PENDING") { results.push({ id, ok: false, reason: "not_pending" }); continue; }
    const rev = await db.sellerApplicationReview.findUnique({ where: { sellerId: id } });
    if (s.reviewReasons.length > 0 || (rev?.supplementRequestedAt && !rev.supplementResolvedAt)) { results.push({ id, ok: false, reason: "needs_review" }); continue; }
    const r = await approveSeller(db, admin, id, meta);
    results.push(r.ok ? { id, ok: true, approvedAt: r.approvedAt, undoableUntil: new Date(r.approvedAt.getTime() + UNDO_WINDOW_MS) } : { id, ok: false, reason: r.reason });
  }
  return { ok: true as const, approved: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

// 승인 되돌리기: 방금(10초 안) 이 관리자가 한 승인을 취소해 승인 대기로 돌린다. 승인할 때 지워진 걸린 항목을 되살리고, 그 사이 만든 파트너스 로그인 세션은 끊는다.
// 자동 승인·다른 관리자의 승인·시간이 지난 승인은 되돌릴 수 없다.
export async function undoApproval(db: PrismaClient, admin: AdminSessionContext, sellerId: string, meta: Meta = {}) {
  needModerate(admin);
  return db.$transaction(async (tx) => {
    const [s] = await tx.$queryRaw<{ status: string; approvedAt: Date | null; approvedByAdminId: string | null }[]>`
      SELECT "status"::text AS status, "approvedAt", "approvedByAdminId" FROM "Seller" WHERE "id" = ${sellerId}::uuid FOR UPDATE`;
    if (!s) return { ok: false as const, reason: "not_found" as const };
    if (s.status !== "ACTIVE" || !s.approvedAt || s.approvedByAdminId !== admin.admin.id) return { ok: false as const, reason: "not_undoable" as const };
    const now = await dbNow(tx);
    if (now.getTime() - s.approvedAt.getTime() > UNDO_WINDOW_MS + UNDO_GRACE_MS) return { ok: false as const, reason: "undo_expired" as const };
    const prev = await tx.auditLog.findFirst({ where: { sellerId, action: "admin.seller.approve", actorId: admin.admin.id }, orderBy: { createdAt: "desc" }, select: { before: true } });
    const reasons = Array.isArray((prev?.before as { reviewReasons?: unknown } | null)?.reviewReasons) ? ((prev!.before as { reviewReasons: string[] }).reviewReasons) : [];
    await tx.seller.update({ where: { id: sellerId }, data: { status: "PENDING", approvedAt: null, approvedByAdminId: null, trialEndsAt: null, reviewReasons: reasons } });
    const revoked = await tx.sellerSession.updateMany({ where: { sellerId, revokedAt: null }, data: { revokedAt: now } });
    await writeAudit(tx, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, sellerId, action: "admin.seller.approve_undo", targetType: "Seller", targetId: sellerId, before: { status: "ACTIVE" }, after: { status: "PENDING", reviewReasons: reasons, sessionsRevoked: revoked.count }, ip: meta.ip, userAgent: meta.userAgent });
    return { ok: true as const };
  });
}

// 정기 작업: 보완 기한이 지난 신청을 자동 반려한다(로그 추적 seller.supplement_expired).
export async function rejectExpiredSupplements(tx: Prisma.TransactionClient, now: Date): Promise<number> {
  const due = await tx.sellerApplicationReview.findMany({ where: { supplementRequestedAt: { not: null }, supplementResolvedAt: null, supplementDueAt: { lte: now } }, select: { sellerId: true } });
  let n = 0;
  for (const { sellerId } of due) {
    const why = `보완 기한(${SUPPLEMENT_DAYS}일) 안에 보완하지 않아 자동 반려했습니다`;
    const moved = await tx.seller.updateMany({ where: { id: sellerId, status: "PENDING" }, data: { status: "REJECTED", rejectedReason: why, rejectedAt: now } });
    await tx.sellerApplicationReview.update({ where: { sellerId }, data: { supplementResolvedAt: now } });
    if (moved.count === 1) {
      await writeAudit(tx, { actorType: "SYSTEM", actorId: null, sellerId, action: "seller.supplement_expired", targetType: "Seller", targetId: sellerId, reason: why });
      n++;
    }
  }
  return n;
}

// 선택 반려: 같은 사유(1~200자)로 한꺼번에 반려한다. 건별 결과(한 건이 실패해도 나머지는 계속). 사유는 신청자에게 그대로 안내되는 문구다.
export async function bulkReject(db: PrismaClient, admin: AdminSessionContext, rawIds: unknown, rawReason: unknown, meta: Meta = {}) {
  needModerate(admin);
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > BULK_APPROVE_MAX || !rawIds.every((x) => typeof x === "string" && UUID.test(x))) return { ok: false as const, reason: "invalid_input" as const };
  const reason = typeof rawReason === "string" ? rawReason.trim() : "";
  if (!reason || reason.length > 200) return { ok: false as const, reason: "reason_required" as const };
  const results: { id: string; ok: boolean; reason?: ApplicationFailure }[] = [];
  for (const id of new Set(rawIds as string[])) {
    const r = await rejectSeller(db, admin, id, reason, meta);
    results.push(r.ok ? { id, ok: true } : { id, ok: false, reason: r.reason === "reason_required" ? "reason_required" : r.reason });
  }
  return { ok: true as const, rejected: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}
