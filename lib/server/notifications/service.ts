import type { PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan, IMPERSONATION_READ_ACTIONS, sellerCan, type SellerAction } from "../authz/permissions";
import type { TenantContext } from "../tenant/context";

// 알림 센터(파트너스 SA-130 · 마스터 MA-002). 알림은 공지·문의에서 바로 만들어 주고 따로 쌓지 않는다(메일·알림톡 발송 없음).
// - 항목마다 처리 화면으로 가는 href를 단다(IA 「알림마다 처리 화면으로 바로 가는 링크」).
// - 파트너스: 새 공지(대상이 파트너스·전체인 게시 공지, 최근 14일, 마지막으로 본 시각 이후면 안 읽음)와
//   문의 답변(내 문의 중 플랫폼 답변이 달렸고 아직 열지 않음). 문의는 sellerWhere와 같이 대표자는 쇼핑몰 전체, 직원은 자기 문의만.
//   업무 알림(주문·재고·반품)도 같은 방식으로 지금 데이터에서 만든다(항목마다 id가 하나라 같은 건이 두 번 나오지 않고, 처리하면 사라진다). 모두 ctx.sellerId 안에서만 읽고,
//   그 종류를 볼 권한이 있는 계정에게만 준다(주문·반품은 ORDER_SHIPPING, 재고는 PRODUCT_MANAGE, 공지·문의는 누구나). 안 읽음은 일어난 시각이 마지막으로 본 시각 이후인 것.
//   · DEPOSIT_PENDING 입금 확인 필요: 무통장으로 정했고 아직 결제 대기인 주문(자동 취소되거나 입금이 확인되면 사라짐)
//   · ORDER_PAID 결제 완료: 최근 14일 안에 결제된 주문(결제 시각 기준)
//   · OUT_OF_STOCK 재고 없음: 판매 중인 상품 중 지우지 않은 옵션 재고 합계가 0(목록의 「재고 없음」과 같은 기준)
//   · RETURN_REQUESTED 반품·교환 요청: 접수를 기다리는(REQUESTED) 건
// - 마스터: 답변을 기다리는 문의(OPEN). 보기는 마스터 관리자 전 역할.
// - 마스터 대리 조회(readOnly)는 보기만 하고 「읽음」은 남기지 않는다.

export const NOTICE_DAYS = 14;
export const ORDER_DAYS = 14;
export const PER_KIND = 10;
export const LIMIT = 30;
const DAY = 86_400_000;

export type NotificationKind = "NOTICE" | "INQUIRY_REPLY" | "INQUIRY_WAITING" | "DEPOSIT_PENDING" | "ORDER_PAID" | "OUT_OF_STOCK" | "RETURN_REQUESTED";
export type NotificationItem = { id: string; kind: NotificationKind; title: string; href: string; createdAt: Date; unread: boolean };

const byNewest = (a: NotificationItem, b: NotificationItem) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1);

const canSee = (ctx: TenantContext, action: SellerAction) => (ctx.readOnly ? IMPERSONATION_READ_ACTIONS.includes(action) : sellerCan(ctx, action));

export async function listSellerNotifications(db: PrismaClient, ctx: TenantContext, now = new Date()) {
  const seen = await db.sellerNotificationSeen.findUnique({ where: { sellerUserId: ctx.actorId } });
  const isUnread = (at: Date) => !seen || at > seen.seenAt;
  const orderSince = new Date(now.getTime() - ORDER_DAYS * DAY);
  const seeOrders = canSee(ctx, "ORDER_SHIPPING");
  const [notices, inquiries, deposits, paid, stock, returns] = await Promise.all([
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
    seeOrders
      ? db.order.findMany({
          where: { sellerId: ctx.sellerId, status: "PENDING_PAYMENT", paymentMethod: "BANK_TRANSFER", legalHoldAt: null },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: PER_KIND,
          select: { id: true, orderNo: true, createdAt: true },
        })
      : [],
    seeOrders
      ? db.order.findMany({
          where: { sellerId: ctx.sellerId, paidAt: { gte: orderSince }, legalHoldAt: null },
          orderBy: [{ paidAt: "desc" }, { id: "desc" }],
          take: PER_KIND,
          select: { id: true, orderNo: true, paidAt: true },
        })
      : [],
    canSee(ctx, "PRODUCT_MANAGE")
      ? db.$queryRaw<{ id: string; name: string; at: Date }[]>`
          SELECT p."id", p."name", COALESCE((SELECT max(m."createdAt") FROM "StockMovement" m JOIN "ProductOption" o ON o."id" = m."optionId" WHERE o."productId" = p."id" AND o."sellerId" = p."sellerId"), p."createdAt") AS "at"
          FROM "Product" p
          WHERE p."sellerId" = ${ctx.sellerId}::uuid AND p."status" = 'ON_SALE' AND p."deletedAt" IS NULL
            AND EXISTS (SELECT 1 FROM "ProductOption" o WHERE o."productId" = p."id" AND o."sellerId" = p."sellerId" AND o."deletedAt" IS NULL)
            AND NOT EXISTS (SELECT 1 FROM "ProductOption" o WHERE o."productId" = p."id" AND o."sellerId" = p."sellerId" AND o."deletedAt" IS NULL AND o."stock" > 0)
          ORDER BY "at" DESC, p."id" DESC
          LIMIT ${PER_KIND}`
      : [],
    seeOrders
      ? db.returnRequest.findMany({
          where: { sellerId: ctx.sellerId, status: "REQUESTED" },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: PER_KIND,
          select: { id: true, kind: true, createdAt: true, order: { select: { orderNo: true } } },
        })
      : [],
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
    ...deposits.map((o) => ({ id: `deposit:${o.id}`, kind: "DEPOSIT_PENDING" as const, title: `주문 ${o.orderNo} 입금 확인 필요`, href: `/seller/orders/${o.id}`, createdAt: o.createdAt, unread: isUnread(o.createdAt) })),
    ...paid.map((o) => ({ id: `paid:${o.id}`, kind: "ORDER_PAID" as const, title: `주문 ${o.orderNo} 결제 완료`, href: `/seller/orders/${o.id}`, createdAt: o.paidAt!, unread: isUnread(o.paidAt!) })),
    ...stock.map((p) => ({ id: `stock:${p.id}`, kind: "OUT_OF_STOCK" as const, title: `${p.name} 재고 없음`, href: `/seller/products/${p.id}`, createdAt: p.at, unread: isUnread(p.at) })),
    ...returns.map((r) => ({ id: `return:${r.id}`, kind: "RETURN_REQUESTED" as const, title: `주문 ${r.order.orderNo} ${r.kind === "EXCHANGE" ? "교환" : "반품"} 요청`, href: "/seller/returns", createdAt: r.createdAt, unread: isUnread(r.createdAt) })),
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
