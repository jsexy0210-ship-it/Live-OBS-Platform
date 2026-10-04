import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 다른 쇼핑몰 세션 확인용 쇼핑몰을 폐기용 테스트 DB(이름이 _test로 끝남)에 만든다(있으면 그대로). 데모 시드에는 쇼핑몰이 하나뿐이다.
export async function ensureShopInDb(slug: string, shopName: string) {
  const db = new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
  try {
    await db.seller.upsert({
      where: { slug },
      update: {},
      create: { slug, shopName, status: "ACTIVE", approvedAt: new Date(), trialEndsAt: new Date(Date.now() + 10 * 86_400_000) },
    });
  } finally {
    await db.$disconnect();
  }
}
