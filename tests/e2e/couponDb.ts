import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 쿠폰 e2e 정리: 발급한 쿠폰은 API로 지울 수 없어서(집계 보존) 폐기용 테스트 DB(이름이 _test로 끝남)에서 그 쇼핑몰 쿠폰을 직접 지운다.
export async function clearCouponsInDb(slug: string) {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    const seller = await db.seller.findUnique({ where: { slug }, select: { id: true } });
    if (!seller) return;
    await db.couponRedemption.deleteMany({ where: { sellerId: seller.id } });
    await db.buyerCoupon.deleteMany({ where: { sellerId: seller.id } });
    await db.coupon.deleteMany({ where: { sellerId: seller.id } });
  } finally {
    await db.$disconnect();
  }
}

// 주문서 쿠폰 e2e: 데모 구매자에게 정액 쿠폰을 직접 지급한다(폐기용 테스트 DB만). 정리는 clearCouponsInDb.
export async function grantAmountCouponInDb(slug: string, loginId: string, name: string, amount: number) {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug }, select: { id: true } });
    const member = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, loginId }, select: { id: true } });
    const now = Date.now();
    const coupon = await db.coupon.create({
      data: { sellerId: seller.id, name, issueMethod: "MANUAL", benefit: "AMOUNT", value: amount, minOrderAmount: 0, startsAt: new Date(now - 86_400_000), endsAt: new Date(now + 30 * 86_400_000), issuedCount: 1, excludeDiscounted: false },
    });
    await db.buyerCoupon.create({ data: { sellerId: seller.id, couponId: coupon.id, buyerMemberId: member.id, issuedAt: new Date(now), expiresAt: new Date(now + 30 * 86_400_000) } });
  } finally {
    await db.$disconnect();
  }
}
