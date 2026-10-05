import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";

type Db = PrismaClient | Prisma.TransactionClient;

// 주문자 거래 메일 켜기·끄기(SA-080, SHOP_SETTINGS). 종류 4개: 주문 완료·발송·배송 완료·취소·환불. 기본은 모두 켬(행이 없어도 켬).
// 메일을 보내는 쪽은 보내기 전에 isOrderMailEnabled로 확인한다. 변경은 로그 추적에 남긴다.
export const ORDER_MAIL_KINDS = ["orderComplete", "shipped", "delivered", "cancelRefund"] as const;
export type OrderMailKind = (typeof ORDER_MAIL_KINDS)[number];
export type OrderNotificationPolicy = Record<OrderMailKind, boolean>;

const COLUMN: Record<OrderMailKind, "orderCompleteEnabled" | "shippedEnabled" | "deliveredEnabled" | "cancelRefundEnabled"> = {
  orderComplete: "orderCompleteEnabled",
  shipped: "shippedEnabled",
  delivered: "deliveredEnabled",
  cancelRefund: "cancelRefundEnabled",
};

export async function readOrderNotificationPolicyOf(db: Db, sellerId: string): Promise<OrderNotificationPolicy> {
  const row = await db.sellerOrderNotificationPolicy.findUnique({ where: { sellerId } });
  return Object.fromEntries(ORDER_MAIL_KINDS.map((k) => [k, row ? row[COLUMN[k]] : true])) as OrderNotificationPolicy;
}

// 발송하는 쪽이 부른다. 켜져 있으면 true.
export async function isOrderMailEnabled(db: Db, sellerId: string, kind: OrderMailKind): Promise<boolean> {
  return (await readOrderNotificationPolicyOf(db, sellerId))[kind];
}

export async function readOrderNotificationPolicy(db: PrismaClient, ctx: TenantContext) {
  requireSellerRead(ctx, "SHOP_SETTINGS");
  return readOrderNotificationPolicyOf(db, ctx.sellerId);
}

// 본문: 4개 키(boolean), 빼면 지금 값 유지. 하나도 없거나 모르는 키·boolean 아닌 값이면 { ok: false }.
export async function updateOrderNotificationPolicy(db: PrismaClient, ctx: TenantContext, raw: unknown) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false as const };
  const b = raw as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.length === 0 || keys.some((k) => !(ORDER_MAIL_KINDS as readonly string[]).includes(k) || typeof b[k] !== "boolean")) return { ok: false as const };
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`order_notification_policy:${ctx.sellerId}`}))`;
    const before = await readOrderNotificationPolicyOf(tx, ctx.sellerId);
    const after: OrderNotificationPolicy = { ...before, ...(b as Partial<OrderNotificationPolicy>) };
    const data = Object.fromEntries(ORDER_MAIL_KINDS.map((k) => [COLUMN[k], after[k]]));
    await tx.sellerOrderNotificationPolicy.upsert({ where: { sellerId: ctx.sellerId }, create: { sellerId: ctx.sellerId, ...data }, update: data });
    if (ORDER_MAIL_KINDS.some((k) => before[k] !== after[k])) {
      await writeAudit(tx, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        sellerId: ctx.sellerId,
        action: "order_notification_policy.update",
        targetType: "Seller",
        targetId: ctx.sellerId,
        before,
        after,
      });
    }
    return { ok: true as const, policy: after };
  });
}
