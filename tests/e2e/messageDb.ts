import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 회원 알림 발송 e2e 정리(폐기용 테스트 DB). 데모 쇼핑몰의 발송 기록을 시작·끝에 지운다.
const open = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });

export async function clearMessagesInDb(slug: string) {
  const db = open();
  try {
    const seller = await db.seller.findUnique({ where: { slug } });
    if (!seller) return;
    await db.memberMessage.deleteMany({ where: { sellerId: seller.id } });
  } finally {
    await db.$disconnect();
  }
}

// 광고성 발송 시험용: 데모 구매자 한 명을 수신 동의 상태로 만들고, 끝나면 처음 값으로 돌린다.
export async function setConsentInDb(slug: string, loginId: string, consent: boolean | null): Promise<boolean> {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const m = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, loginId, deletedAt: null } });
    const was = m.marketingConsentAt !== null;
    const on = consent ?? false;
    await db.buyerMember.update({ where: { id: m.id }, data: on ? { marketingConsentAt: new Date(), marketingConsentVersion: m.marketingConsentVersion ?? "v1" } : { marketingConsentAt: null, marketingConsentVersion: null } });
    return was;
  } finally {
    await db.$disconnect();
  }
}
