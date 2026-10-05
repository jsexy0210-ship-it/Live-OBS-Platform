import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { cleanText } from "../text/clean";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { activeRestriction, lockSellerOrders, RESTRICTION_DAYS, sellerEventClock } from "./overdue";

// 파트너스가 회원에게 직접 거는 구매 제한(MEMBER_POINTS, 로그 추적). 기존 구매 제한 모델을 그대로 쓰고 reason=MANUAL, 사유 메모는 note에 남긴다.
// 주문 막기·풀기(liftRestriction)·목록은 자동 제한과 같다. 이미 걸린 제한이 있으면 겹쳐 걸지 않는다(409).
// 시작 시각은 판매자 시계(sellerEventClock)로 찍어 자동 제한 횟수 기준과 순서가 어긋나지 않게 한다.
export const RESTRICTION_REASON_MANUAL = "MANUAL";
export const MANUAL_RESTRICTION_MAX_DAYS = 365;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createManualRestriction(db: PrismaClient, ctx: TenantContext, buyerMemberId: string, raw: { days?: unknown; note?: unknown }) {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  if (!UUID_RE.test(buyerMemberId)) throw notFound();
  const days = raw.days === undefined || raw.days === null ? RESTRICTION_DAYS : raw.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MANUAL_RESTRICTION_MAX_DAYS) return { ok: false as const, reason: "invalid_restriction" as const };
  const note = raw.note === undefined || raw.note === null || raw.note === "" ? undefined : cleanText(raw.note, 200, "multiline");
  if (note === null) return { ok: false as const, reason: "invalid_restriction" as const };
  return db.$transaction(async (tx) => {
    await lockSellerOrders(tx, ctx.sellerId);
    const member = await tx.buyerMember.findFirst({ where: { id: buyerMemberId, sellerId: ctx.sellerId, deletedAt: null }, select: { status: true } });
    if (!member || member.status === "WITHDRAWN") throw notFound();
    const now = await sellerEventClock(tx, ctx.sellerId);
    if (await activeRestriction(tx, ctx.sellerId, buyerMemberId, now)) return { ok: false as const, reason: "already_restricted" as const };
    const endsAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const r = await tx.buyerPurchaseRestriction.create({
      data: { sellerId: ctx.sellerId, buyerMemberId, reason: RESTRICTION_REASON_MANUAL, note: note ?? null, startsAt: now, endsAt },
      select: { id: true, buyerMemberId: true, reason: true, note: true, startsAt: true, endsAt: true },
    });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "buyer.purchase_restriction.create",
      targetType: "BuyerMember",
      targetId: buyerMemberId,
      reason: note,
      after: { reason: RESTRICTION_REASON_MANUAL, days, endsAt },
    });
    return { ok: true as const, value: r };
  });
}
