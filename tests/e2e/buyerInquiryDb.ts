import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 구매자 문의 e2e 준비·정리(폐기용 테스트 DB, 이름이 _test로 끝남). 제목이 「문의e2e」로 시작하는 문의만 만들고 지운다.
export const INQUIRY_TITLES = { waiting: "문의e2e-답변 대기", private: "문의e2e-비공개 문의", answered: "문의e2e-답변 완료" } as const;
const open = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });

export async function seedInquiriesInDb(slug: string) {
  const db = open();
  try {
    await clearInquiriesInDb(slug);
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const buyer = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, loginId: "demo-buyer1@example.com", deletedAt: null } });
    const product = await db.product.findFirstOrThrow({ where: { sellerId: seller.id, deletedAt: null } });
    const base = { sellerId: seller.id, buyerMemberId: buyer.id, authorNickname: "문의e2e작성자" };
    await db.buyerInquiry.create({ data: { ...base, kind: "PRODUCT", productId: product.id, title: INQUIRY_TITLES.waiting, body: "사이즈가 어떻게 되나요?" } });
    await db.buyerInquiry.create({ data: { ...base, kind: "GENERAL", title: INQUIRY_TITLES.private, body: "배송 주소를 바꾸고 싶어요", isPrivate: true } });
    await db.buyerInquiry.create({
      data: { ...base, kind: "GENERAL", title: INQUIRY_TITLES.answered, body: "언제 도착하나요?", status: "ANSWERED", answer: "내일 도착 예정입니다", answeredAt: new Date() },
    });
    return { productName: product.name };
  } finally {
    await db.$disconnect();
  }
}

export async function inquiryFromDb(slug: string, title: string) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const r = await db.buyerInquiry.findFirstOrThrow({ where: { sellerId: seller.id, title } });
    return { status: r.status, answer: r.answer };
  } finally {
    await db.$disconnect();
  }
}

export async function clearInquiriesInDb(slug: string) {
  const db = open();
  try {
    const seller = await db.seller.findUnique({ where: { slug } });
    if (!seller) return;
    const rows = await db.buyerInquiry.findMany({ where: { sellerId: seller.id, title: { startsWith: "문의e2e" } }, select: { id: true } });
    const ids = rows.map((r) => r.id);
    await db.buyerInquiryImage.deleteMany({ where: { inquiryId: { in: ids } } });
    await db.buyerInquiry.deleteMany({ where: { id: { in: ids } } });
  } finally {
    await db.$disconnect();
  }
}
