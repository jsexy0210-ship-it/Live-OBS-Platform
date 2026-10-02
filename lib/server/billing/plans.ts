import type { PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { writeAudit } from "../audit/log";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";

// 요금 안내·구독 화면에 보여 줄 가격(부가세 포함). 정가는 취소선, 판매가가 실제 청구액이다.
export async function getPublicPlan(db: PrismaClient, code = "STANDARD") {
  const plan = await db.subscriptionPlan.findUnique({ where: { code } });
  return plan ? { code: plan.code, name: plan.name, listPrice: plan.listPrice, salePrice: plan.salePrice } : null;
}

const isPrice = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 100_000_000;

// 가격 변경(마스터). 코드 수정 없이 바꾼다. 이미 만든 청구에는 영향이 없고 다음 결제부터 적용된다.
export async function updatePlanPrice(
  db: PrismaClient,
  admin: AdminSessionContext,
  code: string,
  input: { listPrice: unknown; salePrice: unknown },
  meta: { ip?: string | null; userAgent?: string | null } = {},
) {
  if (!adminCan(admin.admin.role, "billing.manage")) throw forbidden();
  if (!isPrice(input.listPrice) || !isPrice(input.salePrice) || input.listPrice < input.salePrice) {
    return { ok: false as const, reason: "invalid_price" as const };
  }
  const before = await db.subscriptionPlan.findUnique({ where: { code } });
  if (!before) return { ok: false as const, reason: "not_found" as const };
  const plan = await db.subscriptionPlan.update({ where: { code }, data: { listPrice: input.listPrice, salePrice: input.salePrice } });
  await writeAudit(db, {
    actorType: "PLATFORM_ADMIN",
    actorId: admin.admin.id,
    action: "admin.plan.price_update",
    targetType: "SubscriptionPlan",
    targetId: plan.id,
    before: { listPrice: before.listPrice, salePrice: before.salePrice },
    after: { listPrice: plan.listPrice, salePrice: plan.salePrice },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { ok: true as const, plan: { code: plan.code, name: plan.name, listPrice: plan.listPrice, salePrice: plan.salePrice } };
}
