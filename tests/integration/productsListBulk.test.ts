import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as bulkRoute } from "../../app/api/seller/products/bulk/route";
import { GET as listRoute } from "../../app/api/seller/products/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { ORDER_ERROR_MESSAGES_FORMAL } from "../../lib/server/orders/messages";
import { bulkProducts } from "../../lib/server/products/bulk";
import { createProduct, listProducts, type ProductListQuery } from "../../lib/server/products/manage";
import { markOrderPaid } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 상품 목록 검색·정렬(SA-011)과 선택 일괄 처리
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const shippingAddress = { recipientName: "김구매", phone: "01012345678", zipCode: "06236", address1: "서울 강남구 테헤란로 1" };
const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };

async function seller() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, grade, owner, ctx };
}

async function made(ctx: TenantContext, body: Record<string, unknown> = {}) {
  const r = await createProduct(db, ctx, { name: "팩", price: 5000, status: "ON_SALE", options: [{ name: "1박스", stock: 100 }], ...body });
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}

async function names(ctx: TenantContext, q: ProductListQuery) {
  const r = await listProducts(db, ctx, q);
  if (!r.ok) throw new Error(r.reason);
  return r.value.products.map((p) => p.name);
}

// 커서로 끝까지 넘겨 모은 이름(빠짐·겹침 확인용)
async function allPages(ctx: TenantContext, q: ProductListQuery) {
  const out: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const r = await listProducts(db, ctx, { ...q, limit: "2", cursor });
    if (!r.ok) throw new Error(r.reason);
    out.push(...r.value.products.map((p) => p.name));
    if (!r.value.nextCursor) return out;
    cursor = r.value.nextCursor;
  }
}

describe("목록 검색", () => {
  it("노출 상태·판매 방식·등록일 기간(KST, 양 끝 포함)·상품 코드(id·SKU)로 고르고, 다른 쇼핑몰은 섞이지 않는다", async () => {
    const s = await seller();
    const other = await seller();
    const a = await made(s.ctx, { name: "A", status: "ON_SALE", stockDeductMode: "ORDER", options: [{ name: "o", sku: "MG-Pack-01" }] });
    await made(s.ctx, { name: "B", status: "SOLD_OUT" });
    const c = await made(s.ctx, { name: "C", status: "DRAFT" });
    await made(s.ctx, { name: "D", status: "HIDDEN" });
    await made(other.ctx, { name: "X", stockDeductMode: "ORDER", options: [{ name: "o", sku: "MG-Pack-01" }] });

    expect((await names(s.ctx, { display: "shown" })).sort()).toEqual(["A", "B"]);
    expect((await names(s.ctx, { display: "hidden" })).sort()).toEqual(["C", "D"]);
    expect(await names(s.ctx, { display: "hidden", status: "HIDDEN" })).toEqual(["D"]);
    expect(await names(s.ctx, { saleMode: "ORDER" })).toEqual(["A"]);
    expect(await names(s.ctx, { code: "pack-0" })).toEqual(["A"]);
    expect(await names(s.ctx, { code: a.id.toUpperCase() })).toEqual(["A"]);
    expect(await names(s.ctx, { code: a.id.slice(0, 8) })).toEqual([]);

    // 등록일: 2026-10-01 00:00 KST(= 09-30 15:00Z)는 1일에 들어가고, 2026-10-01 23:59:59 KST도 1일. 2일 0시는 빠진다.
    await db.product.update({ where: { id: a.id }, data: { createdAt: new Date("2026-09-30T15:00:00Z") } });
    await db.product.update({ where: { id: c.id }, data: { createdAt: new Date("2026-10-01T14:59:59Z") } });
    await db.product.updateMany({ where: { sellerId: s.seller.id, name: { in: ["B", "D"] } }, data: { createdAt: new Date("2026-10-01T15:00:00Z") } });
    expect((await names(s.ctx, { createdFrom: "2026-10-01", createdTo: "2026-10-01" })).sort()).toEqual(["A", "C"]);
    expect((await names(s.ctx, { createdFrom: "2026-10-02" })).sort()).toEqual(["B", "D"]);
    expect((await names(s.ctx, { createdTo: "2026-09-30" })).sort()).toEqual([]);

    for (const [q, reason] of [
      [{ display: "all" }, "invalid_display"],
      [{ saleMode: "LIVE" }, "invalid_sale_mode"],
      [{ createdFrom: "2026-10-02", createdTo: "2026-10-01" }, "invalid_date_range"],
      [{ createdFrom: "2026-02-30" }, "invalid_date_range"],
      [{ createdTo: "2026/10/01" }, "invalid_date_range"],
      [{ code: "x".repeat(65) }, "invalid_code"],
      [{ code: "a\tb" }, "invalid_code"],
      [{ sort: "name" }, "invalid_sort"],
    ] as const) {
      expect(await listProducts(db, s.ctx, q)).toEqual({ ok: false, reason });
    }
  });
});

describe("목록 정렬", () => {
  it("판매량(결제 완료만)·가격·최근 등록 순으로 정렬하고, 커서로 넘겨도 빠짐·겹침이 없다", async () => {
    const s = await seller();
    const p = {
      A: await made(s.ctx, { name: "A", price: 3000 }),
      B: await made(s.ctx, { name: "B", price: 1000 }),
      C: await made(s.ctx, { name: "C", price: 3000 }),
      D: await made(s.ctx, { name: "D", price: 2000 }),
      E: await made(s.ctx, { name: "E", price: 500 }),
    };
    const buyer = await createLoginBuyer(s.seller.id, s.grade.id);
    const order = async (name: keyof typeof p, quantity: number, paid: boolean) => {
      const o = await createOrder(db, { sellerId: s.seller.id, buyerMemberId: buyer.id, items: [{ optionId: p[name].options[0].id, quantity }], consent, shippingAddress });
      if (!o.ok) throw new Error(o.reason);
      if (paid) await markOrderPaid(db, { sellerId: s.seller.id, orderId: o.orderId, paymentMethod: "CARD" });
    };
    await order("C", 5, true);
    await order("A", 2, true);
    await order("A", 1, true);
    await order("D", 9, false); // 입금 전 주문은 판매량에 넣지 않는다
    await order("E", 1, true);

    const sales = await listProducts(db, s.ctx, { sort: "sales" });
    if (!sales.ok) throw new Error(sales.reason);
    expect(sales.value.products.map((x) => [x.name, x.soldQuantity])).toEqual([
      ["C", 5],
      ["A", 3],
      ["E", 1],
      ...[["B", 0], ["D", 0]].sort((x, y) => (p[x[0] as "B"].id < p[y[0] as "D"].id ? -1 : 1)),
    ]);
    expect(await allPages(s.ctx, { sort: "sales" })).toEqual(sales.value.products.map((x) => x.name));

    const byIdTie = (x: "A" | "C") => (p.A.id < p.C.id ? (x === "A" ? 0 : 1) : x === "A" ? 1 : 0);
    const priceAsc = ["E", "B", "D", ...(["A", "C"] as const).slice().sort((x, y) => byIdTie(x) - byIdTie(y))];
    expect(await names(s.ctx, { sort: "price_asc" })).toEqual(priceAsc);
    expect(await allPages(s.ctx, { sort: "price_asc" })).toEqual(priceAsc);
    const priceDesc = [...(["A", "C"] as const).slice().sort((x, y) => byIdTie(x) - byIdTie(y)), "D", "B", "E"];
    expect(await allPages(s.ctx, { sort: "price_desc" })).toEqual(priceDesc);

    await db.product.update({ where: { id: p.B.id }, data: { createdAt: new Date("2030-01-01T00:00:00Z") } });
    expect((await allPages(s.ctx, { sort: "newest" }))[0]).toBe("B");
    expect((await allPages(s.ctx, { sort: "newest" })).sort()).toEqual(["A", "B", "C", "D", "E"]);
    // 정렬과 필터를 함께
    expect(await allPages(s.ctx, { sort: "sales", q: "a" })).toEqual(["A"]);
  });
});

describe("선택 일괄 처리", () => {
  it("상태 바꾸기·삭제는 자기 상품만 바꾸고 상품마다 로그 추적을 남기며, 옵션 없는 상품의 판매 중 전환·다른 쇼핑몰 상품은 건너뛴다", async () => {
    const s = await seller();
    const other = await seller();
    const a = await made(s.ctx, { name: "A" });
    const b = await made(s.ctx, { name: "B", status: "DRAFT", options: [] });
    const c = await made(s.ctx, { name: "C", status: "HIDDEN" });
    const x = await made(other.ctx, { name: "X" });

    expect(await bulkProducts(db, s.ctx, { action: "status", status: "HIDDEN", productIds: [a.id, x.id, c.id, a.id] })).toEqual({
      ok: true,
      value: { updated: [a.id, c.id], skipped: [{ productId: x.id, reason: "not_found" }] },
    });
    expect((await db.product.findUniqueOrThrow({ where: { id: x.id } })).status).toBe("ON_SALE");
    // 이미 숨김이던 C는 로그를 남기지 않는다
    expect(await db.auditLog.findMany({ where: { action: "product.update", sellerId: s.seller.id }, select: { targetId: true, before: true, after: true } })).toEqual([
      { targetId: a.id, before: { status: "ON_SALE" }, after: { status: "HIDDEN", bulk: true } },
    ]);

    expect(await bulkProducts(db, s.ctx, { action: "status", status: "ON_SALE", productIds: [b.id, a.id] })).toEqual({
      ok: true,
      value: { updated: [a.id], skipped: [{ productId: b.id, reason: "no_sellable_option" }] },
    });
    expect((await db.product.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("DRAFT");

    expect(await bulkProducts(db, s.ctx, { action: "delete", productIds: [a.id, b.id, x.id] })).toEqual({
      ok: true,
      value: { updated: [a.id, b.id], skipped: [{ productId: x.id, reason: "not_found" }] },
    });
    expect(await names(s.ctx, {})).toEqual(["C"]);
    expect(await db.product.findUniqueOrThrow({ where: { id: x.id } })).toMatchObject({ deletedAt: null });
    expect(await db.auditLog.count({ where: { action: "product.delete", sellerId: s.seller.id } })).toBe(2);
    // 지운 상품은 다시 처리할 수 없다
    expect(await bulkProducts(db, s.ctx, { action: "status", status: "HIDDEN", productIds: [a.id] })).toEqual({
      ok: true,
      value: { updated: [], skipped: [{ productId: a.id, reason: "not_found" }] },
    });

    for (const body of [
      {},
      { action: "status", productIds: [c.id] },
      { action: "status", status: "GONE", productIds: [c.id] },
      { action: "delete", productIds: [] },
      { action: "delete", productIds: ["not-a-uuid"] },
      { action: "delete", productIds: Array.from({ length: 201 }, () => c.id) },
      { action: "hide", productIds: [c.id] },
    ]) {
      expect(await bulkProducts(db, s.ctx, body)).toEqual({ ok: false, reason: "invalid_bulk" });
    }
    // 조회 전용(마스터 대리 조회)은 바꿀 수 없다
    await expect(bulkProducts(db, { ...s.ctx, readOnly: true }, { action: "delete", productIds: [c.id] })).rejects.toMatchObject({ status: 403 });
  });

  it("HTTP: 권한 없는 직원 403, 다른 출처 403, 잘못된 요청은 400과 문구, 목록 검색 오류도 문구", async () => {
    const s = await seller();
    const p = await made(s.ctx);
    const broadcaster = await createSellerUser(s.seller.id, "BROADCASTER");
    const cookie = async (email: string) => {
      const r = await loginSeller(db, { email, password: PASSWORD }, {});
      if (!r.ok) throw new Error(r.reason);
      return `lo_seller=${r.token}`;
    };
    const owner = await cookie(s.owner.email);
    const post = (c: string, body: unknown, headers: Record<string, string> = H) =>
      bulkRoute(new Request("http://localhost:3000/api/seller/products/bulk", { method: "POST", headers: { ...headers, cookie: c }, body: JSON.stringify(body) }));

    expect((await post(await cookie(broadcaster.email), { action: "delete", productIds: [p.id] })).status).toBe(403);
    expect((await post(owner, { action: "delete", productIds: [p.id] }, { ...H, origin: "http://evil.example" })).status).toBe(403);
    const bad = await post(owner, { action: "delete", productIds: [] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_bulk", message: ORDER_ERROR_MESSAGES_FORMAL.invalid_bulk });
    const ok = await post(owner, { action: "status", status: "SOLD_OUT", productIds: [p.id] });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ updated: [p.id], skipped: [] });

    const list = (qs: string) => listRoute(new Request(`http://localhost:3000/api/seller/products?${qs}`, { headers: { ...H, cookie: owner } }));
    const r = await list("sort=sales&display=shown&code=&createdFrom=2026-01-01");
    expect(r.status).toBe(200);
    expect((await r.json()).products).toMatchObject([{ id: p.id, status: "SOLD_OUT", soldQuantity: 0 }]);
    const wrong = await list("createdFrom=2026-13-01");
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: "invalid_date_range", message: ORDER_ERROR_MESSAGES_FORMAL.invalid_date_range });
  });
});
