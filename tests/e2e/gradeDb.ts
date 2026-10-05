import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 회원 등급 e2e 정리(폐기용 테스트 DB). 데모 쇼핑몰의 등급 설정·고정·변경 기록을 시작·끝에 처음 상태로 돌린다.
const open = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });

export async function resetGradesInDb(slug: string) {
  const db = open();
  try {
    const seller = await db.seller.findUnique({ where: { slug } });
    if (!seller) return;
    const base = await db.memberGrade.findFirstOrThrow({ where: { sellerId: seller.id, systemKey: "BASIC" } });
    // 직접 만든 등급의 회원은 기본 등급으로 돌리고 등급을 지운다
    const custom = await db.memberGrade.findMany({ where: { sellerId: seller.id, systemKey: null }, select: { id: true } });
    await db.buyerMember.updateMany({ where: { sellerId: seller.id, gradeId: { in: custom.map((c) => c.id) } }, data: { gradeId: base.id } });
    await db.memberGradeOverride.deleteMany({ where: { sellerId: seller.id } });
    await db.memberGradeHistory.deleteMany({ where: { sellerId: seller.id } });
    await db.memberGradeRun.deleteMany({ where: { sellerId: seller.id } });
    await db.memberGradePolicy.deleteMany({ where: { sellerId: seller.id } });
    await db.memberGrade.deleteMany({ where: { id: { in: custom.map((c) => c.id) } } });
    await db.memberGrade.updateMany({ where: { sellerId: seller.id, systemKey: { not: null } }, data: { minAmount: 0 } });
  } finally {
    await db.$disconnect();
  }
}

export async function gradeOfMemberInDb(slug: string, loginId: string): Promise<{ grade: string; locked: boolean }> {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const m = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, loginId, deletedAt: null }, include: { grade: true } });
    return { grade: m.grade.displayName, locked: (await db.memberGradeOverride.count({ where: { buyerMemberId: m.id } })) > 0 };
  } finally {
    await db.$disconnect();
  }
}
