import type { PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { writeAudit } from "../audit/log";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { PRICE_NOTICE_MS, dbNow, priceFor } from "./subscription";

// 요금 안내·구독 화면에 보여 줄 가격(부가세 포함). 정가는 취소선, 판매가가 실제 청구액이다.
export async function getPublicPlan(db: PrismaClient, code = "STANDARD") {
  const plan = await db.subscriptionPlan.findUnique({ where: { code } });
  return plan ? { code: plan.code, name: plan.name, listPrice: plan.listPrice, salePrice: plan.salePrice } : null;
}

const isPrice = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 100_000_000;

// 가격 변경(최고관리자만, 대표님 결정 2026-10-02). 코드 수정 없이 바꾼다.
// 새 가입자에게는 바로 새 판매가, 기존 구독자에게는 변경 시각 + 30일 이후 첫 결제부터 적용한다.
// 그 전 결제는 지금 기존 구독자가 내는 가격(previousSalePrice)을 쓴다. 가격 변경과 감사 기록은 한 트랜잭션이다.
export async function updatePlanPrice(
  db: PrismaClient,
  admin: AdminSessionContext,
  code: string,
  input: { listPrice: unknown; salePrice: unknown },
  meta: { ip?: string | null; userAgent?: string | null } = {},
) {
  if (!adminCan(admin.admin.role, "billing.price")) throw forbidden();
  if (!isPrice(input.listPrice) || !isPrice(input.salePrice) || input.listPrice < input.salePrice) {
    return { ok: false as const, reason: "invalid_price" as const };
  }
  const listPrice = input.listPrice;
  const salePrice = input.salePrice;
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "SubscriptionPlan" WHERE code = ${code} FOR UPDATE`;
    const before = await tx.subscriptionPlan.findUnique({ where: { code } });
    if (!before) return { ok: false as const, reason: "not_found" as const };
    const now = await dbNow(tx);
    // 지금 기존 구독자가 내는 가격(이전 변경의 30일이 아직 안 지났으면 그 이전 가격)
    const existingPays = priceFor(before, new Date(0), now);
    const plan = await tx.subscriptionPlan.update({
      where: { code },
      data: { listPrice, salePrice, previousSalePrice: existingPays, priceChangedAt: now },
    });
    const appliesToExistingFrom = new Date(now.getTime() + PRICE_NOTICE_MS);
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.admin.id,
      action: "admin.plan.price_update",
      targetType: "SubscriptionPlan",
      targetId: plan.id,
      before: { listPrice: before.listPrice, salePrice: before.salePrice },
      after: { listPrice, salePrice, existingPrice: existingPays, appliesToExistingFrom },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, plan: { code: plan.code, name: plan.name, listPrice, salePrice, appliesToExistingFrom } };
  });
}

// 가격 변경 고지 대상(기존 구독자 대표자). 메일·알림톡 발송은 알림 기능이 생길 때 연결한다.
export async function listPriceChangeNoticeTargets(db: PrismaClient, admin: AdminSessionContext, code = "STANDARD") {
  if (!adminCan(admin.admin.role, "billing.price")) throw forbidden();
  const plan = await db.subscriptionPlan.findUnique({ where: { code } });
  if (!plan?.priceChangedAt) return [];
  const subs = await db.sellerSubscription.findMany({
    where: { planId: plan.id, status: { in: ["ACTIVE", "PAST_DUE"] }, cancelAtPeriodEnd: false, createdAt: { lt: plan.priceChangedAt } },
    select: { sellerId: true, seller: { select: { shopName: true, users: { where: { isOwner: true }, select: { email: true } } } } },
  });
  const appliesFrom = new Date(plan.priceChangedAt.getTime() + PRICE_NOTICE_MS);
  return subs.map((s) => ({
    sellerId: s.sellerId,
    shopName: s.seller.shopName,
    ownerEmails: s.seller.users.map((u) => u.email),
    oldPrice: plan.previousSalePrice,
    newPrice: plan.salePrice,
    appliesFrom,
  }));
}
