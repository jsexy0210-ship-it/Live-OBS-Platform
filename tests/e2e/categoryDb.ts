import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 카테고리 e2e 준비·정리(폐기용 테스트 DB). 데모 쇼핑몰의 카테고리를 지우고 시험용을 넣는다. 끝나면 다시 지운다.
const open = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });

export async function resetCategoriesInDb(slug: string, seed: boolean) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    await db.productCategory.deleteMany({ where: { sellerId: seller.id } });
    await db.shopCategory.deleteMany({ where: { sellerId: seller.id, parentId: { not: null } } });
    await db.shopCategory.deleteMany({ where: { sellerId: seller.id } });
    if (!seed) return;
    const make = (name: string, sortOrder: number, extra: { parentId?: string; visible?: boolean } = {}) => db.shopCategory.create({ data: { sellerId: seller.id, name, sortOrder, ...extra } });
    const box = await make("부스터 박스", 1);
    const premium = await make("프리미엄", 1, { parentId: box.id });
    const pack = await make("팩", 2);
    const hidden = await make("비공개 분류", 3, { visible: false });
    const link = async (productName: string, categoryId: string) => {
      const p = await db.product.findFirstOrThrow({ where: { sellerId: seller.id, name: productName } });
      await db.productCategory.create({ data: { sellerId: seller.id, productId: p.id, categoryId } });
    };
    await link("스타라이트 부스터 박스", box.id);
    await link("문라이트 컬렉션 박스", premium.id);
    await link("탑로더 25장", pack.id);
    await link("탑로더 25장", hidden.id);
  } finally {
    await db.$disconnect();
  }
}
