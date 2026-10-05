import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as imagesPost } from "../../app/api/seller/products/[productId]/images/route";
import { PUT as thumbnailPut } from "../../app/api/seller/products/[productId]/images/thumbnail/route";
import { GET as shopList } from "../../app/api/shop/[slug]/products/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { MAX_PRODUCT_IMAGES, PRODUCT_IMAGE_MESSAGES, deleteProductImage, reorderProductImages, setProductThumbnail, uploadProductImage } from "../../lib/server/products/images";
import { createProduct, getProduct, listProducts } from "../../lib/server/products/manage";
import type { TenantContext } from "../../lib/server/tenant/context";
import { png } from "../unit/shopContentFixtures";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 상품 이미지 5장 제한과 썸네일 지정(지정이 없으면 첫 번째)
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { host: "localhost:3000", origin: "http://localhost:3000" };

async function seller() {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, owner, ctx };
}
async function product(ctx: TenantContext, name = "팩") {
  const r = await createProduct(db, ctx, { name, price: 1000, status: "ON_SALE", options: [{ name: "o", stock: 1 }] });
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}
async function upload(ctx: TenantContext, productId: string, n: number, kind: "GALLERY" | "DETAIL" = "GALLERY") {
  const r = await uploadProductImage(db, ctx, productId, png(200, 150 + n), {}, kind);
  if (!r.ok) throw new Error(r.reason);
  return r.image;
}
const gallery = async (ctx: TenantContext, productId: string) => (await getProduct(db, ctx, productId)).images;
const thumbOf = (images: { id: string; isThumbnail: boolean }[]) => images.filter((i) => i.isThumbnail).map((i) => i.id);
const sellerThumb = async (ctx: TenantContext) => {
  const r = await listProducts(db, ctx);
  if (!r.ok) throw new Error(r.reason);
  return Object.fromEntries(r.value.products.map((p) => [p.name, p.thumbnailUrl]));
};

describe("이미지 5장 제한", () => {
  it(`${MAX_PRODUCT_IMAGES}장까지 올리고 6번째는 400 image_limit(문구 포함), 상세 사진은 따로 센다`, async () => {
    expect(MAX_PRODUCT_IMAGES).toBe(5);
    const s = await seller();
    const p = await product(s.ctx);
    for (let i = 0; i < 5; i++) await upload(s.ctx, p.id, i);
    expect(await uploadProductImage(db, s.ctx, p.id, png(200, 150))).toEqual({ ok: false, reason: "image_limit" });
    expect(await uploadProductImage(db, s.ctx, p.id, png(200, 150), {}, "DETAIL")).toMatchObject({ ok: true });
    expect(await db.storedImage.count({ where: { sellerId: s.seller.id } })).toBe(6);
    // 라우트: 400 + 안내 문구
    const login = await loginSeller(db, { email: s.owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    const res = await imagesPost(new Request(`http://localhost:3000/api/seller/products/${p.id}/images`, { method: "POST", headers: { ...H, cookie: `lo_seller=${login.token}` }, body: Uint8Array.from(png(300, 300)) }), { params: Promise.resolve({ productId: p.id }) });
    expect([res.status, await res.json()]).toEqual([400, { error: "image_limit", message: PRODUCT_IMAGE_MESSAGES.image_limit }]);
    expect(PRODUCT_IMAGE_MESSAGES.image_limit).toContain("5장까지");
  });

  it("같은 상품에 동시에 올려도 5장을 넘지 않는다", async () => {
    const s = await seller();
    const p = await product(s.ctx);
    for (let i = 0; i < 3; i++) await upload(s.ctx, p.id, i);
    const rs = await Promise.all([10, 11, 12, 13].map((n) => uploadProductImage(db, s.ctx, p.id, png(200, 150 + n))));
    expect(rs.filter((r) => r.ok)).toHaveLength(2);
    expect(rs.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "image_limit")).toBe(true);
    expect(await db.productImage.count({ where: { productId: p.id, kind: "GALLERY" } })).toBe(5);
  });

  it("이미 6장 이상인 예전 상품은 모두 보이되 더 올릴 수 없고, 5장 아래로 줄어야 다시 올릴 수 있다", async () => {
    const s = await seller();
    const p = await product(s.ctx);
    await db.productImage.createMany({
      data: Array.from({ length: 8 }, (_, i) => ({
        sellerId: s.seller.id,
        productId: p.id,
        storageKey: `db:00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
        contentType: "image/png",
        byteSize: 1,
        width: 1,
        height: 1,
        sha256: String(i).repeat(64).slice(0, 64),
        sortOrder: i,
      })),
    });
    const all = await gallery(s.ctx, p.id);
    expect(all).toHaveLength(8);
    expect(thumbOf(all)).toEqual([all[0].id]);
    expect(await uploadProductImage(db, s.ctx, p.id, png(200, 150))).toEqual({ ok: false, reason: "image_limit" });
    for (let i = 0; i < 4; i++) await db.productImage.delete({ where: { id: all[i].id } }); // 8 → 4(저장소 바이트가 없는 시험용 행)
    expect(await uploadProductImage(db, s.ctx, p.id, png(200, 150))).toMatchObject({ ok: true });
    expect(await uploadProductImage(db, s.ctx, p.id, png(200, 151))).toEqual({ ok: false, reason: "image_limit" });
  });
});

describe("썸네일 지정", () => {
  it("지정이 없으면 첫 번째가 썸네일이고, 올린 응답·목록·상품 목록 모두 같은 사진을 가리킨다", async () => {
    const s = await seller();
    const p = await product(s.ctx);
    const a = await upload(s.ctx, p.id, 1);
    const b = await upload(s.ctx, p.id, 2);
    expect([a.isThumbnail, b.isThumbnail]).toEqual([true, false]);
    expect(thumbOf(await gallery(s.ctx, p.id))).toEqual([a.id]);
    expect((await sellerThumb(s.ctx))["팩"]).toBe(a.url);
    expect(await db.productImage.count({ where: { productId: p.id, thumbnail: true } })).toBe(0);
  });

  it("지정하면 그 사진이 썸네일(상품 목록·구매자 목록 포함), 순서를 바꿔도 유지되고, 풀면 첫 번째로 돌아간다", async () => {
    const s = await seller();
    const p = await product(s.ctx);
    const a = await upload(s.ctx, p.id, 1);
    const b = await upload(s.ctx, p.id, 2);
    const c = await upload(s.ctx, p.id, 3);
    const r = await setProductThumbnail(db, s.ctx, p.id, { imageId: c.id });
    if (!r.ok) throw new Error(r.reason);
    expect(thumbOf(r.images)).toEqual([c.id]);
    expect((await sellerThumb(s.ctx))["팩"]).toBe(c.url);
    const shop = await shopList(new Request("http://localhost:3000/x"), { params: Promise.resolve({ slug: s.seller.slug }) });
    const shopBody = await shop.json();
    expect(shopBody.products[0].thumbnailUrl).toContain(`/images/${c.id}?v=`);
    // 순서를 바꿔도 지정한 사진이 그대로
    await reorderProductImages(db, s.ctx, p.id, { imageIds: [c.id, b.id, a.id] });
    expect(thumbOf(await gallery(s.ctx, p.id))).toEqual([c.id]);
    await reorderProductImages(db, s.ctx, p.id, { imageIds: [a.id, b.id, c.id] });
    expect(thumbOf(await gallery(s.ctx, p.id))).toEqual([c.id]);
    // 다른 사진으로 바꾸기: 하나만 지정
    const r2 = await setProductThumbnail(db, s.ctx, p.id, { imageId: b.id });
    if (!r2.ok) throw new Error(r2.reason);
    expect(thumbOf(r2.images)).toEqual([b.id]);
    expect(await db.productImage.count({ where: { productId: p.id, thumbnail: true } })).toBe(1);
    // 풀기: 첫 번째로 돌아간다
    const r3 = await setProductThumbnail(db, s.ctx, p.id, { imageId: null });
    if (!r3.ok) throw new Error(r3.reason);
    expect(thumbOf(r3.images)).toEqual([a.id]);
    expect((await sellerThumb(s.ctx))["팩"]).toBe(a.url);
  });

  it("지정한 썸네일을 지우면 남은 사진 중 첫 번째가 썸네일이 되고, 지정 행은 남지 않는다", async () => {
    const s = await seller();
    const p = await product(s.ctx);
    const a = await upload(s.ctx, p.id, 1);
    const b = await upload(s.ctx, p.id, 2);
    const c = await upload(s.ctx, p.id, 3);
    await setProductThumbnail(db, s.ctx, p.id, { imageId: b.id });
    const del = await deleteProductImage(db, s.ctx, p.id, b.id);
    expect(thumbOf(del.images)).toEqual([a.id]);
    expect(await db.productImage.count({ where: { productId: p.id, thumbnail: true } })).toBe(0);
    expect((await sellerThumb(s.ctx))["팩"]).toBe(a.url);
    // 첫 번째를 지우면 다음 사진이 썸네일
    expect(thumbOf((await deleteProductImage(db, s.ctx, p.id, a.id)).images)).toEqual([c.id]);
  });

  it("같은 사진을 다시 지정해도 그대로(기록은 바뀐 때만), 동시에 다른 사진을 지정해도 하나만 남는다", async () => {
    const s = await seller();
    const p = await product(s.ctx);
    const a = await upload(s.ctx, p.id, 1);
    const b = await upload(s.ctx, p.id, 2);
    const c = await upload(s.ctx, p.id, 3);
    await setProductThumbnail(db, s.ctx, p.id, { imageId: b.id });
    await setProductThumbnail(db, s.ctx, p.id, { imageId: b.id });
    expect(await db.auditLog.count({ where: { sellerId: s.seller.id, action: "product_image.thumbnail" } })).toBe(1);
    const rs = await Promise.all([a.id, b.id, c.id, a.id].map((imageId) => setProductThumbnail(db, s.ctx, p.id, { imageId })));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(await db.productImage.count({ where: { productId: p.id, thumbnail: true } })).toBe(1);
  });

  it("형식이 틀리면 invalid_thumbnail, 상세 사진·다른 상품·다른 파트너스 사진은 404이고 바뀌지 않는다", async () => {
    const s = await seller();
    const other = await seller();
    const p = await product(s.ctx);
    const q = await product(s.ctx, "다른 팩");
    const a = await upload(s.ctx, p.id, 1);
    const detail = await upload(s.ctx, p.id, 2, "DETAIL");
    const qImg = await upload(s.ctx, q.id, 3);
    const foreign = await product(other.ctx);
    const fImg = await upload(other.ctx, foreign.id, 4);
    for (const imageId of [undefined, 1, "x", "", {}, []]) {
      expect(await setProductThumbnail(db, s.ctx, p.id, { imageId })).toEqual({ ok: false, reason: "invalid_thumbnail" });
    }
    expect(await setProductThumbnail(db, s.ctx, p.id, "x")).toEqual({ ok: false, reason: "invalid_thumbnail" });
    for (const imageId of [detail.id, qImg.id, fImg.id, "00000000-0000-4000-8000-000000000000"]) {
      await expect(setProductThumbnail(db, s.ctx, p.id, { imageId })).rejects.toMatchObject({ status: 404 });
    }
    await expect(setProductThumbnail(db, other.ctx, p.id, { imageId: a.id })).rejects.toMatchObject({ status: 404 });
    expect(await db.productImage.count({ where: { thumbnail: true } })).toBe(0);
  });

  it("지운 상품은 404, 상품 관리 권한이 없는 직원·조회 전용은 거절", async () => {
    const s = await seller();
    const p = await product(s.ctx);
    const a = await upload(s.ctx, p.id, 1);
    for (const c of [{ ...s.ctx, isOwner: false, permissions: [] }, { ...s.ctx, readOnly: true }] as TenantContext[]) {
      await expect(setProductThumbnail(db, c, p.id, { imageId: a.id })).rejects.toBeDefined();
    }
    await db.product.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
    await expect(setProductThumbnail(db, s.ctx, p.id, { imageId: a.id })).rejects.toMatchObject({ status: 404 });
    expect(await db.productImage.count({ where: { thumbnail: true } })).toBe(0);
  });

  it("DB 제약: 한 상품에 썸네일 둘·상세 사진 썸네일은 저장할 수 없다", async () => {
    const s = await seller();
    const p = await product(s.ctx);
    const a = await upload(s.ctx, p.id, 1);
    const b = await upload(s.ctx, p.id, 2);
    const d = await upload(s.ctx, p.id, 3, "DETAIL");
    await db.productImage.update({ where: { id: a.id }, data: { thumbnail: true } });
    await expect(db.productImage.update({ where: { id: b.id }, data: { thumbnail: true } })).rejects.toBeDefined();
    await expect(db.productImage.update({ where: { id: d.id }, data: { thumbnail: true } })).rejects.toBeDefined();
  });

  it("PUT 라우트: 200 { images(isThumbnail 포함) }, null로 풀기, 형식 오류 400, 로그인 전 401, 없는 상품·남의 사진 404", async () => {
    const s = await seller();
    const p = await product(s.ctx);
    const a = await upload(s.ctx, p.id, 1);
    const b = await upload(s.ctx, p.id, 2);
    const login = await loginSeller(db, { email: s.owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    const put = (body: unknown, cookie = `lo_seller=${login.token}`, id = p.id) =>
      thumbnailPut(new Request(`http://localhost:3000/api/seller/products/${id}/images/thumbnail`, { method: "PUT", headers: { ...H, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }), { params: Promise.resolve({ productId: id }) });
    expect((await put({ imageId: b.id }, "")).status).toBe(401);
    const ok = await put({ imageId: b.id });
    expect(ok.status).toBe(200);
    expect((await ok.json()).images.map((i: { id: string; isThumbnail: boolean }) => [i.id, i.isThumbnail])).toEqual([[a.id, false], [b.id, true]]);
    const cleared = await put({ imageId: null });
    expect((await cleared.json()).images.map((i: { isThumbnail: boolean }) => i.isThumbnail)).toEqual([true, false]);
    const bad = await put({ imageId: "abc" });
    expect([bad.status, (await bad.json()).error]).toEqual([400, "invalid_thumbnail"]);
    expect((await put({ imageId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    expect((await put({ imageId: a.id }, undefined, "not-a-uuid")).status).toBe(404);
  });
});
