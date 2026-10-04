import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DELETE as imageDelete, GET as imageGet } from "../../app/api/seller/products/[productId]/images/[imageId]/route";
import { PUT as orderRoute } from "../../app/api/seller/products/[productId]/images/order/route";
import { GET as imagesGet, POST as imagesPost } from "../../app/api/seller/products/[productId]/images/route";
import { GET as publicImage } from "../../app/api/shop/[slug]/products/[productId]/images/[imageId]/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { createProduct, deleteProduct, getProduct, listProducts, updateProduct } from "../../lib/server/products/manage";
import { MAX_PRODUCT_IMAGES, PRODUCT_IMAGE_MESSAGES, deleteProductImage, reorderProductImages, uploadProductImage } from "../../lib/server/products/images";
import type { TenantContext } from "../../lib/server/tenant/context";
import { jpeg, webp } from "../unit/productImageFormatsFixtures";
import { png } from "../unit/shopContentFixtures";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 상품 사진(PR-A): 올리기·순서·삭제·대표 사진, 판매자 격리, 공통 저장소(DB 드라이버), 구매자 공개 주소
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
async function product(ctx: TenantContext, status = "ON_SALE") {
  const r = await createProduct(db, ctx, { name: "팩", price: 1000, status, options: [{ name: "o", stock: 1 }] });
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}
async function upload(ctx: TenantContext, productId: string, rgb: [number, number, number] = [10, 20, 30]) {
  const r = await uploadProductImage(db, ctx, productId, png(200, 150, rgb));
  if (!r.ok) throw new Error(r.reason);
  return r.image;
}

describe("상품 사진 올리기·순서·삭제", () => {
  it("맨 뒤에 붙고 첫 장이 대표 사진이며, 바이트는 저장소(StoredImage)에, 형식·크기·해시는 ProductImage에 둔다", async () => {
    const s = await seller();
    const p = await product(s.ctx);
    const a = await upload(s.ctx, p.id, [1, 1, 1]);
    const b = await upload(s.ctx, p.id, [2, 2, 2]);
    expect([a.sortOrder, b.sortOrder]).toEqual([0, 1]);
    expect(a).toMatchObject({ width: 200, height: 150, url: expect.stringMatching(new RegExp(`^/api/seller/products/${p.id}/images/${a.id}\\?v=[0-9a-f]{12}$`)) });
    const row = await db.productImage.findUniqueOrThrow({ where: { id: a.id } });
    expect(row).toMatchObject({ contentType: "image/png", width: 200, height: 150, storageKey: expect.stringMatching(/^db:/) });
    expect(await db.storedImage.count({ where: { sellerId: s.seller.id } })).toBe(2);

    // 상품 조회는 사진 목록, 목록은 대표 사진 주소
    expect((await getProduct(db, s.ctx, p.id)).images.map((i) => i.id)).toEqual([a.id, b.id]);
    const list = await listProducts(db, s.ctx);
    if (!list.ok) throw new Error(list.reason);
    expect(list.value.products[0].thumbnailUrl).toBe(a.url);

    // 순서 바꾸기: 전부 보내야 하고, 첫 장이 대표 사진
    const re = await reorderProductImages(db, s.ctx, p.id, { imageIds: [b.id, a.id] });
    if (!re.ok) throw new Error(re.reason);
    expect(re.images.map((i) => [i.id, i.sortOrder])).toEqual([
      [b.id, 0],
      [a.id, 1],
    ]);
    for (const imageIds of [[b.id], [a.id, a.id], [a.id, b.id, "00000000-0000-0000-0000-000000000000"], "x"]) {
      expect(await reorderProductImages(db, s.ctx, p.id, { imageIds })).toEqual({ ok: false, reason: "invalid_image_order" });
    }

    // 지우면 저장소 바이트도 지우고 순서를 다시 매긴다
    const del = await deleteProductImage(db, s.ctx, p.id, b.id);
    expect(del.images.map((i) => [i.id, i.sortOrder])).toEqual([[a.id, 0]]);
    expect(await db.storedImage.count({ where: { sellerId: s.seller.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { sellerId: s.seller.id, action: { startsWith: "product_image." } } })).toBe(4);
  });

  it(`${MAX_PRODUCT_IMAGES}장 한도, PNG 아닌 파일·크기 밖·빈 파일은 거부하고 저장소에 남기지 않는다`, async () => {
    const s = await seller();
    const p = await product(s.ctx);
    for (let i = 0; i < MAX_PRODUCT_IMAGES; i++) await upload(s.ctx, p.id, [i, i, i]);
    expect(await uploadProductImage(db, s.ctx, p.id, png(200, 150))).toEqual({ ok: false, reason: "too_many_images" });
    const q = await product(s.ctx);
    const jpegLike = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]);
    for (const [bytes, reason] of [
      [Buffer.alloc(0), "empty_file"],
      [jpegLike, "unsupported_image"],
      [Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "unsupported_image"],
      [png(99, 150), "wrong_image_size"],
      [png(4001, 100), "wrong_image_size"],
      [png(200, 150, [1, 2, 3], { depth: 16 }), "png_16bit"],
    ] as const) {
      expect(await uploadProductImage(db, s.ctx, q.id, bytes)).toEqual({ ok: false, reason });
    }
    expect(await db.storedImage.count({ where: { sellerId: s.seller.id } })).toBe(MAX_PRODUCT_IMAGES);
  });

  it("다른 판매자 상품·사진, 지운 상품은 404이고, 조회 전용은 바꿀 수 없다", async () => {
    const s = await seller();
    const other = await seller();
    const p = await product(s.ctx);
    const a = await upload(s.ctx, p.id);
    await expect(uploadProductImage(db, other.ctx, p.id, png(200, 150))).rejects.toMatchObject({ status: 404 });
    await expect(deleteProductImage(db, other.ctx, p.id, a.id)).rejects.toMatchObject({ status: 404 });
    await expect(reorderProductImages(db, other.ctx, p.id, { imageIds: [a.id] })).rejects.toMatchObject({ status: 404 });
    const ro = { ...s.ctx, readOnly: true };
    await expect(uploadProductImage(db, ro, p.id, png(200, 150))).rejects.toMatchObject({ status: 403 });
    await expect(deleteProductImage(db, ro, p.id, a.id)).rejects.toMatchObject({ status: 403 });
    await deleteProduct(db, s.ctx, p.id);
    await expect(uploadProductImage(db, s.ctx, p.id, png(200, 150))).rejects.toMatchObject({ status: 404 });
    expect(await db.productImage.count({ where: { id: a.id } })).toBe(1);
  });
});

describe("HTTP·공개 주소", () => {
  it("바이트로 올리고(5MB 넘으면 413), 미리보기는 private, 구매자 주소는 보이는 상품만·nosniff, 다른 출처 403", async () => {
    const s = await seller();
    const other = await seller();
    const p = await product(s.ctx);
    const cookie = async (email: string) => {
      const r = await loginSeller(db, { email, password: PASSWORD }, {});
      if (!r.ok) throw new Error(r.reason);
      return `lo_seller=${r.token}`;
    };
    const owner = await cookie(s.owner.email);
    const otherOwner = await cookie((await createSellerUser(other.seller.id, "OWNER", "img-other@example.com")).email);
    const pp = { params: Promise.resolve({ productId: p.id }) };
    const post = (body: Uint8Array<ArrayBuffer>, c = owner, headers: Record<string, string> = H) =>
      imagesPost(new Request(`http://localhost:3000/api/seller/products/${p.id}/images`, { method: "POST", headers: { ...headers, cookie: c }, body }), pp);

    const created = await post(Uint8Array.from(png(300, 300)));
    expect(created.status).toBe(201);
    const { image } = await created.json();
    expect((await post(Uint8Array.from(png(300, 300)), owner, { ...H, origin: "http://evil.example" })).status).toBe(403);
    expect((await post(Uint8Array.from(png(300, 300)), otherOwner)).status).toBe(404);
    const big = await post(new Uint8Array(5 * 1024 * 1024 + 1));
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "file_too_large", message: PRODUCT_IMAGE_MESSAGES.file_too_large });
    const bad = await post(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "unsupported_image", message: PRODUCT_IMAGE_MESSAGES.unsupported_image });

    expect((await (await imagesGet(new Request("http://localhost:3000/x", { headers: { ...H, cookie: owner } }), pp)).json()).images).toHaveLength(1);
    const ip = { params: Promise.resolve({ productId: p.id, imageId: image.id }) };
    const preview = await imageGet(new Request(`http://localhost:3000${image.url}`, { headers: { ...H, cookie: owner } }), ip);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("cache-control")).toContain("private");
    expect(Buffer.from(await preview.arrayBuffer()).equals(png(300, 300))).toBe(true);
    expect((await imageGet(new Request("http://localhost:3000/x", { headers: { ...H, cookie: otherOwner } }), ip)).status).toBe(404);

    const pub = (slug = s.seller.slug, productId = p.id) =>
      publicImage(new Request(`http://localhost:3000/api/shop/${slug}/products/${productId}/images/${image.id}`), {
        params: Promise.resolve({ slug, productId, imageId: image.id }),
      });
    const ok = await pub();
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await pub(other.seller.slug)).status).toBe(404); // 다른 쇼핑몰 주소로는 못 읽는다
    await updateProduct(db, s.ctx, p.id, { status: "HIDDEN" });
    expect((await pub()).status).toBe(404);
    await updateProduct(db, s.ctx, p.id, { status: "SOLD_OUT" });
    expect((await pub()).status).toBe(200);

    const order = await orderRoute(
      new Request("http://localhost:3000/x", { method: "PUT", headers: { ...H, "content-type": "application/json", cookie: owner }, body: JSON.stringify({ imageIds: [] }) }),
      pp,
    );
    expect(order.status).toBe(409);
    const del = await imageDelete(new Request("http://localhost:3000/x", { method: "DELETE", headers: { ...H, cookie: owner } }), ip);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ images: [] });
    // 지운 사진은 공개 주소에서도 404, 운영 중이 아닌 쇼핑몰도 404
    expect((await pub()).status).toBe(404);
    const again = await upload(s.ctx, p.id);
    const pubAgain = () =>
      publicImage(new Request("http://localhost:3000/x"), { params: Promise.resolve({ slug: s.seller.slug, productId: p.id, imageId: again.id }) });
    expect((await pubAgain()).status).toBe(200);
    await db.seller.update({ where: { id: s.seller.id }, data: { status: "SUSPENDED" } });
    expect((await pubAgain()).status).toBe(404);
  });
});

describe("JPG·WEBP", () => {
  it("위치정보(EXIF GPS)가 든 JPG·WEBP를 올리면 저장본·응답에 메타데이터가 없고, 형식대로 응답한다", async () => {
    const s = await seller();
    const p = await product(s.ctx);
    const src = jpeg(1200, 900, { xmp: true, comment: true });
    expect(src.includes(Buffer.from("GPSLatitude"))).toBe(true);
    const j = await uploadProductImage(db, s.ctx, p.id, src);
    const w = await uploadProductImage(db, s.ctx, p.id, webp(800, 600));
    if (!j.ok || !w.ok) throw new Error("upload");
    expect(j.image).toMatchObject({ width: 1200, height: 900 });
    for (const [id, type] of [
      [j.image.id, "image/jpeg"],
      [w.image.id, "image/webp"],
    ] as const) {
      const row = await db.productImage.findUniqueOrThrow({ where: { id } });
      expect(row.contentType).toBe(type);
      const stored = await db.storedImage.findUniqueOrThrow({ where: { id: row.storageKey.slice(3) } });
      const bytes = Buffer.from(stored.data);
      for (const t of ["GPS", "Exif", "EXIF", "xmpmeta", "made at home"]) expect(bytes.includes(Buffer.from(t)), t).toBe(false);
      expect(stored.byteSize).toBe(bytes.length);
      const res = await publicImage(new Request("http://localhost:3000/x"), { params: Promise.resolve({ slug: s.seller.slug, productId: p.id, imageId: id }) });
      expect(res.headers.get("content-type")).toBe(type);
      expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
    }
    // 깨진 JPG는 거절하고 남기지 않는다
    expect(await uploadProductImage(db, s.ctx, p.id, jpeg(500, 500, { noEoi: true }))).toEqual({ ok: false, reason: "unsupported_image" });
    expect(await db.storedImage.count({ where: { sellerId: s.seller.id } })).toBe(2);
  });
});
