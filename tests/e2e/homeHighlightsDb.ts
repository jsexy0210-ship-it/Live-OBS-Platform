import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 홈 「이번 주 인기 카드」·공지 카드 e2e 준비·정리(폐기용 테스트 DB). 표시용 HIT 카드와 공지에 구분용 접두어를 붙여 정리 때 그것만 지운다.
const TAG = "e2e홈";
const open = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });

export async function seedHomeHighlights(slug: string, count: number) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      await db.hitCard.create({ data: { sellerId: seller.id, nicknameSnapshot: `${TAG}닉${i + 1}`, cardName: `${TAG}카드${i + 1}`, createdAt: new Date(now - i * 3_600_000) } });
    }
    return db.shopNotice.create({ data: { sellerId: seller.id, kind: "NOTICE", title: `${TAG} 공지`, body: "본문", isPublished: true, isPinned: true } });
  } finally {
    await db.$disconnect();
  }
}

export async function clearHomeHighlights(slug: string) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    await db.hitCard.deleteMany({ where: { sellerId: seller.id, cardName: { startsWith: TAG } } });
    await db.shopNotice.deleteMany({ where: { sellerId: seller.id, title: { startsWith: TAG } } });
  } finally {
    await db.$disconnect();
  }
}
