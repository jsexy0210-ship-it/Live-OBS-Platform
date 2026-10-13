import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 회원정보 수정(SH-024) e2e 준비·정리(폐기용 테스트 DB). 닉네임을 원래대로 돌리고 30일 제한 기록을 비운다.
const open = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });

export async function resetNicknameInDb(slug: string, loginId: string, nickname: string, changedDaysAgo: number | null) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    await db.buyerMember.updateMany({
      where: { sellerId: seller.id, loginId, deletedAt: null },
      data: { broadcastNickname: nickname, broadcastNicknameChangedAt: changedDaysAgo === null ? null : new Date(Date.now() - changedDaysAgo * 86_400_000) },
    });
  } finally {
    await db.$disconnect();
  }
}

export async function nicknameInDb(slug: string, loginId: string): Promise<string> {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    return (await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, loginId, deletedAt: null } })).broadcastNickname;
  } finally {
    await db.$disconnect();
  }
}
