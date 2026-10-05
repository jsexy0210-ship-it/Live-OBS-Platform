import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 재입고 알림 e2e 준비·정리(폐기용 테스트 DB). 상품 하나는 재고를 0으로 만들어 품절 상태로 대기 신청 2건,
// 다른 상품은 이미 발송된 신청 1건을 만든다. 정리 때 재고와 신청을 되돌린다.
const open = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });
type Restore = { stocks: { id: string; stock: number }[]; soldOutName: string; sentName: string };

export async function seedRestockInDb(slug: string): Promise<Restore> {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const buyers = await db.buyerMember.findMany({ where: { sellerId: seller.id, deletedAt: null }, take: 2, orderBy: { createdAt: "asc" } });
    const products = await db.product.findMany({ where: { sellerId: seller.id, deletedAt: null, status: "ON_SALE" }, take: 2, orderBy: { createdAt: "asc" }, include: { options: { where: { deletedAt: null } } } });
    const [soldOut, sent] = products;
    const stocks = soldOut.options.map((o) => ({ id: o.id, stock: o.stock }));
    await db.restockAlert.deleteMany({ where: { sellerId: seller.id, productId: { in: [soldOut.id, sent.id] } } });
    await db.productOption.updateMany({ where: { id: { in: stocks.map((s) => s.id) } }, data: { stock: 0 } });
    for (const b of buyers) await db.restockAlert.create({ data: { sellerId: seller.id, buyerMemberId: b.id, productId: soldOut.id } });
    const past = new Date(Date.now() - 3_600_000);
    await db.restockAlert.create({ data: { sellerId: seller.id, buyerMemberId: buyers[0].id, productId: sent.id, status: "SENT", restockedAt: past, notifyAt: past, notifiedAt: past } });
    return { stocks, soldOutName: soldOut.name, sentName: sent.name };
  } finally {
    await db.$disconnect();
  }
}

export async function clearRestockInDb(slug: string, restore?: Restore) {
  const db = open();
  try {
    const seller = await db.seller.findUnique({ where: { slug } });
    if (!seller) return;
    await db.restockAlert.deleteMany({ where: { sellerId: seller.id } });
    for (const s of restore?.stocks ?? []) await db.productOption.update({ where: { id: s.id }, data: { stock: s.stock } });
  } finally {
    await db.$disconnect();
  }
}
