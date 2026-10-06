import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../lib/server/db";
import { createShopDefaults } from "../../lib/server/sellers/shopDefaults";
import { createSeller, db, resetDb } from "./helpers";

// 쇼핑몰 기본값(docs/SHOP_DEFAULTS.md): 기존 쇼핑몰은 행이 없는 곳에만 채우고, 이미 있는 값은 덮어쓰지 않으며, 다시 돌려도 같다(추가형 마이그레이션).
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

// 마이그레이션의 「행 채우기」 부분(INSERT)만 다시 실행한다(칼럼 추가·옛 행 옮기기는 이미 적용됨)
const FILL = readFileSync("prisma/migrations/20261006270000_shop_defaults/migration.sql", "utf8")
  .split("\n")
  .filter((l) => !l.startsWith("--"))
  .join("\n")
  .split(";")
  .map((q) => q.trim())
  .filter((q) => q.startsWith("INSERT"));
const runFill = async () => {
  for (const q of FILL) await db.$executeRawUnsafe(q);
};

describe("쇼핑몰 기본값 채우기", () => {
  it("행이 없는 곳에만 채우고, 이미 입력한 값은 덮어쓰지 않으며, 다시 돌려도 달라지지 않는다", async () => {
    const { seller: a } = await createSeller();
    const { seller: b } = await createSeller();
    // a: 배송 정책을 직접 바꿔 저장해 둔 쇼핑몰, 진열 설정을 저장했고 영역은 하나도 두지 않음. b: 아무것도 없음
    await db.sellerShippingPolicy.create({ data: { sellerId: a.id, baseFee: 5000, freeOverAmount: 50000 } });
    await db.shopDisplaySetting.create({ data: { sellerId: a.id, listSort: "popular" } });
    await db.shopSeo.create({ data: { sellerId: a.id, searchTitle: "우리 가게" } });
    await runFill();
    expect(await db.sellerShippingPolicy.findUniqueOrThrow({ where: { sellerId: a.id } })).toMatchObject({ baseFee: 5000, freeOverAmount: 50000 });
    expect(await db.shopDisplaySetting.findUniqueOrThrow({ where: { sellerId: a.id } })).toMatchObject({ listSort: "popular" });
    expect(await db.shopDisplaySection.count({ where: { sellerId: a.id } })).toBe(0);
    expect((await db.shopSeo.findUniqueOrThrow({ where: { sellerId: a.id } })).searchTitle).toBe("우리 가게");
    expect(await db.sellerShippingPolicy.findUniqueOrThrow({ where: { sellerId: b.id } })).toMatchObject({ baseFee: 3000, remoteSurcharge: 3000 });
    expect((await db.shopDisplaySection.findMany({ where: { sellerId: b.id }, orderBy: { sortOrder: "asc" } })).map((x) => x.title)).toEqual(["추천 상품", "신상품"]);
    expect(await db.rewardPolicy.count()).toBe(0);
    const snap = async () => JSON.stringify([await db.sellerShippingPolicy.findMany({ orderBy: { sellerId: "asc" } }), await db.shopDisplaySection.count(), await db.sellerOrderPolicy.findMany({ orderBy: { sellerId: "asc" } }), await db.memberGradePolicy.findMany({ orderBy: { sellerId: "asc" } })]);
    const before = await snap();
    await runFill();
    expect(await snap()).toBe(before);
  });

  it("생성 때 기본값 만들기는 여러 번 불러도 한 번만 만들고, 이미 있는 값은 그대로 둔다", async () => {
    const { seller } = await createSeller();
    await db.sellerShippingPolicy.create({ data: { sellerId: seller.id, baseFee: 4500 } });
    await db.$transaction(async (tx) => {
      await createShopDefaults(tx, seller.id);
      await createShopDefaults(tx, seller.id);
    });
    expect((await db.sellerShippingPolicy.findUniqueOrThrow({ where: { sellerId: seller.id } })).baseFee).toBe(4500);
    expect(await db.shopDisplaySection.count({ where: { sellerId: seller.id } })).toBe(2);
    expect(await db.shopDisplaySetting.count({ where: { sellerId: seller.id } })).toBe(1);
  });
});
