import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 재가입 제한은 동의 철회 기능 전까지 API로 켤 수 없다(lib/server/buyers/rejoin.ts REJOIN_RESTRICTION_CONFIG).
// 「이미 켜진 쇼핑몰」 화면을 확인하는 e2e는 폐기용 테스트 DB(이름이 _test로 끝남)에 정책을 직접 넣는다.
export async function setMemberPolicyInDb(shopSlug: string, enabled: boolean, days = 90) {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug: shopSlug }, select: { id: true } });
    const data = { rejoinRestrictionEnabled: enabled, rejoinRestrictionDays: days };
    await db.sellerMemberPolicy.upsert({ where: { sellerId: seller.id }, create: { sellerId: seller.id, ...data }, update: data });
    if (!enabled) await db.buyerRejoinBlock.deleteMany({ where: { sellerId: seller.id } });
  } finally {
    await db.$disconnect();
  }
}
