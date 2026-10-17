import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { cleanText } from "../text/clean";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";

// 파트너스 주문 메모(SA-021 「메모 남기기」, ORDER_SHIPPING). 주문마다 1건을 덮어쓰고 작성자·수정 시각을 남긴다.
// 항상 ctx.sellerId 범위만 보고, 없는·다른 쇼핑몰 주문은 404로 다룬다. 빈 글을 저장하면 메모를 지운다.
// 자유 입력이라 개인정보가 섞일 수 있어 로그 추적에는 본문 없이 글자 수만 남긴다(회원 메모와 같은 방식).
export const ORDER_MEMO_MAX = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireOrder(db: Pick<PrismaClient, "order">, ctx: TenantContext, orderId: string) {
  if (!UUID_RE.test(orderId)) throw notFound();
  const o = await db.order.findFirst({ where: { id: orderId, sellerId: ctx.sellerId, legalHoldAt: null }, select: { id: true } });
  if (!o) throw notFound();
}

export async function getOrderMemo(db: PrismaClient, ctx: TenantContext, orderId: string) {
  requireSellerRead(ctx, "ORDER_SHIPPING");
  await requireOrder(db, ctx, orderId);
  const memo = await db.orderMemo.findUnique({ where: { sellerId_orderId: { sellerId: ctx.sellerId, orderId } } });
  if (!memo) return null;
  const author = memo.updatedById ? await db.sellerUser.findFirst({ where: { id: memo.updatedById, sellerId: ctx.sellerId }, select: { name: true } }) : null;
  return { body: memo.body, createdAt: memo.createdAt, updatedAt: memo.updatedAt, updatedBy: author ? { name: author.name } : null };
}

// 메모 저장. 빈 글(공백만 포함)이면 지운다. 글자가 잘못됐거나 1,000자를 넘으면 { ok: false }.
export async function putOrderMemo(db: PrismaClient, ctx: TenantContext, orderId: string, raw: unknown) {
  requireSellerPermission(ctx, "ORDER_SHIPPING");
  const clear = typeof raw === "string" && raw.trim() === "";
  const body = clear ? null : cleanText(raw, ORDER_MEMO_MAX, "multiline");
  if (!clear && body === null) return { ok: false as const, reason: "invalid_memo" as const };
  const sellerId = ctx.sellerId;
  const key = { sellerId_orderId: { sellerId, orderId } };
  const by = ctx.actorType === "SELLER_USER" ? ctx.actorId : null;
  await db.$transaction(async (tx) => {
    await requireOrder(tx, ctx, orderId);
    const base = { actorType: ctx.actorType, actorId: ctx.actorId, sellerId, targetType: "Order", targetId: orderId };
    if (body === null) {
      const gone = await tx.orderMemo.deleteMany({ where: { sellerId, orderId } });
      if (gone.count > 0) await writeAudit(tx, { ...base, action: "order.memo.delete" });
      return;
    }
    const before = await tx.orderMemo.findUnique({ where: key, select: { body: true } });
    await tx.orderMemo.upsert({
      where: key,
      create: { sellerId, orderId, body, updatedById: by },
      update: { body, updatedById: by, updatedAt: new Date() },
    });
    await writeAudit(tx, { ...base, action: "order.memo.update", before: before ? { length: [...before.body].length } : null, after: { length: [...body].length } });
  });
  return { ok: true as const, memo: await getOrderMemo(db, ctx, orderId) };
}
