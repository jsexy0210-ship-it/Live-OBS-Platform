import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 장바구니 e2e 준비·정리(폐기용 테스트 DB). 데모 구매자의 장바구니를 비우고 상품 이름으로 고른 첫 옵션을 담는다.
// 품절 줄은 API가 담기를 막으므로 DB에 바로 넣는다.
const open = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });

export async function resetCartInDb(slug: string, loginId: string, lines: { productName: string; quantity: number }[]) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const buyer = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, loginId, deletedAt: null } });
    await db.cartItem.deleteMany({ where: { sellerId: seller.id, buyerMemberId: buyer.id } });
    for (const l of lines) {
      const option = await db.productOption.findFirstOrThrow({ where: { sellerId: seller.id, deletedAt: null, product: { name: l.productName, deletedAt: null } }, orderBy: { createdAt: "asc" } });
      await db.cartItem.create({ data: { sellerId: seller.id, buyerMemberId: buyer.id, optionId: option.id, quantity: l.quantity } });
    }
  } finally {
    await db.$disconnect();
  }
}
