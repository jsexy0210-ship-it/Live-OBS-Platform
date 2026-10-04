import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 새 파트너는 통합 요금제·체험 없음으로 첫 결제 전까지 잠긴다(#185). 잠기지 않은 상태가 필요한 e2e는
// 폐기용 테스트 DB(이름이 _test로 끝남)에 결제한 이용 기간(구독 + 결제 1건)을 넣는다. 실제 결제는 하지 않는다.
export async function grantPaidPeriodInDb(ownerEmail: string) {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    const owner = await db.sellerUser.findFirstOrThrow({ where: { email: ownerEmail, isOwner: true }, select: { sellerId: true } });
    const seller = await db.seller.findUniqueOrThrow({ where: { id: owner.sellerId }, select: { planId: true } });
    const plan = seller.planId ? { id: seller.planId } : await db.subscriptionPlan.findFirstOrThrow({ where: { code: "INTEGRATED" }, select: { id: true } });
    const start = new Date();
    const end = new Date(start.getTime() + 30 * 86_400_000);
    const sub = await db.sellerSubscription.upsert({
      where: { sellerId: owner.sellerId },
      create: { sellerId: owner.sellerId, planId: plan.id, status: "ACTIVE", currentPeriodStart: start, currentPeriodEnd: end },
      update: { status: "ACTIVE", currentPeriodStart: start, currentPeriodEnd: end },
    });
    await db.subscriptionPayment.create({ data: { sellerId: owner.sellerId, subscriptionId: sub.id, amount: 1, periodStart: start, periodEnd: end, status: "PAID", paidAt: start } });
  } finally {
    await db.$disconnect();
  }
}
