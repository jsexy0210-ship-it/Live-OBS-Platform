import type { PlatformInquiryCategory, PlatformInquiryStatus, Prisma, PrismaClient } from "@prisma/client";
import { createAdminAlert } from "../admin-alerts/service";
import { collectInquiryDiagnostics } from "./diagnostics";
import { ATTACHMENTS_PER_MESSAGE, ATTACHMENTS_TOTAL_MAX_BYTES, checkInquiryFile } from "./files";
import { writeAudit } from "../audit/log";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { orderNoLabel } from "../orders/orderNoLabel";
import { checkReviewImage, type ReviewImageRejection } from "../product-reviews/image";
import type { TenantContext } from "../tenant/context";
import { cleanText } from "../text/clean";

// 플랫폼 문의(파트너스 → 플랫폼). 파트너스 SA-113 목록 · SA-114 작성 · SA-115 상세·추가 문의 / 마스터 MA-051 목록 · MA-052 상세·답변. 규칙:
// - 파트너스: 계정 누구나(직원 포함) 쓰고, 구독이 잠기거나 이용 정지 중에도 쓴다(그때 더 필요함). 대표자는 쇼핑몰 문의 전부, 직원은 자기가 쓴 문의만 본다.
//   하루(24시간) 쇼핑몰당 새 문의 20건까지. 첨부는 사진만(JPG·PNG·WEBP 5MB, 리뷰 사진과 같은 검사·위치 정보 제거), 글 하나에 5장.
// - 마스터: 보기는 모든 역할(platform.read), 답변·종료는 최고관리자·CS(support.manage, ARCHITECTURE 3.2 「고객 문의」).
//   답변·종료는 expectedVersion을 받는다. 그 사이 파트너스 추가 문의가 달렸으면 409 version_conflict(지금 version)로 다시 보게 한다.
// - 상태: 새 문의·추가 문의 → OPEN(답변 대기), 마스터 답변 → ANSWERED(답변 완료), 마스터 종료 → CLOSED(더 쓸 수 없음, 새 문의로).
// - 파트너스 화면에는 마스터 관리자 이름·id를 보이지 않는다(「플랫폼」 답변). 마스터 화면에는 답변한 관리자 이름이 보인다.
// - 알림 발송(메일·알림톡)은 하지 않는다. 파트너스 목록의 hasNewReply(마지막으로 연 뒤 달린 답변)로 표시하고, 알림 센터 연결은 후속(5번).

type Db = PrismaClient | Prisma.TransactionClient;
export type AuditMeta = { ip?: string | null; userAgent?: string | null };

export const TITLE_MAX = 80;
export const BODY_MAX = 5_000;
export const IMAGES_PER_MESSAGE = 5;
export const UNATTACHED_KEEP = 10;
export const DAILY_LIMIT = 20;
export const SELLER_PAGE_SIZE = 20;
export const ADMIN_PAGE_SIZE = 50;
// SA-114 문의 종류(방송 화면·결제 연결·주문/환불·적립금·구독/요금·쇼핑몰·계정/직원·기타). BILLING·FEATURE·BUG는 예전 문의에만 남아 있어 새로 보낼 수 없고 필터로는 볼 수 있다.
export const CATEGORIES: readonly PlatformInquiryCategory[] = ["BROADCAST", "PAYMENT_LINK", "ORDER_REFUND", "REWARD", "SUBSCRIPTION_FEE", "SHOP", "ACCOUNT", "OTHER"];
const FILTER_CATEGORIES: readonly PlatformInquiryCategory[] = [...CATEGORIES, "BILLING", "FEATURE", "BUG"];
const STATUSES: readonly PlatformInquiryStatus[] = ["OPEN", "ANSWERED", "CLOSED"];

export type PlatformInquiryRejection =
  | "invalid_category"
  | "invalid_title"
  | "invalid_body"
  | "invalid_images"
  | "invalid_files"
  | "unsupported_file"
  | "invalid_notice"
  | "invalid_status"
  | "invalid_related"
  | "invalid_urgent"
  | "invalid_assignee"
  | "invalid_diagnostics"
  | "invalid_helpful"
  | "already_rated"
  | "no_reply_yet"
  | "invalid_cursor"
  | "too_many_inquiries"
  | "inquiry_closed"
  | "version_conflict"
  | ReviewImageRejection;

// 파트너스 관리자·마스터 관리자 화면 문구(합니다체)
export const PLATFORM_INQUIRY_MESSAGES: Record<PlatformInquiryRejection, string> = {
  invalid_category: "문의 유형을 선택해 주십시오",
  invalid_title: `제목을 ${TITLE_MAX}자 안에서 입력해 주십시오`,
  invalid_body: `내용을 ${BODY_MAX}자 안에서 입력해 주십시오`,
  invalid_images: `사진을 다시 올려 주십시오(${IMAGES_PER_MESSAGE}장까지)`,
  invalid_files: `첨부를 다시 확인해 주십시오(사진·파일 합쳐 ${ATTACHMENTS_PER_MESSAGE}개, 20MB까지)`,
  unsupported_file: "txt·log·zip 파일만 올릴 수 있습니다(사진은 사진으로 올려 주십시오)",
  invalid_notice: "공지를 찾을 수 없습니다",
  invalid_status: "상태를 다시 선택해 주십시오",
  invalid_related: "관련 주문·방송을 다시 선택해 주십시오",
  invalid_urgent: "긴급 여부를 다시 선택해 주십시오",
  invalid_assignee: "담당자를 다시 선택해 주십시오",
  invalid_diagnostics: "진단 정보 첨부 여부를 다시 선택해 주십시오",
  invalid_helpful: "도움이 됐는지 선택해 주십시오",
  already_rated: "이미 평가하셨습니다",
  no_reply_yet: "답변이 오면 평가할 수 있습니다",
  invalid_cursor: "목록을 다시 불러와 주십시오",
  too_many_inquiries: `문의는 하루 ${DAILY_LIMIT}건까지 보낼 수 있습니다. 보낸 문의에 이어서 적어 주십시오`,
  inquiry_closed: "종료된 문의입니다. 새 문의로 보내 주십시오",
  version_conflict: "새 글이 달렸습니다. 새로고침한 뒤 다시 확인해 주십시오",
  empty_file: "사진을 확인해 주십시오",
  file_too_large: "사진은 5MB 이하로 올려 주십시오",
  unsupported_image: "JPG, PNG, WEBP 사진만 올릴 수 있습니다",
  wrong_image_size: "사진 크기가 맞지 않습니다",
  png_16bit: "사진을 다른 형식으로 올려 주십시오",
  png_too_large: "사진 크기가 너무 큽니다",
};

export function inquiryStatus(reason: PlatformInquiryRejection): number {
  if (reason === "too_many_inquiries") return 429;
  if (reason === "inquiry_closed" || reason === "version_conflict" || reason === "already_rated" || reason === "no_reply_yet") return 409;
  if (reason === "file_too_large") return 413;
  if (reason === "unsupported_file") return 415;
  return 400;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const obj = (raw: unknown) => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});

function parseCursor(cursor: string | null | undefined): { ok: true; where: Prisma.PlatformInquiryWhereInput } | { ok: false } {
  if (!cursor) return { ok: true, where: {} };
  const i = cursor.lastIndexOf("_");
  const at = new Date(cursor.slice(0, i));
  const id = cursor.slice(i + 1);
  if (i <= 0 || Number.isNaN(at.getTime()) || !isUuid(id)) return { ok: false };
  return { ok: true, where: { OR: [{ lastMessageAt: { lt: at } }, { lastMessageAt: at, id: { lt: id } }] } };
}
const nextCursor = <T extends { id: string; lastMessageAt: Date }>(rows: T[], size: number) =>
  rows.length > size ? `${rows[size - 1].lastMessageAt.toISOString()}_${rows[size - 1].id}` : null;

function parseImageIds(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > IMAGES_PER_MESSAGE || !v.every(isUuid) || new Set(v).size !== v.length) return null;
  return v as string[];
}

function parseFileIds(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > ATTACHMENTS_PER_MESSAGE || !v.every(isUuid) || new Set(v).size !== v.length) return null;
  return v as string[];
}

// 파트너스가 볼 수 있는 문의: 대표자는 쇼핑몰 전부, 직원은 자기가 쓴 것만
const sellerWhere = (ctx: TenantContext): Prisma.PlatformInquiryWhereInput => ({ sellerId: ctx.sellerId, ...(ctx.isOwner ? {} : { createdBySellerUserId: ctx.actorId }) });
const requireSellerWrite = (ctx: TenantContext) => {
  if (ctx.readOnly) throw forbidden();
};
const requireRead = (admin: AdminSessionContext) => {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
};
const requireReply = (admin: AdminSessionContext) => {
  if (!adminCan(admin.admin.role, "support.manage")) throw forbidden();
};

function sellerAudit(db: Db, ctx: TenantContext, meta: AuditMeta, action: string, inquiryId: string, after: unknown) {
  return writeAudit(db, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action, targetType: "PlatformInquiry", targetId: inquiryId, after, ip: meta.ip, userAgent: meta.userAgent });
}
function adminAudit(db: Db, admin: AdminSessionContext, meta: AuditMeta, action: string, r: { id: string; sellerId: string }, before: unknown, after: unknown) {
  return writeAudit(db, {
    actorType: "PLATFORM_ADMIN",
    actorId: admin.admin.id,
    sellerId: r.sellerId,
    action,
    targetType: "PlatformInquiry",
    targetId: r.id,
    before,
    after,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
}

const MESSAGE_SELECT = {
  id: true,
  authorType: true,
  sellerUserId: true,
  adminId: true,
  body: true,
  createdAt: true,
  images: { select: { id: true, width: true, height: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
  files: { select: { id: true, name: true, byteSize: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
} as const satisfies Prisma.PlatformInquiryMessageSelect;
type MessageRow = Prisma.PlatformInquiryMessageGetPayload<{ select: typeof MESSAGE_SELECT }>;

async function names(db: Db, sellerUserIds: (string | null)[], adminIds: (string | null)[]) {
  const su = [...new Set(sellerUserIds.filter((v): v is string => !!v))];
  const ad = [...new Set(adminIds.filter((v): v is string => !!v))];
  const [users, admins] = await Promise.all([
    su.length ? db.sellerUser.findMany({ where: { id: { in: su } }, select: { id: true, name: true } }) : [],
    ad.length ? db.platformAdmin.findMany({ where: { id: { in: ad } }, select: { id: true, name: true } }) : [],
  ]);
  return { user: new Map(users.map((u) => [u.id, u.name])), admin: new Map(admins.map((a) => [a.id, a.name])) };
}

async function noticeTitle(db: Db, noticeId: string | null) {
  if (!noticeId) return null;
  const n = await db.platformNotice.findUnique({ where: { id: noticeId }, select: { id: true, title: true } });
  return n ? { id: n.id, title: n.title } : null;
}

// 글을 보낼 때 붙일 사진: 이 계정이 올렸고 아직 어디에도 붙지 않은 사진만
async function attachImages(tx: Prisma.TransactionClient, ctx: TenantContext, messageId: string, imageIds: string[]) {
  if (imageIds.length === 0) return true;
  const found = await tx.platformInquiryImage.findMany({ where: { id: { in: imageIds }, sellerId: ctx.sellerId, sellerUserId: ctx.actorId, messageId: null }, select: { id: true } });
  if (found.length !== imageIds.length) return false;
  for (const [index, id] of imageIds.entries()) await tx.platformInquiryImage.update({ where: { id }, data: { messageId, sortOrder: index } });
  return true;
}

// 첨부 파일 붙이기: 사진과 합쳐 글당 5개·합계 20MB. 내가 올린 붙지 않은 파일만, 한 번 붙으면 그 글 것이다.
async function attachFiles(tx: Prisma.TransactionClient, ctx: TenantContext, messageId: string, fileIds: string[], imageIds: string[]) {
  if (fileIds.length === 0) return true;
  if (fileIds.length + imageIds.length > ATTACHMENTS_PER_MESSAGE) return false;
  const files = await tx.platformInquiryFile.findMany({ where: { id: { in: fileIds }, sellerId: ctx.sellerId, sellerUserId: ctx.actorId, messageId: null }, select: { id: true, byteSize: true } });
  if (files.length !== fileIds.length) return false;
  const images = imageIds.length ? await tx.platformInquiryImage.findMany({ where: { id: { in: imageIds }, sellerId: ctx.sellerId }, select: { byteSize: true } }) : [];
  const total = files.reduce((n, f) => n + f.byteSize, 0) + images.reduce((n, i) => n + i.byteSize, 0);
  if (total > ATTACHMENTS_TOTAL_MAX_BYTES) return false;
  for (const [index, id] of fileIds.entries()) await tx.platformInquiryFile.update({ where: { id }, data: { messageId, sortOrder: index } });
  return true;
}

class Rejected extends Error {
  constructor(readonly reason: PlatformInquiryRejection) {
    super(reason);
  }
}

// ─── 파트너스 ───

const sellerMessage = (m: MessageRow, n: Awaited<ReturnType<typeof names>>) => ({
  id: m.id,
  author: m.authorType === "ADMIN" ? ("PLATFORM" as const) : ("PARTNER" as const),
  authorName: m.authorType === "ADMIN" ? null : (n.user.get(m.sellerUserId ?? "") ?? null),
  body: m.body,
  createdAt: m.createdAt,
  images: m.images.map((i) => ({ ...i, url: `/api/seller/platform-inquiries/images/${i.id}` })),
  files: m.files.map((f) => ({ ...f, url: `/api/seller/platform-inquiries/files/${f.id}` })),
});

// SA-113: 내 문의 목록. 마지막 글 최신 순 20건. hasNewReply = 마지막으로 연 뒤 플랫폼 답변이 달림.
// 쿼리: cursor · status(OPEN|ANSWERED|CLOSED) · category. counts는 상태·분류 조건과 무관한 내가 볼 수 있는 문의 전체의 상태별 건수(탭 숫자), newReplyCount는 새 답변이 달린 문의 수.
export async function listMyInquiries(db: PrismaClient, ctx: TenantContext, q: { cursor?: string | null; status?: string | null; category?: string | null }) {
  const c = parseCursor(q.cursor);
  if (!c.ok) return { ok: false as const, reason: "invalid_cursor" as const };
  if (q.status && !STATUSES.includes(q.status as PlatformInquiryStatus)) return { ok: false as const, reason: "invalid_status" as const };
  if (q.category && !FILTER_CATEGORIES.includes(q.category as PlatformInquiryCategory)) return { ok: false as const, reason: "invalid_category" as const };
  const mine = sellerWhere(ctx);
  const rows = await db.platformInquiry.findMany({
    where: { ...mine, ...(q.status ? { status: q.status as PlatformInquiryStatus } : {}), ...(q.category ? { category: q.category as PlatformInquiryCategory } : {}), ...c.where },
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    take: SELLER_PAGE_SIZE + 1,
    select: { id: true, category: true, title: true, status: true, urgent: true, assignedAdminId: true, createdAt: true, lastMessageAt: true, lastAdminMessageAt: true, sellerReadAt: true, createdBySellerUserId: true },
  });
  const page = rows.slice(0, SELLER_PAGE_SIZE);
  const n = await names(db, page.map((r) => r.createdBySellerUserId), []);
  const grouped = await db.platformInquiry.groupBy({ by: ["status"], where: mine, _count: { _all: true } });
  const count = (s: PlatformInquiryStatus) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  const [newReplyCount] = await db.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS "n" FROM "PlatformInquiry"
    WHERE "sellerId" = ${ctx.sellerId}::uuid AND (${ctx.isOwner} OR "createdBySellerUserId" = ${ctx.actorId}::uuid)
      AND "lastAdminMessageAt" IS NOT NULL AND ("sellerReadAt" IS NULL OR "lastAdminMessageAt" > "sellerReadAt")`;
  return {
    ok: true as const,
    items: page.map(({ lastAdminMessageAt, sellerReadAt, createdBySellerUserId, assignedAdminId, ...r }) => ({
      ...r,
      authorName: n.user.get(createdBySellerUserId) ?? null,
      lastReplyAt: lastAdminMessageAt,
      handlerState: handlerStateOf(r.status, assignedAdminId),
      hasNewReply: !!lastAdminMessageAt && (!sellerReadAt || lastAdminMessageAt > sellerReadAt),
    })),
    counts: { all: count("OPEN") + count("ANSWERED") + count("CLOSED"), open: count("OPEN"), answered: count("ANSWERED"), closed: count("CLOSED") },
    newReplyCount: newReplyCount?.n ?? 0,
    avgFirstReplyMinutes: await avgFirstReplyMinutes(db),
    nextCursor: nextCursor(rows, SELLER_PAGE_SIZE),
  };
}

// 담당 상태(파트너스 화면용, 마스터 관리자 이름·id는 내보내지 않는다): 담당이 정해졌으면 ASSIGNED(담당자 배정됨), 아니면 PREPARING(답변 준비 중), 종료면 null.
function handlerStateOf(status: PlatformInquiryStatus, assignedAdminId: string | null) {
  if (status === "CLOSED") return null;
  return assignedAdminId ? ("ASSIGNED" as const) : ("PREPARING" as const);
}

// 최근 30일에 접수된 문의의 첫 플랫폼 답변까지 걸린 평균 분(전체 파트너스 기준 안내 문구용). 답변 받은 문의가 없으면 null.
async function avgFirstReplyMinutes(db: Db) {
  const [r] = await db.$queryRaw<{ m: number | null }[]>`
    SELECT ROUND(AVG(EXTRACT(EPOCH FROM (f."at" - i."createdAt")) / 60))::int AS "m"
    FROM "PlatformInquiry" i
    JOIN LATERAL (SELECT MIN(m."createdAt") AS "at" FROM "PlatformInquiryMessage" m WHERE m."inquiryId" = i."id" AND m."authorType" = 'ADMIN') f ON f."at" IS NOT NULL
    WHERE i."createdAt" > now() - interval '30 days'`;
  return r?.m ?? null;
}

// 관련 주문·방송(작성 때 고른 것). 같은 쇼핑몰 것만 찾는다. 없으면 null.
async function relatedOf(db: Db, sellerId: string, orderId: string | null, broadcastId: string | null) {
  const [o, b] = await Promise.all([
    orderId ? db.order.findFirst({ where: { id: orderId, sellerId, legalHoldAt: null }, select: { id: true, orderNo: true, createdAt: true, broadcastNicknameSnapshot: true } }) : null,
    broadcastId ? db.broadcastSession.findFirst({ where: { id: broadcastId, sellerId }, select: { id: true, title: true, startedAt: true } }) : null,
  ]);
  return {
    order: o ? { id: o.id, orderNoLabel: orderNoLabel(o.createdAt, o.orderNo), nickname: o.broadcastNicknameSnapshot, createdAt: o.createdAt } : null,
    broadcast: b ? { id: b.id, title: b.title, startedAt: b.startedAt } : null,
  };
}

export type InquiryHistoryType = "RECEIVED" | "ANSWERED" | "FOLLOWUP" | "CLOSED";
// 처리 이력(최신순): 접수 · 플랫폼 답변 · 추가 문의 · 종료. 마스터 관리자 이름·담당 배정은 보이지 않는다(actor는 PARTNER|PLATFORM만).
function historyOf(messages: { authorType: string; createdAt: Date }[], closedAt: Date | null, closedBy: "PARTNER" | "PLATFORM" | null) {
  const ev: { type: InquiryHistoryType; at: Date; actor: "PARTNER" | "PLATFORM" }[] = messages.map((m, i) => ({
    type: i === 0 ? ("RECEIVED" as const) : m.authorType === "ADMIN" ? ("ANSWERED" as const) : ("FOLLOWUP" as const),
    at: m.createdAt,
    actor: m.authorType === "ADMIN" ? ("PLATFORM" as const) : ("PARTNER" as const),
  }));
  if (closedAt) ev.push({ type: "CLOSED", at: closedAt, actor: closedBy ?? "PLATFORM" });
  return ev.map((e, i) => ({ e, i })).sort((a, b) => b.e.at.getTime() - a.e.at.getTime() || b.i - a.i).map(({ e }) => e);
}

// SA-115: 문의 상세. 보면 읽음(sellerReadAt)으로 남긴다(마스터 대리 조회는 남기지 않음). 볼 수 없으면 null(404).
// 응답에 related(관련 주문·방송), helpful(true|false|null), history(처리 이력, 최신순), canClose·canRate가 있다.
export async function getMyInquiry(db: PrismaClient, ctx: TenantContext, id: string) {
  if (!isUuid(id)) return null;
  const row = await db.platformInquiry.findFirst({
    where: { ...sellerWhere(ctx), id },
    select: {
      id: true, category: true, title: true, status: true, urgent: true, noticeId: true, createdAt: true, lastMessageAt: true, closedAt: true, createdBySellerUserId: true,
      closedBySellerUserId: true, closedByAdminId: true, relatedOrderId: true, relatedBroadcastId: true, helpful: true, helpfulAt: true, lastAdminMessageAt: true, assignedAdminId: true,
      messages: { select: MESSAGE_SELECT, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    },
  });
  if (!row) return null;
  if (!ctx.readOnly) await db.platformInquiry.update({ where: { id }, data: { sellerReadAt: new Date() } });
  const n = await names(db, [row.createdBySellerUserId, ...row.messages.map((m) => m.sellerUserId)], []);
  const { messages, noticeId, createdBySellerUserId, closedBySellerUserId, closedByAdminId, relatedOrderId, relatedBroadcastId, lastAdminMessageAt, assignedAdminId, ...rest } = row;
  const closedBy = row.closedAt ? (closedBySellerUserId ? ("PARTNER" as const) : closedByAdminId ? ("PLATFORM" as const) : null) : null;
  return {
    ...rest,
    authorName: n.user.get(createdBySellerUserId) ?? null,
    notice: await noticeTitle(db, noticeId),
    related: await relatedOf(db, ctx.sellerId, relatedOrderId, relatedBroadcastId),
    closedBy,
    handlerState: handlerStateOf(row.status, assignedAdminId),
    history: historyOf(messages, row.closedAt, closedBy),
    canClose: row.status !== "CLOSED" && !ctx.readOnly,
    canRate: !!lastAdminMessageAt && row.helpful === null && !ctx.readOnly,
    messages: messages.map((m) => sellerMessage(m, n)),
  };
}

// SA-114: 문의 보내기. 본문 { category, title, body, imageIds?, noticeId?, relatedOrderId?, relatedBroadcastId? }(관련 주문·방송은 같은 쇼핑몰 것만, 아니면 400 invalid_related).
export async function createInquiry(db: PrismaClient, ctx: TenantContext, raw: unknown, meta: AuditMeta = {}) {
  requireSellerWrite(ctx);
  const b = obj(raw);
  if (!CATEGORIES.includes(b.category as PlatformInquiryCategory)) return { ok: false as const, reason: "invalid_category" as const };
  if (b.urgent !== undefined && typeof b.urgent !== "boolean") return { ok: false as const, reason: "invalid_urgent" as const };
  const urgent = b.urgent === true;
  if (b.includeDiagnostics !== undefined && typeof b.includeDiagnostics !== "boolean") return { ok: false as const, reason: "invalid_diagnostics" as const };
  const title = cleanText(b.title, TITLE_MAX, "memo");
  if (!title) return { ok: false as const, reason: "invalid_title" as const };
  const body = cleanText(b.body, BODY_MAX, "multiline");
  if (!body) return { ok: false as const, reason: "invalid_body" as const };
  const imageIds = parseImageIds(b.imageIds);
  if (!imageIds) return { ok: false as const, reason: "invalid_images" as const };
  const fileIds = parseFileIds(b.fileIds);
  if (!fileIds || fileIds.length + imageIds.length > ATTACHMENTS_PER_MESSAGE) return { ok: false as const, reason: "invalid_files" as const };
  const relatedOrderId = b.relatedOrderId === undefined || b.relatedOrderId === null ? null : b.relatedOrderId;
  const relatedBroadcastId = b.relatedBroadcastId === undefined || b.relatedBroadcastId === null ? null : b.relatedBroadcastId;
  if ((relatedOrderId !== null && !isUuid(relatedOrderId)) || (relatedBroadcastId !== null && !isUuid(relatedBroadcastId))) return { ok: false as const, reason: "invalid_related" as const };
  if (relatedOrderId || relatedBroadcastId) {
    const r = await relatedOf(db, ctx.sellerId, relatedOrderId, relatedBroadcastId);
    if ((relatedOrderId && !r.order) || (relatedBroadcastId && !r.broadcast)) return { ok: false as const, reason: "invalid_related" as const };
  }
  let noticeId: string | null = null;
  if (b.noticeId !== undefined && b.noticeId !== null) {
    if (!isUuid(b.noticeId)) return { ok: false as const, reason: "invalid_notice" as const };
    const n = await db.platformNotice.findFirst({ where: { id: b.noticeId, publishedAt: { not: null }, deletedAt: null, audience: { in: ["PARTNERS", "ALL"] } }, select: { id: true } });
    if (!n) return { ok: false as const, reason: "invalid_notice" as const };
    noticeId = n.id;
  }
  // 진단 정보는 보낼 때 한 번 모아 붙인다(includeDiagnostics가 false면 붙이지 않는다)
  const diagnostics = b.includeDiagnostics === false ? null : await collectInquiryDiagnostics(db, ctx.sellerId, meta.userAgent);
  try {
    const id = await db.$transaction(async (tx) => {
      // 쇼핑몰마다 줄을 세워 하루 한도를 정확히 센다(동시에 보내도 20건을 넘지 않음)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('platform_inquiry'), hashtext(${ctx.sellerId}))`;
      const recent = await tx.platformInquiry.count({ where: { sellerId: ctx.sellerId, createdAt: { gt: new Date(Date.now() - 24 * 3600_000) } } });
      if (recent >= DAILY_LIMIT) throw new Rejected("too_many_inquiries");
      const now = new Date();
      const inq = await tx.platformInquiry.create({
        data: { sellerId: ctx.sellerId, createdBySellerUserId: ctx.actorId, category: b.category as PlatformInquiryCategory, title, urgent, noticeId, relatedOrderId, relatedBroadcastId, ...(diagnostics ? { diagnostics } : {}), lastMessageAt: now, sellerReadAt: now, createdAt: now },
        select: { id: true },
      });
      const msg = await tx.platformInquiryMessage.create({ data: { sellerId: ctx.sellerId, inquiryId: inq.id, authorType: "SELLER_USER", sellerUserId: ctx.actorId, body, createdAt: now }, select: { id: true } });
      if (!(await attachImages(tx, ctx, msg.id, imageIds))) throw new Rejected("invalid_images");
      if (!(await attachFiles(tx, ctx, msg.id, fileIds, imageIds))) throw new Rejected("invalid_files");
      await sellerAudit(tx, ctx, meta, "platform_inquiry.create", inq.id, { category: b.category, title, urgent, noticeId, relatedOrderId, relatedBroadcastId, diagnostics: diagnostics !== null, images: imageIds.length, files: fileIds.length });
      // 긴급 문의는 마스터 관리자 알림 센터로 바로 알린다(화면 안 알림만, 외부 발송 없음)
      if (urgent) {
        await createAdminAlert(tx, {
          kind: "INQUIRY_URGENT",
          severity: "URGENT",
          title: `[긴급] ${title}`,
          body: body.slice(0, 200),
          linkPath: `/admin/support/inquiries/${inq.id}`,
          sellerId: ctx.sellerId,
          targetRoles: ["SUPER_ADMIN", "OPERATIONS", "CS"],
          dedupeKey: `inquiry-urgent:${inq.id}`,
          occurredAt: now,
        });
      }
      return inq.id;
    });
    return { ok: true as const, inquiry: (await getMyInquiry(db, ctx, id))! };
  } catch (e) {
    if (e instanceof Rejected) return { ok: false as const, reason: e.reason };
    throw e;
  }
}

// SA-114 임시 저장: 계정(직원 포함)당 하나. 값은 임시라 느슨하게 받고(비어 있어도 됨) 보낼 때 createInquiry가 다시 검사한다.
// 모두 비어 있으면 임시 저장을 지운다. 마스터 대리 조회(readOnly)는 보지도 쓰지도 않는다.
const draftView = (d: { category: PlatformInquiryCategory | null; title: string; body: string; urgent: boolean; relatedOrderId: string | null; relatedBroadcastId: string | null; includeDiagnostics: boolean; updatedAt: Date }) => ({
  category: d.category,
  title: d.title,
  body: d.body,
  urgent: d.urgent,
  relatedOrderId: d.relatedOrderId,
  relatedBroadcastId: d.relatedBroadcastId,
  includeDiagnostics: d.includeDiagnostics,
  updatedAt: d.updatedAt,
});

export async function getMyDraft(db: PrismaClient, ctx: TenantContext) {
  if (ctx.readOnly) return null;
  const d = await db.platformInquiryDraft.findFirst({ where: { sellerUserId: ctx.actorId, sellerId: ctx.sellerId } });
  return d ? draftView(d) : null;
}

// 본문 { category?, title?, body?, urgent?, relatedOrderId?, relatedBroadcastId?, includeDiagnostics? }. 항목을 빼거나 null·""이면 비운다(전체 교체).
export async function saveMyDraft(db: PrismaClient, ctx: TenantContext, raw: unknown) {
  requireSellerWrite(ctx);
  const b = obj(raw);
  const blank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
  if (!blank(b.category) && !CATEGORIES.includes(b.category as PlatformInquiryCategory)) return { ok: false as const, reason: "invalid_category" as const };
  if (b.urgent !== undefined && typeof b.urgent !== "boolean") return { ok: false as const, reason: "invalid_urgent" as const };
  if (b.includeDiagnostics !== undefined && typeof b.includeDiagnostics !== "boolean") return { ok: false as const, reason: "invalid_diagnostics" as const };
  const title = blank(b.title) ? "" : cleanText(b.title, TITLE_MAX, "memo");
  if (title === null) return { ok: false as const, reason: "invalid_title" as const };
  const body = blank(b.body) ? "" : cleanText(b.body, BODY_MAX, "multiline");
  if (body === null) return { ok: false as const, reason: "invalid_body" as const };
  const relatedOrderId = blank(b.relatedOrderId) ? null : b.relatedOrderId;
  const relatedBroadcastId = blank(b.relatedBroadcastId) ? null : b.relatedBroadcastId;
  if ((relatedOrderId !== null && !isUuid(relatedOrderId)) || (relatedBroadcastId !== null && !isUuid(relatedBroadcastId))) return { ok: false as const, reason: "invalid_related" as const };
  const category = blank(b.category) ? null : (b.category as PlatformInquiryCategory);
  const urgent = b.urgent === true;
  const includeDiagnostics = b.includeDiagnostics !== false;
  if (!category && !title && !body && !urgent && !relatedOrderId && !relatedBroadcastId) {
    await db.platformInquiryDraft.deleteMany({ where: { sellerUserId: ctx.actorId } });
    return { ok: true as const, draft: null };
  }
  const data = { sellerId: ctx.sellerId, category, title, body, urgent, relatedOrderId, relatedBroadcastId, includeDiagnostics, updatedAt: new Date() };
  const d = await db.platformInquiryDraft.upsert({ where: { sellerUserId: ctx.actorId }, create: { sellerUserId: ctx.actorId, ...data }, update: data });
  return { ok: true as const, draft: draftView(d) };
}

export async function deleteMyDraft(db: PrismaClient, ctx: TenantContext) {
  requireSellerWrite(ctx);
  await db.platformInquiryDraft.deleteMany({ where: { sellerUserId: ctx.actorId } });
}

// SA-115: 추가 문의. 본문 { body, imageIds? }. 종료된 문의는 409 inquiry_closed. 답변 대기로 돌아간다.
export async function addSellerMessage(db: PrismaClient, ctx: TenantContext, id: string, raw: unknown, meta: AuditMeta = {}) {
  requireSellerWrite(ctx);
  if (!isUuid(id)) return null;
  const b = obj(raw);
  const body = cleanText(b.body, BODY_MAX, "multiline");
  const imageIds = parseImageIds(b.imageIds);
  const fileIds = parseFileIds(b.fileIds);
  try {
    const ok = await db.$transaction(async (tx) => {
      const [cur] = await tx.$queryRaw<{ id: string; status: PlatformInquiryStatus }[]>`
        SELECT "id", "status" FROM "PlatformInquiry"
        WHERE "id" = ${id}::uuid AND "sellerId" = ${ctx.sellerId}::uuid AND (${ctx.isOwner} OR "createdBySellerUserId" = ${ctx.actorId}::uuid)
        FOR UPDATE`;
      if (!cur) return false;
      if (!body) throw new Rejected("invalid_body");
      if (!imageIds) throw new Rejected("invalid_images");
      if (!fileIds || fileIds.length + imageIds.length > ATTACHMENTS_PER_MESSAGE) throw new Rejected("invalid_files");
      if (cur.status === "CLOSED") throw new Rejected("inquiry_closed");
      const now = new Date();
      const msg = await tx.platformInquiryMessage.create({ data: { sellerId: ctx.sellerId, inquiryId: id, authorType: "SELLER_USER", sellerUserId: ctx.actorId, body, createdAt: now }, select: { id: true } });
      if (!(await attachImages(tx, ctx, msg.id, imageIds))) throw new Rejected("invalid_images");
      if (!(await attachFiles(tx, ctx, msg.id, fileIds, imageIds))) throw new Rejected("invalid_files");
      await tx.platformInquiry.update({ where: { id }, data: { status: "OPEN", lastMessageAt: now, sellerReadAt: now, version: { increment: 1 } } });
      await sellerAudit(tx, ctx, meta, "platform_inquiry.message", id, { messageId: msg.id, images: imageIds.length, files: fileIds.length });
      return true;
    });
    if (!ok) return null;
    return { ok: true as const, inquiry: (await getMyInquiry(db, ctx, id))! };
  } catch (e) {
    if (e instanceof Rejected) return { ok: false as const, reason: e.reason };
    throw e;
  }
}

// SA-115: 문의 종료(「해결됐습니다 · 종료」). 내가 볼 수 있는 문의를 접수·답변 완료 상태에서 닫는다. 이미 종료면 409 inquiry_closed. 본문 { helpful?: boolean }로 평가를 함께 남길 수 있다.
export async function closeMyInquiry(db: PrismaClient, ctx: TenantContext, id: string, raw: unknown, meta: AuditMeta = {}) {
  requireSellerWrite(ctx);
  if (!isUuid(id)) return null;
  const b = obj(raw);
  if (b.helpful !== undefined && typeof b.helpful !== "boolean") return { ok: false as const, reason: "invalid_helpful" as const };
  try {
    const found = await db.$transaction(async (tx) => {
      const [cur] = await tx.$queryRaw<{ id: string; status: PlatformInquiryStatus; helpful: boolean | null; lastAdminMessageAt: Date | null }[]>`
        SELECT "id", "status", "helpful", "lastAdminMessageAt" FROM "PlatformInquiry"
        WHERE "id" = ${id}::uuid AND "sellerId" = ${ctx.sellerId}::uuid AND (${ctx.isOwner} OR "createdBySellerUserId" = ${ctx.actorId}::uuid)
        FOR UPDATE`;
      if (!cur) return false;
      if (cur.status === "CLOSED") throw new Rejected("inquiry_closed");
      const rate = b.helpful !== undefined && cur.helpful === null && !!cur.lastAdminMessageAt;
      const now = new Date();
      await tx.platformInquiry.update({
        where: { id },
        data: { status: "CLOSED", closedAt: now, closedBySellerUserId: ctx.actorId, sellerReadAt: now, version: { increment: 1 }, ...(rate ? { helpful: b.helpful as boolean, helpfulAt: now } : {}) },
      });
      await sellerAudit(tx, ctx, meta, "platform_inquiry.close", id, { by: "PARTNER", rated: rate });
      return true;
    });
    if (!found) return null;
    return { ok: true as const, inquiry: (await getMyInquiry(db, ctx, id))! };
  } catch (e) {
    if (e instanceof Rejected) return { ok: false as const, reason: e.reason };
    throw e;
  }
}

// SA-115: 「답변이 도움이 됐습니까?」 평가. 본문 { helpful: boolean }. 문의 전체에 한 번만(다시 보내면 409 already_rated), 플랫폼 답변이 있은 뒤에만(없으면 409 no_reply_yet). 종료 전후 모두 된다.
export async function rateMyInquiry(db: PrismaClient, ctx: TenantContext, id: string, raw: unknown, meta: AuditMeta = {}) {
  requireSellerWrite(ctx);
  if (!isUuid(id)) return null;
  const helpful = obj(raw).helpful;
  if (typeof helpful !== "boolean") return { ok: false as const, reason: "invalid_helpful" as const };
  try {
    const found = await db.$transaction(async (tx) => {
      const [cur] = await tx.$queryRaw<{ helpful: boolean | null; lastAdminMessageAt: Date | null }[]>`
        SELECT "helpful", "lastAdminMessageAt" FROM "PlatformInquiry"
        WHERE "id" = ${id}::uuid AND "sellerId" = ${ctx.sellerId}::uuid AND (${ctx.isOwner} OR "createdBySellerUserId" = ${ctx.actorId}::uuid)
        FOR UPDATE`;
      if (!cur) return false;
      if (!cur.lastAdminMessageAt) throw new Rejected("no_reply_yet");
      if (cur.helpful !== null) throw new Rejected("already_rated");
      await tx.platformInquiry.update({ where: { id }, data: { helpful, helpfulAt: new Date() } });
      await sellerAudit(tx, ctx, meta, "platform_inquiry.rate", id, { helpful });
      return true;
    });
    if (!found) return null;
    return { ok: true as const, helpful };
  } catch (e) {
    if (e instanceof Rejected) return { ok: false as const, reason: e.reason };
    throw e;
  }
}

// SA-114 「관련 주문 · 방송」 선택 목록: 이 쇼핑몰의 최근 방송 20개·최근 주문 20개(최신순). 주문은 사람이 읽는 번호(orderNoLabel)와 닉네임만.
export const RELATED_OPTIONS = 20;
export async function listRelatedOptions(db: PrismaClient, ctx: TenantContext) {
  const [broadcasts, orders] = await Promise.all([
    db.broadcastSession.findMany({ where: { sellerId: ctx.sellerId }, orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: RELATED_OPTIONS, select: { id: true, title: true, startedAt: true } }),
    db.order.findMany({ where: { sellerId: ctx.sellerId, legalHoldAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: RELATED_OPTIONS, select: { id: true, orderNo: true, createdAt: true, broadcastNicknameSnapshot: true } }),
  ]);
  return {
    broadcasts,
    orders: orders.map((o) => ({ id: o.id, orderNoLabel: orderNoLabel(o.createdAt, o.orderNo), nickname: o.broadcastNicknameSnapshot, createdAt: o.createdAt })),
  };
}

// 첨부 사진 올리기(보내기 전). 붙지 않은 사진은 계정당 10장까지 두고 오래된 것부터 지운다.
export async function uploadInquiryImage(db: PrismaClient, ctx: TenantContext, bytes: Buffer, meta: AuditMeta = {}) {
  requireSellerWrite(ctx);
  const c = checkReviewImage(bytes);
  if (!c.ok) return c;
  return db.$transaction(async (tx) => {
    const scope = { sellerId: ctx.sellerId, sellerUserId: ctx.actorId, messageId: null };
    const old = await tx.platformInquiryImage.findMany({ where: scope, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: UNATTACHED_KEEP - 1, select: { id: true } });
    if (old.length > 0) await tx.platformInquiryImage.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
    const img = await tx.platformInquiryImage.create({
      data: { sellerId: ctx.sellerId, sellerUserId: ctx.actorId, data: new Uint8Array(c.image.data), contentType: c.image.type, byteSize: c.image.data.length, width: c.image.width, height: c.image.height },
      select: { id: true, width: true, height: true },
    });
    await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "platform_inquiry.image_upload", targetType: "PlatformInquiryImage", targetId: img.id, after: { byteSize: c.image.data.length }, ip: meta.ip, userAgent: meta.userAgent });
    return { ok: true as const, image: img };
  });
}

// 사진 외 첨부 파일 올리기(보내기 전). name은 파일 이름(확장자 .txt·.log·.zip). 붙지 않은 파일은 계정당 10개까지 두고 오래된 것부터 지운다.
export async function uploadInquiryFile(db: PrismaClient, ctx: TenantContext, name: unknown, bytes: Buffer, meta: AuditMeta = {}) {
  requireSellerWrite(ctx);
  const c = checkInquiryFile(name, bytes);
  if (!c.ok) return c;
  return db.$transaction(async (tx) => {
    const scope = { sellerId: ctx.sellerId, sellerUserId: ctx.actorId, messageId: null };
    const old = await tx.platformInquiryFile.findMany({ where: scope, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: UNATTACHED_KEEP - 1, select: { id: true } });
    if (old.length > 0) await tx.platformInquiryFile.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
    const f = await tx.platformInquiryFile.create({
      data: { sellerId: ctx.sellerId, sellerUserId: ctx.actorId, name: c.name, data: new Uint8Array(bytes), contentType: c.contentType, byteSize: bytes.length },
      select: { id: true, name: true, byteSize: true },
    });
    await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "platform_inquiry.file_upload", targetType: "PlatformInquiryFile", targetId: f.id, after: { byteSize: bytes.length }, ip: meta.ip, userAgent: meta.userAgent });
    return { ok: true as const, file: f };
  });
}

// 파트너스가 받는 파일: 자기가 올린 파일(붙기 전 포함) 또는 볼 수 있는 문의에 붙은 파일
export async function sellerInquiryFile(db: PrismaClient, ctx: TenantContext, fileId: string) {
  if (!isUuid(fileId)) return null;
  return db.platformInquiryFile.findFirst({
    where: { id: fileId, sellerId: ctx.sellerId, OR: [{ sellerUserId: ctx.actorId }, { message: { inquiry: sellerWhere(ctx) } }] },
    select: { data: true, contentType: true, name: true },
  });
}

// 파트너스가 보는 사진: 자기가 올린 사진(붙기 전 포함) 또는 볼 수 있는 문의에 붙은 사진
export async function sellerInquiryImage(db: PrismaClient, ctx: TenantContext, imageId: string) {
  if (!isUuid(imageId)) return null;
  return db.platformInquiryImage.findFirst({
    where: { id: imageId, sellerId: ctx.sellerId, OR: [{ sellerUserId: ctx.actorId }, { message: { inquiry: sellerWhere(ctx) } }] },
    select: { data: true, contentType: true },
  });
}

// ─── 마스터 관리자 ───

const ADMIN_LIST_SELECT = {
  id: true,
  sellerId: true,
  category: true,
  title: true,
  status: true,
  urgent: true,
  assignedAdminId: true,
  assignedAt: true,
  createdAt: true,
  lastMessageAt: true,
  lastAdminMessageAt: true,
  closedAt: true,
  version: true,
  createdBySellerUserId: true,
  seller: { select: { shopName: true, slug: true } },
} as const satisfies Prisma.PlatformInquirySelect;

// MA-051: 문의 목록. ?status=OPEN|ANSWERED|CLOSED&sellerId=&cursor=. 마지막 글 최신 순 50건, 상태별 수.
// ?assignee=me(내 담당)|none(미배정)|관리자 id, ?category. 담당·분류 조건은 건수(counts)에 넣지 않는다.
export async function listInquiries(db: PrismaClient, admin: AdminSessionContext, q: { status?: string | null; sellerId?: string | null; cursor?: string | null; assignee?: string | null; category?: string | null }) {
  requireRead(admin);
  if (q.status && !STATUSES.includes(q.status as PlatformInquiryStatus)) return { ok: false as const, reason: "invalid_status" as const };
  if (q.sellerId && !isUuid(q.sellerId)) return { ok: false as const, reason: "invalid_cursor" as const };
  const c = parseCursor(q.cursor);
  if (!c.ok) return { ok: false as const, reason: "invalid_cursor" as const };
  if (q.category && !FILTER_CATEGORIES.includes(q.category as PlatformInquiryCategory)) return { ok: false as const, reason: "invalid_category" as const };
  if (q.assignee && q.assignee !== "me" && q.assignee !== "none" && !isUuid(q.assignee)) return { ok: false as const, reason: "invalid_assignee" as const };
  const base: Prisma.PlatformInquiryWhereInput = q.sellerId ? { sellerId: q.sellerId } : {};
  const assigneeWhere: Prisma.PlatformInquiryWhereInput = !q.assignee ? {} : q.assignee === "none" ? { assignedAdminId: null } : { assignedAdminId: q.assignee === "me" ? admin.admin.id : q.assignee };
  const rows = await db.platformInquiry.findMany({
    where: { ...base, ...assigneeWhere, ...(q.category ? { category: q.category as PlatformInquiryCategory } : {}), ...(q.status ? { status: q.status as PlatformInquiryStatus } : {}), ...c.where },
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    take: ADMIN_PAGE_SIZE + 1,
    select: ADMIN_LIST_SELECT,
  });
  const page = rows.slice(0, ADMIN_PAGE_SIZE);
  const n = await names(db, page.map((r) => r.createdBySellerUserId), page.map((r) => r.assignedAdminId));
  const grouped = await db.platformInquiry.groupBy({ by: ["status"], where: base, _count: { _all: true } });
  return {
    ok: true as const,
    items: page.map(({ seller, createdBySellerUserId, ...r }) => ({
      ...r,
      shopName: seller.shopName,
      slug: seller.slug,
      authorName: n.user.get(createdBySellerUserId) ?? null,
      assignee: r.assignedAdminId ? { id: r.assignedAdminId, name: n.admin.get(r.assignedAdminId) ?? null } : null,
    })),
    counts: Object.fromEntries(STATUSES.map((s) => [s, grouped.find((g) => g.status === s)?._count._all ?? 0])) as Record<PlatformInquiryStatus, number>,
    nextCursor: nextCursor(rows, ADMIN_PAGE_SIZE),
  };
}

// MA-052: 문의 상세(대화 전체, 답변한 관리자 이름 포함). 없으면 null.
export async function getInquiry(db: PrismaClient, admin: AdminSessionContext, id: string) {
  requireRead(admin);
  if (!isUuid(id)) return null;
  const row = await db.platformInquiry.findUnique({
    where: { id },
    select: { ...ADMIN_LIST_SELECT, diagnostics: true, noticeId: true, closedByAdminId: true, closedBySellerUserId: true, helpful: true, helpfulAt: true, messages: { select: MESSAGE_SELECT, orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
  });
  if (!row) return null;
  const n = await names(db, [row.createdBySellerUserId, ...row.messages.map((m) => m.sellerUserId)], [row.closedByAdminId, row.assignedAdminId, ...row.messages.map((m) => m.adminId)]);
  const { seller, messages, noticeId, createdBySellerUserId, ...rest } = row;
  return {
    ...rest,
    shopName: seller.shopName,
    slug: seller.slug,
    authorName: n.user.get(createdBySellerUserId) ?? null,
    assignee: row.assignedAdminId ? { id: row.assignedAdminId, name: n.admin.get(row.assignedAdminId) ?? null } : null,
    closedByAdminName: row.closedByAdminId ? (n.admin.get(row.closedByAdminId) ?? null) : null,
    notice: await noticeTitle(db, noticeId),
    messages: messages.map((m) => ({
      id: m.id,
      author: m.authorType === "ADMIN" ? ("PLATFORM" as const) : ("PARTNER" as const),
      authorName: m.authorType === "ADMIN" ? (n.admin.get(m.adminId ?? "") ?? null) : (n.user.get(m.sellerUserId ?? "") ?? null),
      adminId: m.adminId,
      body: m.body,
      createdAt: m.createdAt,
      images: m.images.map((i) => ({ ...i, url: `/api/admin/platform-inquiries/images/${i.id}` })),
      files: m.files.map((f) => ({ ...f, url: `/api/admin/platform-inquiries/files/${f.id}` })),
    })),
  };
}

type Locked = { id: string; sellerId: string; status: PlatformInquiryStatus; version: number; assignedAdminId: string | null };
async function lockForAdmin(tx: Prisma.TransactionClient, id: string, expectedVersion: unknown) {
  const [cur] = await tx.$queryRaw<Locked[]>`SELECT "id", "sellerId", "status", "version", "assignedAdminId" FROM "PlatformInquiry" WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (!cur) return { ok: false as const, reason: "not_found" as const };
  if (cur.status === "CLOSED") return { ok: false as const, reason: "inquiry_closed" as const };
  if (expectedVersion !== cur.version) return { ok: false as const, reason: "version_conflict" as const, currentVersion: cur.version };
  return { ok: true as const, cur };
}

// MA-052: 답변. 본문 { body, expectedVersion }. 답변 완료로 바뀐다.
export async function replyInquiry(db: PrismaClient, admin: AdminSessionContext, id: string, raw: unknown, meta: AuditMeta = {}) {
  requireReply(admin);
  if (!isUuid(id)) return { ok: false as const, reason: "not_found" as const };
  const b = obj(raw);
  const body = cleanText(b.body, BODY_MAX, "multiline");
  if (!body) return { ok: false as const, reason: "invalid_body" as const };
  const r = await db.$transaction(async (tx) => {
    const l = await lockForAdmin(tx, id, b.expectedVersion);
    if (!l.ok) return l;
    const now = new Date();
    const msg = await tx.platformInquiryMessage.create({ data: { sellerId: l.cur.sellerId, inquiryId: id, authorType: "ADMIN", adminId: admin.admin.id, body, createdAt: now }, select: { id: true } });
    // 담당이 없는 문의에 첫 답변을 하면 그 관리자를 담당으로 자동 배정한다(이미 담당이 있으면 바꾸지 않는다)
    const auto = l.cur.assignedAdminId === null;
    await tx.platformInquiry.update({
      where: { id },
      data: { status: "ANSWERED", lastMessageAt: now, lastAdminMessageAt: now, version: { increment: 1 }, ...(auto ? { assignedAdminId: admin.admin.id, assignedAt: now } : {}) },
    });
    await adminAudit(tx, admin, meta, "platform_inquiry.reply", l.cur, { status: l.cur.status }, { status: "ANSWERED", messageId: msg.id });
    if (auto) await adminAudit(tx, admin, meta, "platform_inquiry.assign", l.cur, { assigneeId: null }, { assigneeId: admin.admin.id, auto: true });
    return { ok: true as const };
  });
  if (!r.ok) return r;
  return { ok: true as const, inquiry: (await getInquiry(db, admin, id))! };
}

// MA-052: 종료. 본문 { expectedVersion }. 종료하면 파트너스는 더 쓸 수 없다.
export async function closeInquiry(db: PrismaClient, admin: AdminSessionContext, id: string, raw: unknown, meta: AuditMeta = {}) {
  requireReply(admin);
  if (!isUuid(id)) return { ok: false as const, reason: "not_found" as const };
  const b = obj(raw);
  const r = await db.$transaction(async (tx) => {
    const l = await lockForAdmin(tx, id, b.expectedVersion);
    if (!l.ok) return l;
    await tx.platformInquiry.update({ where: { id }, data: { status: "CLOSED", closedAt: new Date(), closedByAdminId: admin.admin.id, version: { increment: 1 } } });
    await adminAudit(tx, admin, meta, "platform_inquiry.close", l.cur, { status: l.cur.status }, { status: "CLOSED" });
    return { ok: true as const };
  });
  if (!r.ok) return r;
  return { ok: true as const, inquiry: (await getInquiry(db, admin, id))! };
}

const ASSIGNEE_ROLES = ["SUPER_ADMIN", "OPERATIONS", "CS"] as const;

// MA-051·052 「담당 변경」 선택 목록: 담당할 수 있는 활성 관리자(최고관리자·운영·CS).
export async function listAssignees(db: PrismaClient, admin: AdminSessionContext) {
  requireRead(admin);
  const rows = await db.platformAdmin.findMany({ where: { status: "ACTIVE", role: { in: [...ASSIGNEE_ROLES] } }, select: { id: true, name: true, role: true }, orderBy: [{ name: "asc" }, { id: "asc" }] });
  return rows;
}

// MA-052: 담당 배정·변경·해제. 본문 { assigneeId: 관리자 id | null }. 최고관리자·운영·CS(support.assign). 종료된 문의는 409.
// 담당만 바꾸므로 version은 올리지 않는다(작성 중인 답변·종료가 막히지 않게). 같은 담당이면 아무것도 바꾸지 않는다. 로그 추적 platform_inquiry.assign.
export async function assignInquiry(db: PrismaClient, admin: AdminSessionContext, id: string, raw: unknown, meta: AuditMeta = {}) {
  if (!adminCan(admin.admin.role, "support.assign")) throw forbidden();
  if (!isUuid(id)) return { ok: false as const, reason: "not_found" as const };
  const b = obj(raw);
  if (b.assigneeId !== null && !isUuid(b.assigneeId)) return { ok: false as const, reason: "invalid_assignee" as const };
  const assigneeId = b.assigneeId;
  const r = await db.$transaction(async (tx) => {
    const [cur] = await tx.$queryRaw<{ id: string; sellerId: string; status: PlatformInquiryStatus; assignedAdminId: string | null }[]>`
      SELECT "id", "sellerId", "status", "assignedAdminId" FROM "PlatformInquiry" WHERE "id" = ${id}::uuid FOR UPDATE`;
    if (!cur) return { ok: false as const, reason: "not_found" as const };
    if (cur.status === "CLOSED") return { ok: false as const, reason: "inquiry_closed" as const };
    if (assigneeId) {
      const a = await tx.platformAdmin.findFirst({ where: { id: assigneeId, status: "ACTIVE", role: { in: [...ASSIGNEE_ROLES] } }, select: { id: true } });
      if (!a) return { ok: false as const, reason: "invalid_assignee" as const };
    }
    if (cur.assignedAdminId === assigneeId) return { ok: true as const };
    await tx.platformInquiry.update({ where: { id }, data: { assignedAdminId: assigneeId, assignedAt: assigneeId ? new Date() : null } });
    await adminAudit(tx, admin, meta, "platform_inquiry.assign", cur, { assigneeId: cur.assignedAdminId }, { assigneeId });
    return { ok: true as const };
  });
  if (!r.ok) return r;
  return { ok: true as const, inquiry: (await getInquiry(db, admin, id))! };
}

// 마스터가 받는 파일: 문의 글에 붙은 파일만
export async function adminInquiryFile(db: PrismaClient, admin: AdminSessionContext, fileId: string) {
  requireRead(admin);
  if (!isUuid(fileId)) return null;
  return db.platformInquiryFile.findFirst({ where: { id: fileId, messageId: { not: null } }, select: { data: true, contentType: true, name: true } });
}

// 마스터가 보는 사진: 문의 글에 붙은 사진만
export async function adminInquiryImage(db: PrismaClient, admin: AdminSessionContext, imageId: string) {
  requireRead(admin);
  if (!isUuid(imageId)) return null;
  return db.platformInquiryImage.findFirst({ where: { id: imageId, messageId: { not: null } }, select: { data: true, contentType: true } });
}
