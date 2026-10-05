import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 상품 진열 e2e 준비·정리(폐기용 테스트 DB, 이름이 _test로 끝남). 데모 쇼핑몰의 진열 설정(영역·추천 상품·옵션)을 비운다.
// 카테고리 안 순서 시험을 위해 「부스터 박스」(categoryDb 시험용 카테고리)에 상품을 하나 더 지정한다.
const open = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });

export async function resetDisplayInDb(slug: string, linkBoxProduct?: string) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    await db.shopDisplaySection.deleteMany({ where: { sellerId: seller.id } });
    await db.shopDisplayItem.deleteMany({ where: { sellerId: seller.id } });
    await db.shopDisplaySetting.deleteMany({ where: { sellerId: seller.id } });
    if (linkBoxProduct) {
      const box = await db.shopCategory.findFirstOrThrow({ where: { sellerId: seller.id, name: "부스터 박스" } });
      const p = await db.product.findFirstOrThrow({ where: { sellerId: seller.id, name: linkBoxProduct } });
      await db.productCategory.create({ data: { sellerId: seller.id, productId: p.id, categoryId: box.id, sortOrder: 5 } });
    }
  } finally {
    await db.$disconnect();
  }
}
