import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DELETE as categoryDelete, PATCH as categoryPatch } from "../../app/api/seller/categories/[categoryId]/route";
import { PUT as orderRoute } from "../../app/api/seller/categories/order/route";
import { GET as categoriesGet, POST as categoriesPost } from "../../app/api/seller/categories/route";
import { GET as productCategoriesGet, PUT as productCategoriesPut } from "../../app/api/seller/products/[productId]/categories/route";
import { GET as shopCategories } from "../../app/api/shop/[slug]/categories/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { ORDER_ERROR_MESSAGES_FORMAL } from "../../lib/server/orders/messages";
import { createProduct, deleteProduct, listProducts } from "../../lib/server/products/manage";
import {
  MAX_CATEGORIES,
  createCategory,
  deleteCategory,
  listCategories,
  productCategoryIds,
  publicCategories,
  reorderCategories,
  setProductCategories,
  updateCategory,
  type CategoryNode,
} from "../../lib/server/shop-category/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 카테고리 SA-015: 2단 CRUD·순서·노출·상품 지정, 구매자 쇼핑몰 카테고리 메뉴
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };

async function seller() {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, owner, ctx };
}

async function add(ctx: TenantContext, body: Record<string, unknown>): Promise<CategoryNode[]> {
  const r = await createCategory(db, ctx, body);
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}
const find = (tree: CategoryNode[], name: string) => {
  for (const p of tree) {
    if (p.name === name) return p;
    const c = p.children.find((x) => x.name === name);
    if (c) return c;
  }
  throw new Error(name);
};
const shape = (tree: CategoryNode[]) => tree.map((p) => [p.name, p.children.map((c) => c.name)]);

async function product(ctx: TenantContext, name: string) {
  const r = await createProduct(db, ctx, { name, price: 1000, status: "ON_SALE", options: [{ name: "o", stock: 1 }] });
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}

describe("카테고리 만들기·고치기·지우기·순서", () => {
  it("2단까지 만들고 맨 뒤에 붙이며, 소분류 아래·다른 판매자 부모·잘못된 이름은 거부하고 로그 추적을 남긴다", async () => {
    const s = await seller();
    const other = await seller();
    await add(s.ctx, { name: "카드" });
    let tree = await add(s.ctx, { name: "피규어", visible: false });
    const card = find(tree, "카드");
    await add(s.ctx, { name: "포켓몬", parentId: card.id });
    tree = await add(s.ctx, { name: "유희왕", parentId: card.id });
    expect(shape(tree)).toEqual([
      ["카드", ["포켓몬", "유희왕"]],
      ["피규어", []],
    ]);
    expect(tree.map((p) => [p.sortOrder, p.visible])).toEqual([
      [0, true],
      [1, false],
    ]);

    const poke = find(tree, "포켓몬");
    expect(await createCategory(db, s.ctx, { name: "3단", parentId: poke.id })).toEqual({ ok: false, reason: "invalid_category" });
    await expect(createCategory(db, other.ctx, { name: "남의 것", parentId: card.id })).rejects.toMatchObject({ status: 404 });
    for (const body of [{}, { name: "" }, { name: "가".repeat(31) }, { name: "a\tb" }, { name: "x", visible: "yes" }, { name: "x", parentId: "nope" }]) {
      expect(await createCategory(db, s.ctx, body)).toEqual({ ok: false, reason: "invalid_category" });
    }
    expect(await listCategories(db, other.ctx)).toEqual([]);
    expect(await db.auditLog.count({ where: { action: "shop_category.create", sellerId: s.seller.id } })).toBe(4);

    // 이름·노출 바꾸기, 다른 판매자는 404
    expect(await updateCategory(db, s.ctx, poke.id, { name: "포켓몬 카드", visible: false })).toMatchObject({ ok: true });
    expect(find(await listCategories(db, s.ctx), "포켓몬 카드")).toMatchObject({ visible: false });
    await expect(updateCategory(db, other.ctx, poke.id, { name: "x" })).rejects.toMatchObject({ status: 404 });
    expect(await updateCategory(db, s.ctx, poke.id, {})).toEqual({ ok: false, reason: "invalid_category" });

    // 하위가 있는 대분류는 지우지 않고, 소분류를 지우면 남은 형제 순서를 다시 매긴다
    expect(await deleteCategory(db, s.ctx, card.id)).toEqual({ ok: false, reason: "category_has_children" });
    await expect(deleteCategory(db, other.ctx, poke.id)).rejects.toMatchObject({ status: 404 });
    const del = await deleteCategory(db, s.ctx, poke.id);
    if (!del.ok) throw new Error(del.reason);
    expect(find(del.value, "유희왕").sortOrder).toBe(0);
  });

  it("순서 바꾸기는 그 부모의 카테고리 전부를 보내야 하고, 빠지거나 남의 것이 섞이면 거부한다", async () => {
    const s = await seller();
    const other = await seller();
    for (const name of ["A", "B", "C"]) await add(s.ctx, { name });
    const x = find(await add(other.ctx, { name: "X" }), "X");
    const [a, b, c] = (await listCategories(db, s.ctx)).map((n) => n.id);
    const r = await reorderCategories(db, s.ctx, { parentId: null, categoryIds: [c, a, b] });
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.map((n) => [n.name, n.sortOrder])).toEqual([
      ["C", 0],
      ["A", 1],
      ["B", 2],
    ]);
    for (const categoryIds of [[a, b], [a, b, c, x.id], [a, a, b, c], [a, b, "nope"]]) {
      expect(await reorderCategories(db, s.ctx, { parentId: null, categoryIds })).toEqual({ ok: false, reason: "invalid_category_order" });
    }
    await expect(reorderCategories(db, s.ctx, { parentId: x.id, categoryIds: [] })).rejects.toMatchObject({ status: 404 });
    expect(shape(await listCategories(db, other.ctx))).toEqual([["X", []]]);
  });

  it(`카테고리는 판매자마다 ${MAX_CATEGORIES}개까지`, async () => {
    const s = await seller();
    await db.shopCategory.createMany({ data: Array.from({ length: MAX_CATEGORIES }, (_, i) => ({ sellerId: s.seller.id, name: `c${i}`, sortOrder: i })) });
    expect(await createCategory(db, s.ctx, { name: "넘침" })).toEqual({ ok: false, reason: "too_many_categories" });
  });
});

describe("상품에 카테고리 지정", () => {
  it("목록을 통째로 바꾸고, 남의 카테고리·없는 카테고리·지운 상품·11개 이상은 거부하며, 상품 목록을 카테고리(하위 포함)로 거른다", async () => {
    const s = await seller();
    const other = await seller();
    const card = find(await add(s.ctx, { name: "카드" }), "카드");
    const poke = find(await add(s.ctx, { name: "포켓몬", parentId: card.id }), "포켓몬");
    const fig = find(await add(s.ctx, { name: "피규어" }), "피규어");
    const x = find(await add(other.ctx, { name: "X" }), "X");
    const p1 = await product(s.ctx, "팩");
    const p2 = await product(s.ctx, "박스");
    const p3 = await product(s.ctx, "인형");

    expect(await setProductCategories(db, s.ctx, p1.id, { categoryIds: [poke.id, card.id] })).toEqual({ ok: true, value: [card.id, poke.id] });
    expect(await setProductCategories(db, s.ctx, p2.id, { categoryIds: [card.id] })).toMatchObject({ ok: true });
    expect(await setProductCategories(db, s.ctx, p3.id, { categoryIds: [fig.id] })).toMatchObject({ ok: true });
    expect(await setProductCategories(db, s.ctx, p1.id, { categoryIds: [poke.id] })).toEqual({ ok: true, value: [poke.id] });
    expect(await productCategoryIds(db, s.ctx, p1.id)).toEqual([poke.id]);

    expect(await setProductCategories(db, s.ctx, p1.id, { categoryIds: [x.id] })).toEqual({ ok: false, reason: "invalid_category" });
    expect(await setProductCategories(db, s.ctx, p1.id, { categoryIds: [card.id, "00000000-0000-0000-0000-000000000000"] })).toEqual({ ok: false, reason: "invalid_category" });
    expect(await productCategoryIds(db, s.ctx, p1.id)).toEqual([poke.id]); // 실패하면 하나도 바꾸지 않는다
    expect(await setProductCategories(db, s.ctx, p1.id, { categoryIds: "x" })).toEqual({ ok: false, reason: "invalid_category" });
    const many = await db.shopCategory.createManyAndReturn({ data: Array.from({ length: 11 }, (_, i) => ({ sellerId: s.seller.id, name: `m${i}`, sortOrder: 10 + i })) });
    expect(await setProductCategories(db, s.ctx, p1.id, { categoryIds: many.map((m) => m.id) })).toEqual({ ok: false, reason: "too_many_product_categories" });
    await expect(setProductCategories(db, other.ctx, p1.id, { categoryIds: [] })).rejects.toMatchObject({ status: 404 });

    const names = async (categoryId: string) => {
      const r = await listProducts(db, s.ctx, { categoryId });
      if (!r.ok) throw new Error(r.reason);
      return r.value.products.map((p) => p.name).sort();
    };
    expect(await names(card.id)).toEqual(["박스", "팩"]); // 대분류는 소분류에 지정한 상품도
    expect(await names(poke.id)).toEqual(["팩"]);
    expect(await names(fig.id)).toEqual(["인형"]);
    expect(await listProducts(db, s.ctx, { categoryId: x.id })).toEqual({ ok: false, reason: "invalid_category" });
    expect(await listProducts(db, s.ctx, { categoryId: "nope" })).toEqual({ ok: false, reason: "invalid_category" });

    // 상품 수는 지우지 않은 상품만, 카테고리를 지우면 연결도 지워진다(상품은 그대로)
    expect(find(await listCategories(db, s.ctx), "카드").productCount).toBe(1);
    await deleteProduct(db, s.ctx, p2.id);
    expect(find(await listCategories(db, s.ctx), "카드").productCount).toBe(0);
    await expect(setProductCategories(db, s.ctx, p2.id, { categoryIds: [] })).rejects.toMatchObject({ status: 404 });
    await deleteCategory(db, s.ctx, fig.id);
    expect(await productCategoryIds(db, s.ctx, p3.id)).toEqual([]);
    expect(await db.product.count({ where: { id: p3.id, deletedAt: null } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "product.categories", sellerId: s.seller.id } })).toBe(4);

    // 조회 전용(마스터 대리 조회)은 읽기만
    const ro = { ...s.ctx, readOnly: true };
    expect(await productCategoryIds(db, ro, p1.id)).toEqual([poke.id]);
    await expect(setProductCategories(db, ro, p1.id, { categoryIds: [] })).rejects.toMatchObject({ status: 403 });
    await expect(createCategory(db, ro, { name: "x" })).rejects.toMatchObject({ status: 403 });
  });
});

describe("구매자 쇼핑몰 카테고리", () => {
  it("보이는 대분류와 그 아래 보이는 소분류만 순서대로, 운영 중이 아닌 쇼핑몰·없는 쇼핑몰은 404", async () => {
    const s = await seller();
    const card = find(await add(s.ctx, { name: "카드" }), "카드");
    await add(s.ctx, { name: "포켓몬", parentId: card.id });
    await add(s.ctx, { name: "숨긴 소분류", parentId: card.id, visible: false });
    const fig = find(await add(s.ctx, { name: "피규어" }), "피규어");
    await add(s.ctx, { name: "꺼진 대분류 아래", parentId: fig.id });
    await updateCategory(db, s.ctx, fig.id, { visible: false });

    const get = (slug: string) => shopCategories(new Request(`http://localhost:3000/api/shop/${slug}/categories`), { params: Promise.resolve({ slug }) });
    const r = await get(s.seller.slug);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ categories: [{ id: card.id, name: "카드", children: [{ id: expect.any(String), name: "포켓몬" }] }] });
    expect((await get("no-such-shop")).status).toBe(404);
    await db.seller.update({ where: { id: s.seller.id }, data: { status: "SUSPENDED" } });
    expect(await publicCategories(db, s.seller.slug)).toBeNull();
    expect((await get(s.seller.slug)).status).toBe(404);
  });
});

describe("HTTP", () => {
  it("권한 없는 직원 403, 다른 출처 403, 다른 판매자 404, 오류 문구", async () => {
    const s = await seller();
    const other = await seller();
    const broadcaster = await createSellerUser(s.seller.id, "BROADCASTER");
    const cookie = async (email: string) => {
      const r = await loginSeller(db, { email, password: PASSWORD }, {});
      if (!r.ok) throw new Error(r.reason);
      return `lo_seller=${r.token}`;
    };
    const owner = await cookie(s.owner.email);
    const otherOwner = await cookie((await createSellerUser(other.seller.id, "OWNER", "other-owner@example.com")).email);
    const req = (path: string, method: string, c: string, body?: unknown, headers = H) =>
      new Request(`http://localhost:3000${path}`, { method, headers: { ...headers, cookie: c }, body: body === undefined ? undefined : JSON.stringify(body) });

    expect((await categoriesGet(req("/api/seller/categories", "GET", await cookie(broadcaster.email)))).status).toBe(403);
    expect((await categoriesPost(req("/api/seller/categories", "POST", owner, { name: "카드" }, { ...H, origin: "http://evil.example" }))).status).toBe(403);
    const created = await categoriesPost(req("/api/seller/categories", "POST", owner, { name: "카드" }));
    expect(created.status).toBe(201);
    const [card] = (await created.json()).categories;
    expect((await categoriesPost(req("/api/seller/categories", "POST", owner, { name: "포켓몬", parentId: card.id }))).status).toBe(201);
    const bad = await categoriesPost(req("/api/seller/categories", "POST", owner, { name: "" }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_category", message: ORDER_ERROR_MESSAGES_FORMAL.invalid_category });

    const p = (categoryId: string) => ({ params: Promise.resolve({ categoryId }) });
    expect((await categoryPatch(req("/x", "PATCH", otherOwner, { name: "x" }), p(card.id))).status).toBe(404);
    expect((await categoryPatch(req("/x", "PATCH", owner, { visible: false }), p(card.id))).status).toBe(200);
    const blocked = await categoryDelete(req("/x", "DELETE", owner), p(card.id));
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: "category_has_children", message: ORDER_ERROR_MESSAGES_FORMAL.category_has_children });
    const stale = await orderRoute(req("/api/seller/categories/order", "PUT", owner, { parentId: null, categoryIds: [] }));
    expect(stale.status).toBe(409);

    const prod = await product(s.ctx, "팩");
    const pp = { params: Promise.resolve({ productId: prod.id }) };
    const put = await productCategoriesPut(req(`/api/seller/products/${prod.id}/categories`, "PUT", owner, { categoryIds: [card.id] }), pp);
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ categoryIds: [card.id] });
    expect(await (await productCategoriesGet(req("/x", "GET", owner), pp)).json()).toEqual({ categoryIds: [card.id] });
    expect((await productCategoriesGet(req("/x", "GET", otherOwner), pp)).status).toBe(404);
  });
});
