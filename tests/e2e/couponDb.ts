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
