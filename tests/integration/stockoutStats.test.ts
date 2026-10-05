import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as route } from "../../app/api/seller/stats/stockout/route";
import { createSellerSession } from "../../lib/server/auth/session";
import { stockoutStats } from "../../lib/server/stats/stockout";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 재고 소진 속도 GET /api/seller/stats/stockout
beforeEach(resetDb);
afterAll(() => db.$disconnect());

type Shop = Awaited<ReturnType<typeof createSeller>>;
const cookieOf = async (s: Shop, user: Awaited<ReturnType<typeof createSellerUser>>) =>
  `lo_seller=${(await createSellerSession(db, s.seller.id, user.id, {}, user.credentialVersion)).token}`;
const get = (q: string, cookie?: string) => route(new Request(`http://localhost:3000/api/seller/stats/stockout${q}`, { headers: { host: "localhost:3000", ...(cookie ? { cookie } : {}) } }));

// 지금 = KST 2026-10-15 12:00. 14일 창 = KST 10/2 0시부터
const NOW = new Date("2026-10-15T03:00:00Z");
const IN = "2026-10-05T03:00:00Z";
const BEFORE = "2026-10-01T14:00:00Z"; // KST 10/1 23시 → 창 밖

async function option(s: Shop, name: string, stock: number, extra: { status?: "ON_SALE" | "SOLD_OUT" | "DRAFT"; productDeleted?: boolean; optionDeleted?: boolean } = {}) {
  const p = await db.product.create({ data: { sellerId: s.seller.id, name: `상품 ${name}`, price: 1000, status: extra.status ?? "ON_SALE", deletedAt: extra.productDeleted ? new Date() : null } });
  const o = await db.productOption.create({ data: { sellerId: s.seller.id, productId: p.id, name, stock, deletedAt: extra.optionDeleted ? new Date() : null } });
  return { p, o };
}
async function sell(s: Shop, opt: Awaited<ReturnType<typeof option>>, at: string, quantity: number, extra: { paid?: boolean; refunded?: number } = {}) {
  const buyer = await createBuyer(s.seller.id, s.grade.id);
  const paid = extra.paid ?? true;
  const order = await db.order.create({
    data: { sellerId: s.seller.id, orderNo: Math.floor(Math.random() * 1e9), buyerMemberId: buyer.id, broadcastNicknameSnapshot: "닉", totalAmount: 1000, status: paid ? "PAID" : "PENDING_PAYMENT", createdAt: new Date(at), paidAt: paid ? new Date(at) : null } as never,
  });
  await db.orderItem.create({
    data: { sellerId: s.seller.id, orderId: order.id, productId: opt.p.id, optionId: opt.o.id, productNameSnapshot: opt.p.name, optionNameSnapshot: opt.o.name, unitPrice: 1000, quantity, refundedQuantity: extra.refunded ?? 0 },
  });
}

describe("재고 소진 속도", () => {
  it("최근 N일 판매 수량과 재고로 하루 판매·예상 소진일을 주고, 소진이 빠른 순으로 정렬한다", async () => {
    const a = await createSeller();
    const other = await createSeller();
    const A = await option(a, "A", 10);
    await sell(a, A, IN, 14);
    await sell(a, A, IN, 14); // 합 28 → 하루 2, 5일
    const B = await option(a, "B", 0, { status: "SOLD_OUT" });
    await sell(a, B, IN, 7); // 하루 0.5, 재고 0 → 0일
    const C = await option(a, "C", 100);
    await sell(a, C, IN, 14); // 하루 1, 100일
    const F = await option(a, "F", 6);
    await sell(a, F, IN, 10, { refunded: 4 }); // 판매 6 → 0.4/일, 14일
    // 빠지는 것들
    await sell(a, await option(a, "D", 1), BEFORE, 5); // 창 밖
    await sell(a, await option(a, "E", 1), IN, 5, { paid: false }); // 결제 전
    await sell(a, await option(a, "G", 1, { status: "DRAFT" }), IN, 5); // 판매 대기 상품
    await sell(a, await option(a, "H", 1, { optionDeleted: true }), IN, 5); // 지운 옵션
    await sell(a, await option(a, "I", 1, { productDeleted: true }), IN, 5); // 지운 상품
    await option(a, "J", 3); // 판매 없음
    await sell(other, await option(other, "K", 1), IN, 50); // 다른 쇼핑몰

    const owner = await createSellerUser(a.seller.id, "OWNER");
    const ctx: TenantContext = { sellerId: a.seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
    const r = await stockoutStats(db, ctx, 14, NOW);
    expect(r.range).toEqual({ days: 14, from: "2026-10-02", to: "2026-10-15" });
    expect(r.rows.map((x) => [x.optionName, x.stock, x.sold, x.perDay, x.daysLeft])).toEqual([
      ["B", 0, 7, 0.5, 0],
      ["A", 10, 28, 2, 5],
      ["F", 6, 6, 0.4, 14],
      ["C", 100, 14, 1, 100],
    ]);
    expect(r.total).toBe(4);
    expect(r.atRisk).toBe(2);
    // 7일 창(KST 10/5 0시부터, 지금 = 10/11)이면 같은 판매가 더 빨리 팔린 것으로 본다(하루 판매 = 판매 ÷ 7)
    const week = await stockoutStats(db, ctx, 7, new Date("2026-10-11T03:00:00Z"));
    expect(week.rows.find((x) => x.optionName === "A")).toMatchObject({ perDay: 4, daysLeft: 2.5 });
  });

  it("목록은 20개까지이고 atRisk·total은 전체 기준이다", async () => {
    const a = await createSeller();
    for (let i = 0; i < 25; i++) await sell(a, await option(a, `O${i}`, i), IN, 14);
    const owner = await createSellerUser(a.seller.id, "OWNER");
    const ctx: TenantContext = { sellerId: a.seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
    const r = await stockoutStats(db, ctx, 14, NOW);
    expect(r.rows).toHaveLength(20);
    expect(r.total).toBe(25);
    expect(r.atRisk).toBe(8); // 재고 0~7 → 하루 1 → 0~7일
    expect(r.rows.map((x) => x.stock)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it("라우트: days 기본 14·7·30만 받고, 통계 권한이 있는 직원만 보며, 로그인 없음은 401", async () => {
    const a = await createSeller();
    const withPerm = await createSellerUser(a.seller.id, { permissions: ["SALES_VIEW"] });
    const without = await createSellerUser(a.seller.id, { permissions: ["PRODUCT_MANAGE"] });
    const ok = await get("", await cookieOf(a, withPerm));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toContain("no-store");
    expect((await ok.json()).range.days).toBe(14);
    expect((await get("?days=7", await cookieOf(a, withPerm))).status).toBe(200);
    expect((await get("?days=30", await cookieOf(a, withPerm))).status).toBe(200);
    expect((await get("?days=10", await cookieOf(a, withPerm))).status).toBe(400);
    expect((await get("?days=abc", await cookieOf(a, withPerm))).status).toBe(400);
    expect((await get("", await cookieOf(a, without))).status).toBe(403);
    expect((await get("")).status).toBe(401);
  });
});
