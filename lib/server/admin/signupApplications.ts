import { Prisma, type PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { writeAudit } from "../audit/log";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { dbNow } from "../billing/subscription";
import { approveSeller, rejectSeller } from "../sellers/approval";
import { cleanText } from "../text/clean";

// 마스터 관리자 가입 신청(MA-013, 대표님 결정 2026-10-02 가입 자동 점검).
// - 목록 `listApplications`(platform.read, 모든 마스터 역할): 탭 3개(확인 필요·보완 요청·이력)와 상단 KPI. 새 목록 표는 없고 Seller에서 계산한다.
// - 변경(seller.moderate = 최고관리자·운영): 보완 요청·재촉·선택 승인·선택 반려·승인 되돌리기(10초). 조회 전용·CS는 403.
// - 보완 요청: 승인 대기 신청에 안내 문구를 남긴다. 7일 안에 보완하지 않으면 자동 반려(스케줄 작업 `rejectExpiredSupplements`).
// - 재촉 메일: 지금은 메일 공급자가 연결돼 있지 않아 「발송 기록」만 남긴다(delivery: "RECORDED", 회원 대상 발송과 같은 방식). 하루 1번·최대 3번.
export const APPLICATION_TABS = ["review", "supplement", "history"] as const;
export type ApplicationTab = (typeof APPLICATION_TABS)[number];
export const APPLICATION_PAGE_DEFAULT = 20;
export const APPLICATION_PAGE_MAX = 100;
export const SUPPLEMENT_DAYS = 7;
export const SUPPLEMENT_MESSAGE_MAX = 200;
export const REMINDER_INTERVAL_MS = 24 * 3_600_000;
export const REMINDER_MAX = 3;
export const UNDO_APPROVAL_SECONDS = 10;
export const BULK_MAX = 50;
export const SUPPLEMENT_EXPIRED_REASON = `보완 요청 기한(${SUPPLEMENT_DAYS}일)이 지나 자동 반려했습니다`;
const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESULTS = ["auto", "approved", "rejected"] as const;
type Meta = { ip?: string | null; userAgent?: string | null };

export type ApplicationQuery = { tab?: string | null; sort?: string | null; q?: string | null; result?: string | null; cursor?: string | null; limit?: string | null };

function requireRead(admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
}
function requireModerate(admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "seller.moderate")) throw forbidden();
}
const esc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const kstDay = (now: Date) => {
  const k = new Date(now.getTime() + KST_MS);
  return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()) - KST_MS);
};
const kstMonth = (now: Date) => {
  const k = new Date(now.getTime() + KST_MS);
  return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), 1) - KST_MS);
};

// 상단 KPI. 날짜·달은 KST 기준. 평균 처리 시간(분)은 이번 달에 마스터가 승인했거나 반려한 신청의 「접수 → 처리」 평균(자동 승인 제외, 없으면 null).
export async function applicationKpi(db: PrismaClient, now: Date) {
  const day = kstDay(now);
  const month = kstMonth(now);
  const over48 = new Date(now.getTime() - 48 * 3_600_000);
  const [r] = await db.$queryRaw<Record<string, bigint | number | null>[]>`
    SELECT
      count(*) FILTER (WHERE "status" = 'PENDING' AND "supplementRequestedAt" IS NULL) AS "pendingReview",
      count(*) FILTER (WHERE "status" = 'PENDING' AND "supplementRequestedAt" IS NULL AND "createdAt" < ${over48}) AS "overdue48h",
      count(*) FILTER (WHERE "status" = 'PENDING' AND "supplementRequestedAt" IS NOT NULL) AS "supplementRequested",
      count(*) FILTER (WHERE "createdAt" >= ${day}) AS "receivedToday",
      count(*) FILTER (WHERE "approvedAt" >= ${day} AND "approvedByAdminId" IS NOT NULL) AS "approvedToday",
      count(*) FILTER (WHERE "approvedAt" >= ${day} AND "approvedByAdminId" IS NULL) AS "autoApprovedToday",
      count(*) FILTER (WHERE "approvedAt" >= ${month} AND "approvedByAdminId" IS NULL) AS "autoApprovedMonth",
      count(*) FILTER (WHERE "rejectedAt" >= ${day}) AS "rejectedToday",
      count(*) FILTER (WHERE "rejectedAt" >= ${month}) AS "rejectedMonth",
      avg(extract(epoch FROM (coalesce("rejectedAt", "approvedAt") - "createdAt")) / 60)
        FILTER (WHERE coalesce("rejectedAt", "approvedAt") >= ${month} AND ("rejectedAt" IS NOT NULL OR "approvedByAdminId" IS NOT NULL)) AS "avgMinutes"
    FROM "Seller"`;
  const n = (k: string) => Number(r[k] ?? 0);
  return {
    pendingReview: n("pendingReview"),
    overdue48h: n("overdue48h"),
    supplementRequested: n("supplementRequested"),
    receivedToday: n("receivedToday"),
    approvedToday: n("approvedToday"),
    autoApprovedToday: n("autoApprovedToday"),
    autoApprovedMonth: n("autoApprovedMonth"),
    rejectedToday: n("rejectedToday"),
    rejectedMonth: n("rejectedMonth"),
    avgProcessingMinutes: r.avgMinutes === null ? null : Math.round(Number(r.avgMinutes)),
  };
}

type Row = {
  id: string;
  slug: string;
  shopName: string;
  status: string;
  createdAt: Date;
  approvedAt: Date | null;
  approvedByAdminId: string | null;
  rejectedAt: Date | null;
  rejectedReason: string | null;
  reviewReasons: string[];
  businessCategory: string | null;
  supplementRequestedAt: Date | null;
  supplementMessage: string | null;
  supplementRemindedAt: Date | null;
  supplementReminderCount: number;
  rep: string | null;
  bizNo: string | null;
  company: string | null;
  ownerEmail: string | null;
};

// 신청 목록. tab: review(확인 필요, 기본)·supplement(보완 요청)·history(자동 승인·승인·반려 이력). sort: old(오래된 순, 기본)·new. history는 처리 시각 기준이고 기본이 최근 순.
// q: 쇼핑몰 이름·주소·회사·대표자·사업자번호·이메일. result(history만): auto·approved·rejected. 쪽 이동 cursor는 건너뛸 개수.
// 응답: { now, tab, kpi, counts, items, total, nextCursor }. 대표자 연락처는 이메일만(마스터 열람 허용 범위), 휴대폰은 없다.
export async function listApplications(db: PrismaClient, admin: AdminSessionContext, query: ApplicationQuery) {
  requireRead(admin);
  const tab = query.tab == null || query.tab === "" ? "review" : (APPLICATION_TABS as readonly string[]).includes(query.tab) ? (query.tab as ApplicationTab) : null;
  const sort = query.sort == null || query.sort === "" ? null : query.sort === "old" || query.sort === "new" ? query.sort : undefined;
  const result = query.result == null || query.result === "" ? null : (RESULTS as readonly string[]).includes(query.result) ? query.result : undefined;
  const q = query.q?.trim() ?? "";
  const limit = query.limit == null || query.limit === "" ? APPLICATION_PAGE_DEFAULT : Number(query.limit);
  const offset = query.cursor == null || query.cursor === "" ? 0 : Number(query.cursor);
  if (!tab || sort === undefined || result === undefined || (result && tab !== "history") || q.length > 50) return { ok: false as const };
  if (!Number.isInteger(limit) || limit < 1 || limit > APPLICATION_PAGE_MAX || !Number.isInteger(offset) || offset < 0 || offset > 100_000) return { ok: false as const };

  const now = await dbNow(db);
  const w: Prisma.Sql[] = [];
  if (tab === "review") w.push(Prisma.sql`se."status" = 'PENDING' AND se."supplementRequestedAt" IS NULL`);
  else if (tab === "supplement") w.push(Prisma.sql`se."status" = 'PENDING' AND se."supplementRequestedAt" IS NOT NULL`);
  else {
    w.push(Prisma.sql`(se."approvedAt" IS NOT NULL OR se."rejectedAt" IS NOT NULL)`);
    if (result === "auto") w.push(Prisma.sql`se."approvedAt" IS NOT NULL AND se."approvedByAdminId" IS NULL`);
    if (result === "approved") w.push(Prisma.sql`se."approvedByAdminId" IS NOT NULL`);
    if (result === "rejected") w.push(Prisma.sql`se."rejectedAt" IS NOT NULL`);
  }
  if (q) {
    const like = `%${esc(q)}%`;
    const digits = q.replace(/\D/g, "");
    const parts = [
      Prisma.sql`se."shopName" ILIKE ${like}`,
      Prisma.sql`se."slug" ILIKE ${like}`,
      Prisma.sql`se."businessInfo"->>'companyName' ILIKE ${like}`,
      Prisma.sql`se."businessInfo"->>'representativeName' ILIKE ${like}`,
      Prisma.sql`EXISTS (SELECT 1 FROM "SellerUser" u WHERE u."sellerId" = se."id" AND u."isOwner" AND u."email" ILIKE ${like})`,
    ];
    if (digits.length >= 3) parts.push(Prisma.sql`se."businessInfo"->>'businessNumber' LIKE ${`%${digits}%`}`);
    w.push(Prisma.join(parts, " OR ", "(", ")"));
  }
  const where = Prisma.join(w, " AND ");
  const decided = Prisma.sql`coalesce(se."rejectedAt", se."approvedAt")`;
  const order =
    tab === "history"
      ? sort === "old"
        ? Prisma.sql`${decided} ASC, se."id" ASC`
        : Prisma.sql`${decided} DESC, se."id" DESC`
      : sort === "new"
        ? Prisma.sql`se."createdAt" DESC, se."id" DESC`
        : Prisma.sql`se."createdAt" ASC, se."id" ASC`;

  const [rows, [{ total }], kpi, [{ history }]] = await Promise.all([
    db.$queryRaw<Row[]>`
      SELECT se."id", se."slug", se."shopName", se."status"::text AS status, se."createdAt", se."approvedAt", se."approvedByAdminId", se."rejectedAt", se."rejectedReason",
             se."reviewReasons", se."businessCategory", se."supplementRequestedAt", se."supplementMessage", se."supplementRemindedAt", se."supplementReminderCount",
             se."businessInfo"->>'representativeName' AS rep, se."businessInfo"->>'businessNumber' AS "bizNo", se."businessInfo"->>'companyName' AS company,
             (SELECT u."email" FROM "SellerUser" u WHERE u."sellerId" = se."id" AND u."isOwner" ORDER BY u."createdAt" LIMIT 1) AS "ownerEmail"
      FROM "Seller" se WHERE ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
    db.$queryRaw<{ total: bigint }[]>`SELECT count(*) AS total FROM "Seller" se WHERE ${where}`,
    applicationKpi(db, now),
    db.$queryRaw<{ history: bigint }[]>`SELECT count(*) AS history FROM "Seller" WHERE "approvedAt" IS NOT NULL OR "rejectedAt" IS NOT NULL`,
  ]);
  const items = rows.map((r) => {
    const auto = r.approvedAt !== null && r.approvedByAdminId === null;
    const state = r.status === "PENDING" ? (r.supplementRequestedAt ? "SUPPLEMENT" : "REVIEW") : r.rejectedAt ? "REJECTED" : auto ? "AUTO_APPROVED" : "APPROVED";
    const dueAt = r.supplementRequestedAt ? new Date(r.supplementRequestedAt.getTime() + SUPPLEMENT_DAYS * DAY_MS) : null;
    const undoUntil = state === "APPROVED" && r.status === "ACTIVE" && r.approvedAt && r.approvedByAdminId === admin.admin.id ? new Date(r.approvedAt.getTime() + UNDO_APPROVAL_SECONDS * 1000) : null;
    return {
      id: r.id,
      slug: r.slug,
      shopName: r.shopName,
      state,
      sellerStatus: r.status,
      createdAt: r.createdAt,
      applicant: { name: r.rep, email: r.ownerEmail },
      company: r.company,
      businessNumber: r.bizNo,
      businessCategory: r.businessCategory,
      reviewReasons: r.reviewReasons,
      over48h: state === "REVIEW" && now.getTime() - r.createdAt.getTime() > 48 * 3_600_000,
      supplement: r.supplementRequestedAt
        ? {
            requestedAt: r.supplementRequestedAt,
            message: r.supplementMessage,
            dueAt,
            remindedAt: r.supplementRemindedAt,
            reminderCount: r.supplementReminderCount,
            nextReminderAt: r.status === "PENDING" ? new Date(Math.max(r.supplementRequestedAt.getTime(), r.supplementRemindedAt?.getTime() ?? 0) + REMINDER_INTERVAL_MS) : null,
            canRemind: r.status === "PENDING" && r.supplementReminderCount < REMINDER_MAX,
          }
        : null,
      decidedAt: r.rejectedAt ?? r.approvedAt,
      rejectedReason: r.rejectedAt ? r.rejectedReason : null,
      // 내가 방금 승인했으면 이 시각까지 되돌릴 수 있다(10초)
      undoUntil: undoUntil && undoUntil > now ? undoUntil : null,
    };
  });
  return {
    ok: true as const,
    now,
    tab,
    kpi,
    counts: { review: kpi.pendingReview, supplement: kpi.supplementRequested, history: Number(history) },
    items,
    total: Number(total),
    nextCursor: offset + items.length < Number(total) ? String(offset + items.length) : null,
  };
}

// 보완 요청: 승인 대기 신청에 안내 문구(1~200자)를 남긴다. 이미 요청했으면 409 already_requested.
export async function requestSupplement(db: PrismaClient, admin: AdminSessionContext, sellerId: string, rawMessage: unknown, meta: Meta = {}) {
  requireModerate(admin);
  if (!UUID.test(sellerId)) return { ok: false as const, reason: "not_found" as const };
  const message = cleanText(rawMessage, SUPPLEMENT_MESSAGE_MAX, "memo");
  if (!message) return { ok: false as const, reason: "message_required" as const };
  const now = await dbNow(db);
  const moved = await db.seller.updateMany({
    where: { id: sellerId, status: "PENDING", supplementRequestedAt: null },
    data: { supplementRequestedAt: now, supplementMessage: message, supplementRemindedAt: null, supplementReminderCount: 0 },
  });
  if (moved.count !== 1) return notPending(db, sellerId, "already_requested");
  await writeAudit(db, {
    actorType: "PLATFORM_ADMIN",
    actorId: admin.admin.id,
    sellerId,
    action: "admin.seller.supplement_request",
    targetType: "Seller",
    targetId: sellerId,
    after: { message },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { ok: true as const, requestedAt: now, dueAt: new Date(now.getTime() + SUPPLEMENT_DAYS * DAY_MS) };
}

// 보완 요청 취소(승인 대기 중 요청만). 이력은 로그 추적에 남는다.
export async function cancelSupplement(db: PrismaClient, admin: AdminSessionContext, sellerId: string, meta: Meta = {}) {
  requireModerate(admin);
  if (!UUID.test(sellerId)) return { ok: false as const, reason: "not_found" as const };
  const moved = await db.seller.updateMany({
    where: { id: sellerId, status: "PENDING", supplementRequestedAt: { not: null } },
    data: { supplementRequestedAt: null, supplementMessage: null, supplementRemindedAt: null, supplementReminderCount: 0 },
  });
  if (moved.count !== 1) return notPending(db, sellerId, "not_requested");
  await writeAudit(db, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, sellerId, action: "admin.seller.supplement_cancel", targetType: "Seller", targetId: sellerId, ip: meta.ip, userAgent: meta.userAgent });
  return { ok: true as const };
}

async function notPending(db: PrismaClient, sellerId: string, otherwise: "already_requested" | "not_requested") {
  const s = await db.seller.findUnique({ where: { id: sellerId }, select: { status: true } });
  if (!s) return { ok: false as const, reason: "not_found" as const };
  return { ok: false as const, reason: s.status === "PENDING" ? otherwise : ("not_pending" as const) };
}

// 재촉 메일: 보완 요청 중인 신청만, 마지막 요청·재촉에서 24시간이 지나야 하고 최대 3번. 지금은 기록만 남긴다(delivery: "RECORDED").
export async function remindSupplement(db: PrismaClient, admin: AdminSessionContext, sellerId: string, meta: Meta = {}) {
  requireModerate(admin);
  if (!UUID.test(sellerId)) return { ok: false as const, reason: "not_found" as const };
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ requestedAt: Date | null; remindedAt: Date | null; count: number; status: string }[]>`
      SELECT "supplementRequestedAt" AS "requestedAt", "supplementRemindedAt" AS "remindedAt", "supplementReminderCount" AS count, "status"::text AS status
      FROM "Seller" WHERE "id" = ${sellerId}::uuid FOR UPDATE`;
    const s = rows[0];
    if (!s) return { ok: false as const, reason: "not_found" as const };
    if (s.status !== "PENDING") return { ok: false as const, reason: "not_pending" as const };
    if (!s.requestedAt) return { ok: false as const, reason: "not_requested" as const };
    if (s.count >= REMINDER_MAX) return { ok: false as const, reason: "reminder_limit" as const };
    const now = await dbNow(tx);
    const next = new Date(Math.max(s.requestedAt.getTime(), s.remindedAt?.getTime() ?? 0) + REMINDER_INTERVAL_MS);
    if (next > now) return { ok: false as const, reason: "too_soon" as const, nextReminderAt: next };
    await tx.seller.update({ where: { id: sellerId }, data: { supplementRemindedAt: now, supplementReminderCount: { increment: 1 } } });
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.admin.id,
      sellerId,
      action: "admin.seller.supplement_remind",
      targetType: "Seller",
      targetId: sellerId,
      after: { count: s.count + 1, delivery: "RECORDED" },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, remindedAt: now, reminderCount: s.count + 1, delivery: "RECORDED" as const };
  });
}

// 보완 기한이 지난 신청 자동 반려(스케줄 작업). 처리한 건수를 돌려준다. 처리자는 시스템.
export async function rejectExpiredSupplements(db: PrismaClient, now: Date) {
  const cutoff = new Date(now.getTime() - SUPPLEMENT_DAYS * DAY_MS);
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE "Seller" SET "status" = 'REJECTED', "rejectedReason" = ${SUPPLEMENT_EXPIRED_REASON}, "rejectedAt" = ${now}
    WHERE "status" = 'PENDING' AND "supplementRequestedAt" IS NOT NULL AND "supplementRequestedAt" <= ${cutoff}
    RETURNING "id"`;
  for (const r of rows) {
    await writeAudit(db, { actorType: "SYSTEM", sellerId: r.id, action: "seller.supplement_expired_reject", targetType: "Seller", targetId: r.id, reason: SUPPLEMENT_EXPIRED_REASON });
  }
  return rows.length;
}

type BulkResult = { sellerId: string; ok: boolean; reason?: string };
function bulkIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > BULK_MAX) return null;
  return [...new Set(raw.map((v) => (typeof v === "string" ? v : "")))];
}

// 선택 승인: 한 건이 실패해도 나머지는 처리한다(건별 결과). 「확인 필요」 사유가 남은 신청은 confirmReviewed: true일 때만 승인한다(없으면 needs_review).
export async function bulkApprove(db: PrismaClient, admin: AdminSessionContext, rawIds: unknown, opts: { confirmReviewed?: unknown }, meta: Meta = {}) {
  requireModerate(admin);
  const ids = bulkIds(rawIds);
  if (!ids) return { ok: false as const, reason: "invalid_ids" as const };
  const confirmed = opts.confirmReviewed === true;
  const results: BulkResult[] = [];
  for (const id of ids) {
    if (!UUID.test(id)) {
      results.push({ sellerId: id, ok: false, reason: "not_found" });
      continue;
    }
    if (!confirmed) {
      const s = await db.seller.findUnique({ where: { id }, select: { status: true, reviewReasons: true } });
      if (s?.status === "PENDING" && s.reviewReasons.length > 0) {
        results.push({ sellerId: id, ok: false, reason: "needs_review" });
        continue;
      }
    }
    try {
      const r = await approveSeller(db, admin, id, meta);
      results.push(r.ok ? { sellerId: id, ok: true } : { sellerId: id, ok: false, reason: r.reason });
    } catch (e) {
      console.error("[signup_applications.bulk_approve]", id, e instanceof Error ? e.message : e);
      results.push({ sellerId: id, ok: false, reason: "failed" });
    }
  }
  return { ok: true as const, results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

// 선택 반려: 같은 사유로 한꺼번에(1~200자). 건별 결과.
export async function bulkReject(db: PrismaClient, admin: AdminSessionContext, rawIds: unknown, rawReason: unknown, meta: Meta = {}) {
  requireModerate(admin);
  const ids = bulkIds(rawIds);
  if (!ids) return { ok: false as const, reason: "invalid_ids" as const };
  const reason = cleanText(rawReason, 200, "memo");
  if (!reason) return { ok: false as const, reason: "reason_required" as const };
  const results: BulkResult[] = [];
  for (const id of ids) {
    if (!UUID.test(id)) {
      results.push({ sellerId: id, ok: false, reason: "not_found" });
      continue;
    }
    try {
      const r = await rejectSeller(db, admin, id, reason, meta);
      results.push(r.ok ? { sellerId: id, ok: true } : { sellerId: id, ok: false, reason: r.reason });
    } catch (e) {
      console.error("[signup_applications.bulk_reject]", id, e instanceof Error ? e.message : e);
      results.push({ sellerId: id, ok: false, reason: "failed" });
    }
  }
  return { ok: true as const, results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

// 승인 되돌리기: 내가 승인한 지 10초 안(DB 시계)이고 아직 구독·로그인 등 이용 기록이 없을 때만 승인 대기(「확인 필요」 사유 복원)로 되돌린다.
// 사유는 승인 때 로그 추적에 남긴 값(before.reviewReasons). 시간이 지났거나 남이 한 승인이면 409 not_undoable.
export async function undoApproval(db: PrismaClient, admin: AdminSessionContext, sellerId: string, meta: Meta = {}) {
  requireModerate(admin);
  if (!UUID.test(sellerId)) return { ok: false as const, reason: "not_found" as const };
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ status: string; approvedAt: Date | null; approvedByAdminId: string | null }[]>`
      SELECT "status"::text AS status, "approvedAt", "approvedByAdminId" FROM "Seller" WHERE "id" = ${sellerId}::uuid FOR UPDATE`;
    const s = locked[0];
    if (!s) return { ok: false as const, reason: "not_found" as const };
    const now = await dbNow(tx);
    const withinWindow = !!s.approvedAt && now.getTime() - s.approvedAt.getTime() <= UNDO_APPROVAL_SECONDS * 1000;
    if (s.status !== "ACTIVE" || s.approvedByAdminId !== admin.admin.id || !withinWindow) return { ok: false as const, reason: "not_undoable" as const };
    const used = await tx.sellerSubscription.findUnique({ where: { sellerId }, select: { id: true } });
    if (used) return { ok: false as const, reason: "not_undoable" as const };
    const last = await tx.auditLog.findFirst({ where: { action: "admin.seller.approve", targetType: "Seller", targetId: sellerId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { before: true } });
    const before = last?.before as { reviewReasons?: unknown } | null;
    const reasons = Array.isArray(before?.reviewReasons) ? (before.reviewReasons as unknown[]).filter((v): v is string => typeof v === "string") : [];
    await tx.seller.update({ where: { id: sellerId }, data: { status: "PENDING", approvedAt: null, approvedByAdminId: null, trialEndsAt: null, reviewReasons: reasons } });
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.admin.id,
      sellerId,
      action: "admin.seller.approve_undo",
      targetType: "Seller",
      targetId: sellerId,
      after: { status: "PENDING", reviewReasons: reasons },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, reviewReasons: reasons };
  });
}
