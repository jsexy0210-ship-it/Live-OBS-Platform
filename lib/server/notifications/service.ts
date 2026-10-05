import type { PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import type { TenantContext } from "../tenant/context";

// 알림 센터(파트너스 SA-130 · 마스터 MA-002). 알림은 공지·문의에서 바로 만들어 주고 따로 쌓지 않는다(메일·알림톡 발송 없음).
// - 항목마다 처리 화면으로 가는 href를 단다(IA 「알림마다 처리 화면으로 바로 가는 링크」).
// - 파트너스: 새 공지(대상이 파트너스·전체인 게시 공지, 최근 14일, 마지막으로 본 시각 이후면 안 읽음)와
//   문의 답변(내 문의 중 플랫폼 답변이 달렸고 아직 열지 않음). 문의는 sellerWhere와 같이 대표자는 쇼핑몰 전체, 직원은 자기 문의만.
// - 마스터: 답변을 기다리는 문의(OPEN). 보기는 마스터 관리자 전 역할.
// - 마스터 대리 조회(readOnly)는 보기만 하고 「읽음」은 남기지 않는다.

export const NOTICE_DAYS = 14;
export const LIMIT = 30;
const DAY = 86_400_000;

export type NotificationKind = "NOTICE" | "INQUIRY_REPLY" | "INQUIRY_WAITING";
export type NotificationItem = { id: string; kind: NotificationKind; title: string; href: string; createdAt: Date; unread: boolean };

const byNewest = (a: NotificationItem, b: NotificationItem) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1);

export async function listSellerNotifications(db: PrismaClient, ctx: TenantContext, now = new Date()) {
  const seen = await db.sellerNotificationSeen.findUnique({ where: { sellerUserId: ctx.actorId } });
  const [notices, inquiries] = await Promise.all([
    db.platformNotice.findMany({
      where: { deletedAt: null, publishedAt: { gte: new Date(now.getTime() - NOTICE_DAYS * DAY), not: null }, audience: { in: ["PARTNERS", "ALL"] } },
      orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
      take: LIMIT,
      select: { id: true, title: true, publishedAt: true },
    }),
    db.platformInquiry.findMany({
      where: { sellerId: ctx.sellerId, ...(ctx.isOwner ? {} : { createdBySellerUserId: ctx.actorId }), lastAdminMessageAt: { not: null } },
      orderBy: [{ lastAdminMessageAt: "desc" }, { id: "desc" }],
      take: LIMIT,
      select: { id: true, title: true, lastAdminMessageAt: true, sellerReadAt: true },
    }),
  ]);
  const items: NotificationItem[] = [
    ...notices.map((n) => ({
      id: `notice:${n.id}`,
      kind: "NOTICE" as const,
      title: n.title,
      href: `/seller/notices/${n.id}`,
      createdAt: n.publishedAt!,
      unread: !seen || n.publishedAt! > seen.seenAt,
    })),
    ...inquiries.map((q) => ({
      id: `inquiry:${q.id}`,
      kind: "INQUIRY_REPLY" as const,
      title: q.title,
      href: `/seller/inquiries/${q.id}`,
      createdAt: q.lastAdminMessageAt!,
      unread: !q.sellerReadAt || q.lastAdminMessageAt! > q.sellerReadAt,
    })),
  ]
    .sort(byNewest)
    .slice(0, LIMIT);
  return { items, unreadCount: items.filter((i) => i.unread).length };
}

// 알림 센터를 연 것으로 남긴다(공지 알림만 읽음, 문의 답변은 문의를 열어야 읽음). 마스터 대리 조회는 남기지 않는다.
export async function markSellerNotificationsSeen(db: PrismaClient, ctx: TenantContext, now = new Date()) {
  if (ctx.readOnly) throw forbidden();
  await db.sellerNotificationSeen.upsert({ where: { sellerUserId: ctx.actorId }, create: { sellerUserId: ctx.actorId, seenAt: now }, update: { seenAt: now } });
}

export async function listAdminNotifications(db: PrismaClient, admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
  const where = { status: "OPEN" as const };
  const [rows, count] = await Promise.all([
    db.platformInquiry.findMany({ where, orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }], take: LIMIT, select: { id: true, title: true, lastMessageAt: true } }),
    db.platformInquiry.count({ where }),
  ]);
  const items: NotificationItem[] = rows.map((q) => ({
    id: `inquiry:${q.id}`,
    kind: "INQUIRY_WAITING",
    title: q.title,
    href: `/admin/support/inquiries/${q.id}`,
    createdAt: q.lastMessageAt,
    unread: true,
  }));
  return { items, unreadCount: count };
}
