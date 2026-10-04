import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PUT as recommendedPut } from "../../app/api/seller/display/recommended/route";
import { GET as displayGet } from "../../app/api/seller/display/route";
import { GET as homeRoute } from "../../app/api/shop/[slug]/home/route";
import { GET as listRoute } from "../../app/api/shop/[slug]/products/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { ORDER_ERROR_MESSAGES_FORMAL } from "../../lib/server/orders/messages";
import { createProduct, deleteProduct, updateProduct } from "../../lib/server/products/manage";
import { createCategory, deleteCategory, setProductCategories, updateCategory } from "../../lib/server/shop-category/service";
import { MAX_RECOMMENDED, getDisplay, setListSort, setRecommended, setSections } from "../../lib/server/shop-display/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 상품 진열 SA-016: 목록 기본 정렬, 홈 진열 영역, 추천 상품, 구매자 홈
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" };

async function seller() {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, owner, ctx };
}
async function made(ctx: TenantContext, name: string, body: Record<string, unknown> = {}) {
  const r = await createProduct(db, ctx, { name, price: 1000, status: "ON_SALE", options: [{ name: "o", stock: 3 }], ...body });
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}
const home = async (slug: string) => {
  const res = await homeRoute(new Request("http://localhost:3000/x"), { params: Promise.resolve({ slug }) });
  return { status: res.status, body: await res.json() };
};
const titles = (b: { sections: { title: string; products: { name: string }[] }[] }) => b.sections.map((s) => [s.title, s.products.map((p) => p.name)]);

describe("진열 설정", () => {
  it("저장 전에는 기본 영역(추천 → 신상품)이고, 추천 상품·영역·기본 정렬을 통째로 바꾸며 로그 추적을 남긴다", async () => {
    const s = await seller();
    const a = await made(s.ctx, "A");
    const b = await made(s.ctx, "B");
    await db.product.update({ where: { id: a.id }, data: { createdAt: new Date("2026-01-01T00:00:00Z") } });
    expect(await getDisplay(db, s.ctx)).toMatchObject({ listSort: "new", sections: [{ kind: "RECOMMENDED", title: "추천 상품" }, { kind: "NEW", title: "신상품" }], recommended: [] });
    // 추천이 비어 있으면 그 영역은 빠진다
    expect(titles((await home(s.seller.slug)).body)).toEqual([["신상품", ["B", "A"]]]);

    const rec = await setRecommended(db, s.ctx, { productIds: [a.id, b.id] });
    expect(rec).toMatchObject({ ok: true, value: { recommended: [{ productId: a.id, code: "P0000001", name: "A" }, { productId: b.id, name: "B" }] } });
    const cat = await createCategory(db, s.ctx, { name: "카드" });
    if (!cat.ok) throw new Error(cat.reason);
    await setProductCategories(db, s.ctx, b.id, { categoryIds: [cat.value[0].id] });
    const sec = await setSections(db, s.ctx, {
      sections: [
        { kind: "CATEGORY", categoryId: cat.value[0].id, title: "카드 모음", itemCount: 4 },
        { kind: "NEW", title: "새로 들어왔어요", itemCount: 1 },
        { kind: "RECOMMENDED", title: "추천", visible: false },
      ],
    });
    expect(sec).toMatchObject({ ok: true });
    expect(titles((await home(s.seller.slug)).body)).toEqual([
      ["카드 모음", ["B"]],
      ["새로 들어왔어요", ["B"]],
    ]);
    expect(await setListSort(db, s.ctx, { listSort: "low" })).toMatchObject({ ok: true, value: { listSort: "low" } });
    expect((await home(s.seller.slug)).body.listSort).toBe("low");
    expect(await db.auditLog.count({ where: { sellerId: s.seller.id, action: { startsWith: "shop_display." } } })).toBe(3);

    // 카테고리를 끄면 그 영역은 빠지고, 지우면 영역도 지워진다
    await updateCategory(db, s.ctx, cat.value[0].id, { visible: false });
    expect(titles((await home(s.seller.slug)).body)).toEqual([["새로 들어왔어요", ["B"]]]);
    await setProductCategories(db, s.ctx, b.id, { categoryIds: [] });
    await deleteCategory(db, s.ctx, cat.value[0].id);
    expect((await getDisplay(db, s.ctx)).sections.map((x) => x.kind)).toEqual(["NEW", "RECOMMENDED"]);
  });

  it("추천 상품: 보이는 상품만 순서대로, 지운·숨긴 상품은 구매자 홈에서 빠지고, 남의 상품·지운 상품·중복·21개는 저장하지 않는다", async () => {
    const s = await seller();
    const other = await seller();
    const ids = [];
    for (const n of ["A", "B", "C"]) ids.push((await made(s.ctx, n)).id);
    const x = await made(other.ctx, "X");
    await setRecommended(db, s.ctx, { productIds: [ids[2], ids[0], ids[1]] });
    await setSections(db, s.ctx, { sections: [{ kind: "RECOMMENDED", title: "추천", itemCount: 2 }] });
    expect(titles((await home(s.seller.slug)).body)).toEqual([["추천", ["C", "A"]]]);
    await updateProduct(db, s.ctx, ids[2], { status: "HIDDEN" });
    expect(titles((await home(s.seller.slug)).body)).toEqual([["추천", ["A", "B"]]]);
    await deleteProduct(db, s.ctx, ids[0]);
    expect(titles((await home(s.seller.slug)).body)).toEqual([["추천", ["B"]]]);
    expect((await getDisplay(db, s.ctx)).recommended.map((r) => [r.name, r.deleted])).toEqual([
      ["C", false],
      ["A", true],
      ["B", false],
    ]);

    for (const productIds of [[x.id], [ids[0]], [ids[1], ids[1]], ["nope"], Array.from({ length: MAX_RECOMMENDED + 1 }, () => ids[1]), "x"]) {
      expect(await setRecommended(db, s.ctx, { productIds })).toEqual({ ok: false, reason: "invalid_display_settings" });
    }
    expect((await getDisplay(db, s.ctx)).recommended).toHaveLength(3); // 실패하면 그대로
  });

  it("영역 검사: 추천·신상품 둘 이상, 카테고리 없는 카테고리 영역·남의 카테고리, 제목·개수 밖, 11개는 거부. 기본 정렬 값 검사, 조회 전용·남의 쇼핑몰", async () => {
    const s = await seller();
    const other = await seller();
    const oc = await createCategory(db, other.ctx, { name: "남의 것" });
    if (!oc.ok) throw new Error(oc.reason);
    for (const sections of [
      [{ kind: "NEW", title: "a" }, { kind: "NEW", title: "b" }],
      [{ kind: "RECOMMENDED", title: "a" }, { kind: "RECOMMENDED", title: "b" }],
      [{ kind: "CATEGORY", title: "a" }],
      [{ kind: "NEW", title: "a", categoryId: oc.value[0].id }],
      [{ kind: "CATEGORY", title: "a", categoryId: oc.value[0].id }],
      [{ kind: "NEW", title: "" }],
      [{ kind: "NEW", title: "가".repeat(31) }],
      [{ kind: "NEW", title: "a", itemCount: 0 }],
      [{ kind: "NEW", title: "a", itemCount: 21 }],
      [{ kind: "BANNER", title: "a" }],
      Array.from({ length: 11 }, () => ({ kind: "NEW", title: "a" })),
    ]) {
      expect(await setSections(db, s.ctx, { sections }), JSON.stringify(sections).slice(0, 80)).toEqual({ ok: false, reason: "invalid_display_settings" });
    }
    expect(await setSections(db, s.ctx, { sections: [] })).toMatchObject({ ok: true, value: { sections: [{ kind: "RECOMMENDED" }, { kind: "NEW" }] } }); // 비우면 기본
    expect(await setListSort(db, s.ctx, { listSort: "name" })).toEqual({ ok: false, reason: "invalid_display_settings" });
    await expect(setRecommended(db, { ...s.ctx, readOnly: true }, { productIds: [] })).rejects.toMatchObject({ status: 403 });
    await expect(setSections(db, { ...s.ctx, readOnly: true }, { sections: [] })).rejects.toMatchObject({ status: 403 });
    expect(await getDisplay(db, { ...s.ctx, readOnly: true })).toMatchObject({ listSort: "new" });
    expect(await getDisplay(db, other.ctx)).toMatchObject({ recommended: [] });
  });
});

describe("구매자 쪽", () => {
  it("목록에서 정렬을 고르지 않으면 판매자가 정한 기본 정렬, 운영 중이 아닌 쇼핑몰 홈은 404", async () => {
    const s = await seller();
    await made(s.ctx, "비싼", { price: 9000 });
    await made(s.ctx, "싼", { price: 100 });
    const names = async () => {
      const res = await listRoute(new Request(`http://localhost:3000/api/shop/${s.seller.slug}/products`), { params: Promise.resolve({ slug: s.seller.slug }) });
      return (await res.json()).products.map((p: { name: string }) => p.name);
    };
    expect(await names()).toEqual(["싼", "비싼"]); // new: 나중에 만든 것 먼저
    await setListSort(db, s.ctx, { listSort: "high" });
    expect(await names()).toEqual(["비싼", "싼"]);
    expect((await home("no-such-shop")).status).toBe(404);
    await db.seller.update({ where: { id: s.seller.id }, data: { status: "SUSPENDED" } });
    expect((await home(s.seller.slug)).status).toBe(404);
  });

  it("HTTP: 권한 없는 직원 403, 다른 출처 403, 잘못된 본문 400과 문구", async () => {
    const s = await seller();
    const p = await made(s.ctx, "A");
    const cookie = async (email: string) => {
      const r = await loginSeller(db, { email, password: PASSWORD }, {});
      if (!r.ok) throw new Error(r.reason);
      return `lo_seller=${r.token}`;
    };
    const owner = await cookie(s.owner.email);
    const broadcaster = await cookie((await createSellerUser(s.seller.id, "BROADCASTER")).email);
    const put = (body: unknown, c = owner, headers: Record<string, string> = H) =>
      recommendedPut(new Request("http://localhost:3000/api/seller/display/recommended", { method: "PUT", headers: { ...headers, cookie: c }, body: JSON.stringify(body) }));
    expect((await displayGet(new Request("http://localhost:3000/x", { headers: { ...H, cookie: broadcaster } }))).status).toBe(403);
    expect((await put({ productIds: [p.id] }, broadcaster)).status).toBe(403);
    expect((await put({ productIds: [p.id] }, owner, { ...H, origin: "http://evil.example" })).status).toBe(403);
    const bad = await put({ productIds: ["x"] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_display_settings", message: ORDER_ERROR_MESSAGES_FORMAL.invalid_display_settings });
    const ok = await put({ productIds: [p.id] });
    expect(ok.status).toBe(200);
    expect((await ok.json()).recommended).toMatchObject([{ productId: p.id }]);
  });
});
