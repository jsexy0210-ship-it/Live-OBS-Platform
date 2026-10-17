import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../lib/server/db";
import { commitProductImport, getBulkJob, previewProductImport, undoProductImport } from "../../lib/server/shop-bulk-io/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createSeller, createSellerUser, db, resetDb } from "./helpers";

// SA-018 기존 상품 수정: 상품명이 같으면 판매가·재고만 수정하고(새 옵션은 만들지 않음), 되돌리기는 반영 전 값으로 돌린다.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const HEAD = "상품명,판매가,상태,설명,차감시점,카테고리,옵션명,옵션추가금,재고,SKU";
const csv = (...rows: string[]) => [HEAD, ...rows].join("\r\n");

type Preview = {
  jobId: string;
  productCount: number;
  createCount: number;
  updateCount: number;
  skippedProductCount: number;
  errors: { row: number; column: string | null; message: string }[];
  products: { name: string; mode: string; currentPrice: number | null; stockChangeCount: number }[];
};

async function shop() {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, ctx };
}
const preview = async (ctx: TenantContext, text: string) => {
  const r = await previewProductImport(db, ctx, { csv: text, fileName: "a.csv" });
  if (!r.ok) throw new Error(r.reason);
  return r.value as Preview;
};
const commit = async (ctx: TenantContext, id: string) => {
  const r = await commitProductImport(db, ctx, id);
  if (!r.ok) throw new Error(r.reason);
  return r.value as { createdCount: number; updatedCount: number; failedCount: number; failures: { message: string }[] };
};
const undo = async (ctx: TenantContext, id: string) => {
  const r = await undoProductImport(db, ctx, id);
  if (!r.ok) throw new Error(r.reason);
  return r.value as { removedCount: number; restoredCount: number; keptCount: number; kept: { name: string }[] };
};
const seed = async (ctx: TenantContext) => {
  const p = await preview(ctx, csv("부스터 팩,5000,판매중,,,,기본,0,30,BP-1", "슬리브,3000,판매중,,,,검정,0,10,", ",,,,,,흰색,500,5,"));
  await commit(ctx, p.jobId);
};
const stockOf = async (sellerId: string, product: string) =>
  Object.fromEntries((await db.productOption.findMany({ where: { sellerId, product: { name: product } } })).map((o) => [o.name, o.stock]));
const priceOf = async (sellerId: string, product: string) => (await db.product.findFirstOrThrow({ where: { sellerId, name: product, deletedAt: null } })).price;

describe("기존 상품 수정", () => {
  it("상품명이 같으면 판매가·재고만 바꾸고, 새 상품은 그대로 등록한다. 재고 변경은 기록이 남고 미리보기는 아무것도 바꾸지 않는다", async () => {
    const s = await shop();
    await seed(s.ctx);
    const p = await preview(s.ctx, csv("부스터 팩,6000,준비중,새 설명,주문 시,,기본,999,50,ZZ", "슬리브,3000,판매중,,,,검정,0,,", ",,,,,,흰색,0,8,", "새 상품,1000,판매중,,,,기본,0,3,"));
    expect([p.productCount, p.createCount, p.updateCount, p.skippedProductCount, p.errors]).toEqual([3, 1, 2, 0, []]);
    expect(p.products.map((x) => [x.name, x.mode, x.currentPrice, x.stockChangeCount])).toEqual([["부스터 팩", "update", 5000, 1], ["슬리브", "update", 3000, 1], ["새 상품", "create", null, 0]]);
    expect(await priceOf(s.seller.id, "부스터 팩")).toBe(5000);
    expect(await stockOf(s.seller.id, "부스터 팩")).toEqual({ 기본: 30 });

    const c = await commit(s.ctx, p.jobId);
    expect(c).toMatchObject({ createdCount: 1, updatedCount: 2, failedCount: 0 });
    // 판매가·재고만 바뀌고 상태·설명·옵션추가금·SKU 같은 나머지 칸은 쓰지 않는다
    const booster = await db.product.findFirstOrThrow({ where: { sellerId: s.seller.id, name: "부스터 팩" }, include: { options: true } });
    expect([booster.price, booster.status, booster.description, booster.stockDeductMode]).toEqual([6000, "ON_SALE", null, "PAYMENT"]);
    expect(booster.options.map((o) => [o.name, o.stock, o.priceDelta, o.sku])).toEqual([["기본", 50, 0, "BP-1"]]);
    // 재고 칸을 비운 옵션은 그대로, 채운 옵션만 바뀐다
    expect(await stockOf(s.seller.id, "슬리브")).toEqual({ 검정: 10, 흰색: 8 });
    expect(await db.product.count({ where: { sellerId: s.seller.id, name: "부스터 팩", deletedAt: null } })).toBe(1);
    const moves = await db.stockMovement.findMany({ where: { sellerId: s.seller.id, note: "재고 일괄 수정" } });
    expect(moves.map((m) => m.delta).sort((a, b) => a - b)).toEqual([3, 20]);
    const job = await getBulkJob(db, s.ctx, p.jobId);
    expect(job).toMatchObject({ createdCount: 1, updatedCount: 2, updatedStockCount: 2 });
  });

  it("옵션이 상품에 없거나 같은 상품이 둘이거나 파일에 두 번 있으면 그 상품만 오류로 건너뛴다", async () => {
    const s = await shop();
    await seed(s.ctx);
    const dup = await db.product.create({ data: { sellerId: s.seller.id, name: "중복 이름", price: 100, status: "HIDDEN" } });
    await db.product.create({ data: { sellerId: s.seller.id, name: dup.name, price: 200, status: "HIDDEN" } });
    const p = await preview(
      s.ctx,
      csv("부스터 팩,5500,판매중,,,,없는 옵션,0,5,", "슬리브,3100,판매중,,,,검정,0,11,", "슬리브,3200,판매중,,,,검정,0,12,", "중복 이름,300,판매중,,,,기본,0,1,"),
    );
    expect([p.productCount, p.updateCount, p.skippedProductCount]).toEqual([1, 1, 3]);
    expect(p.errors.map((e) => [e.row, e.column])).toEqual([[2, "옵션명"], [4, "상품명"], [5, "상품명"]]);
    const c = await commit(s.ctx, p.jobId);
    expect(c).toMatchObject({ updatedCount: 1, failedCount: 0 });
    expect(await priceOf(s.seller.id, "슬리브")).toBe(3100);
    expect(await stockOf(s.seller.id, "슬리브")).toMatchObject({ 검정: 11 });
    expect(await priceOf(s.seller.id, "부스터 팩")).toBe(5000);
  });

  it("지운 상품과는 이름이 같아도 새 상품으로 등록한다", async () => {
    const s = await shop();
    await seed(s.ctx);
    await db.product.updateMany({ where: { sellerId: s.seller.id, name: "슬리브" }, data: { deletedAt: new Date() } });
    const p = await preview(s.ctx, csv("슬리브,3500,판매중,,,,검정,0,7,"));
    expect([p.createCount, p.updateCount]).toEqual([1, 0]);
  });

  it("되돌리면 반영 전 값으로 돌리되 그 뒤 주문으로 줄어든 재고는 그대로 두고, 그사이 직접 바꾼 판매가는 두고 알려 준다", async () => {
    const s = await shop();
    await seed(s.ctx);
    const p = await preview(s.ctx, csv("부스터 팩,6000,판매중,,,,기본,0,50,", "슬리브,3500,판매중,,,,검정,0,15,"));
    await commit(s.ctx, p.jobId);
    // 반영 뒤 주문으로 재고 3개 감소, 슬리브 판매가는 직접 다시 바꿈
    await db.productOption.updateMany({ where: { sellerId: s.seller.id, name: "기본" }, data: { stock: { decrement: 3 } } });
    await db.product.updateMany({ where: { sellerId: s.seller.id, name: "슬리브" }, data: { price: 3900 } });
    const u = await undo(s.ctx, p.jobId);
    expect(u).toMatchObject({ removedCount: 0, restoredCount: 1, keptCount: 1, kept: [{ name: "슬리브" }] });
    expect(await priceOf(s.seller.id, "부스터 팩")).toBe(5000);
    expect(await stockOf(s.seller.id, "부스터 팩")).toEqual({ 기본: 27 }); // 30 − 3
    expect(await stockOf(s.seller.id, "슬리브")).toMatchObject({ 검정: 10 }); // 재고는 돌아옴
    expect(await priceOf(s.seller.id, "슬리브")).toBe(3900); // 직접 바꾼 판매가는 그대로
  });

  it("권한 없는 직원은 미리보기부터 막힌다", async () => {
    const s = await shop();
    const staff = await createSellerUser(s.seller.id, { permissions: ["ORDER_SHIPPING"] });
    const ctx: TenantContext = { ...s.ctx, actorId: staff.id, isOwner: false, permissions: ["ORDER_SHIPPING"] };
    await expect(previewProductImport(db, ctx, { csv: csv("a,1000,판매중,,,,기본,0,1,"), fileName: "a.csv" })).rejects.toThrow();
  });
});
