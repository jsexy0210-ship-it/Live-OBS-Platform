import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as optionsRoute } from "../../app/api/seller/products/options/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { ORDER_ERROR_MESSAGES, ORDER_ERROR_MESSAGES_FORMAL } from "../../lib/server/orders/messages";
import { createProduct, deleteOption, deleteProduct } from "../../lib/server/products/manage";
import { listOptionStock } from "../../lib/server/products/optionStock";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

async function seller() {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, owner, ctx };
}

async function made(ctx: TenantContext, name: string, options: { name: string; stock: number }[], extra: Record<string, unknown> = {}) {
  const r = await createProduct(db, ctx, { name, price: 5000, status: "ON_SALE", options, ...extra });
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}

const labels = (r: Awaited<ReturnType<typeof listOptionStock>>) => (r.ok ? r.value.options.map((o) => `${o.productName}/${o.optionName}`) : r.reason);

describe("옵션 단위 재고 목록", () => {
  it("재고 조건은 옵션마다 본다: 상품 합계가 넉넉해도 재고 0·적은 옵션이 나오고, 지운 상품·옵션과 다른 쇼핑몰은 빠진다", async () => {
    const s = await seller();
    const other = await seller();
    await made(s.ctx, "포켓몬", [{ name: "박스", stock: 50 }, { name: "팩", stock: 0 }, { name: "카드", stock: 3 }], { sortOrder: 0 });
    await made(s.ctx, "원피스", [{ name: "박스", stock: 5 }, { name: "팩", stock: 6 }], { sortOrder: 1 });
    const gone = await made(s.ctx, "디지몬", [{ name: "팩", stock: 0 }, { name: "박스", stock: 9 }], { sortOrder: 2 });
    await deleteOption(db, s.ctx, gone.id, gone.options.find((o) => o.name === "팩")!.id);
    const removed = await made(s.ctx, "유희왕", [{ name: "팩", stock: 0 }], { sortOrder: 3 });
    await deleteProduct(db, s.ctx, removed.id);
    await made(other.ctx, "다른 쇼핑몰", [{ name: "팩", stock: 0 }]);
    expect(labels(await listOptionStock(db, s.ctx, { stock: "out" }))).toEqual(["포켓몬/팩"]);
    expect(labels(await listOptionStock(db, s.ctx, { stock: "low" }))).toEqual(["포켓몬/카드", "원피스/박스"]);
    expect(labels(await listOptionStock(db, s.ctx))).toEqual(["포켓몬/박스", "포켓몬/팩", "포켓몬/카드", "원피스/박스", "원피스/팩", "디지몬/박스"]);
    const first = await listOptionStock(db, s.ctx, { stock: "out" });
    expect(first.ok && first.value.options[0]).toMatchObject({ productStatus: "ON_SALE", stock: 0, sku: null });
  });

  it("q는 상품 이름이나 그 옵션 이름에서 찾고, status·stock과 함께 쓴다", async () => {
    const s = await seller();
    await made(s.ctx, "포켓몬", [{ name: "박스", stock: 0 }, { name: "팩", stock: 2 }], { sortOrder: 0 });
    await made(s.ctx, "원피스", [{ name: "포켓몬 콜라보", stock: 0 }, { name: "팩", stock: 0 }], { sortOrder: 1 });
    await made(s.ctx, "숨긴 포켓몬", [{ name: "팩", stock: 0 }], { sortOrder: 2, status: "HIDDEN" });
    expect(labels(await listOptionStock(db, s.ctx, { q: "포켓몬" }))).toEqual(["포켓몬/박스", "포켓몬/팩", "원피스/포켓몬 콜라보", "숨긴 포켓몬/팩"]);
    expect(labels(await listOptionStock(db, s.ctx, { q: "포켓몬", stock: "out", status: "ON_SALE" }))).toEqual(["포켓몬/박스", "원피스/포켓몬 콜라보"]);
  });

  it("커서로 끝까지 넘기면 빠짐·겹침 없이 모두 나오고(같은 상품의 옵션이 쪽을 넘어가도), 기준 옵션을 지워도 이어진다", async () => {
    const s = await seller();
    for (let i = 0; i < 4; i++) await made(s.ctx, `상품${i}`, [{ name: "가", stock: 0 }, { name: "나", stock: 0 }, { name: "다", stock: 0 }], { sortOrder: i % 2 });
    const all = await listOptionStock(db, s.ctx, { limit: 200 });
    const expected = all.ok ? all.value.options.map((o) => o.optionId) : [];
    expect(expected).toHaveLength(12);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await listOptionStock(db, s.ctx, { stock: "out", limit: 5, cursor });
      if (!r.ok) throw new Error(r.reason);
      seen.push(...r.value.options.map((o) => o.optionId));
      if (!r.value.nextCursor) break;
      cursor = r.value.nextCursor;
      if (page === 0) {
        // 기준 옵션(쪽의 마지막)을 지워도 다음 쪽은 이어진다
        const last = r.value.options[r.value.options.length - 1];
        await deleteOption(db, s.ctx, last.productId, last.optionId);
        expected.splice(expected.indexOf(last.optionId), 1);
        seen.pop();
      }
    }
    expect(seen).toEqual(expected);
  });

  it("잘못된 조건·커서·limit은 400과 문구(HTTP), 다른 쇼핑몰 옵션 id 커서는 거부, 상품 권한 없는 직원은 403", async () => {
    const s = await seller();
    const other = await seller();
    const otherProduct = await made(other.ctx, "남의 상품", [{ name: "팩", stock: 0 }]);
    const login = await loginSeller(db, { email: s.owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    const get = (qs: string, cookie = `lo_seller=${login.token}`) =>
      optionsRoute(new Request(`http://localhost:3000/api/seller/products/options?${qs}`, { headers: { host: "localhost:3000", cookie } }));
    for (const [qs, code] of [
      ["stock=zero", "invalid_stock_filter"],
      ["limit=0", "invalid_limit"],
      ["limit=201", "invalid_limit"],
      ["cursor=x", "invalid_cursor"],
      [`cursor=${otherProduct.options[0].id}`, "invalid_cursor"],
      [`q=${encodeURIComponent("\t")}`, "invalid_search"],
      [`q=${"가".repeat(51)}`, "invalid_search"],
    ] as const) {
      const r = await get(qs);
      expect(r.status, qs).toBe(400);
      expect(await r.json()).toEqual({ error: code, message: ORDER_ERROR_MESSAGES_FORMAL[code] });
    }
    const ok = await get("stock=out&limit=10");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toContain("no-store");
    expect(await ok.json()).toEqual({ options: [], nextCursor: null });
    const staff = await createSellerUser(s.seller.id, { permissions: ["ORDER_SHIPPING"] });
    const staffLogin = await loginSeller(db, { email: staff.email, password: PASSWORD }, {});
    if (!staffLogin.ok) throw new Error(staffLogin.reason);
    expect((await get("stock=out", `lo_seller=${staffLogin.token}`)).status).toBe(403);
  });
});
