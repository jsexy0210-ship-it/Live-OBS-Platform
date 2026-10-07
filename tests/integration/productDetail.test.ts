import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as detailGet, PUT as detailPut } from "../../app/api/seller/products/[productId]/detail/route";
import { GET as imagesGet, POST as imagesPost } from "../../app/api/seller/products/[productId]/images/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { ORDER_ERROR_MESSAGES_FORMAL } from "../../lib/server/orders/messages";
import { DETAIL_MAX_BLOCKS, getProductDetail, publicDetailBlocks, setProductDetail } from "../../lib/server/products/detail";
import { MAX_DETAIL_IMAGES, deleteProductImage, uploadProductImage } from "../../lib/server/products/images";
import { createProduct, getProduct, listProducts } from "../../lib/server/products/manage";
import type { TenantContext } from "../../lib/server/tenant/context";
import { png } from "../unit/shopContentFixtures";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 상세 페이지(PR-B): 글·사진 블록, 상세 사진(kind DETAIL)은 대표 사진과 따로, HTML 저장 안 함
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
async function product(ctx: TenantContext) {
  const r = await createProduct(db, ctx, { name: "팩", price: 1000, status: "ON_SALE", options: [{ name: "o", stock: 1 }] });
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}
async function upload(ctx: TenantContext, productId: string, kind: "GALLERY" | "DETAIL", n = 1) {
  const r = await uploadProductImage(db, ctx, productId, png(200, 150 + n), {}, kind);
  if (!r.ok) throw new Error(r.reason);
  return r.image;
}

describe("상세 페이지 블록", () => {
  it("글·상세 사진 블록을 순서대로 저장하고, 상세 사진은 대표 사진 목록·썸네일에 섞이지 않는다", async () => {
    const s = await seller();
    const p = await product(s.ctx);
    const g = await upload(s.ctx, p.id, "GALLERY");
    const d1 = await upload(s.ctx, p.id, "DETAIL", 1);
    const d2 = await upload(s.ctx, p.id, "DETAIL", 2);
    expect((await getProduct(db, s.ctx, p.id)).images.map((i) => i.id)).toEqual([g.id]);
    const list = await listProducts(db, s.ctx);
    if (!list.ok) throw new Error(list.reason);
    expect(list.value.products[0].thumbnailUrl).toBe(g.url);

    const r = await setProductDetail(db, s.ctx, p.id, {
      blocks: [
        { type: "image", imageId: d2.id },
        { type: "text", text: "  개봉 영상 참고\n<script>alert(1)</script>  " },
        { type: "image", imageId: d1.id },
        { type: "image", imageId: d2.id },
      ],
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.blocks).toEqual([
      { type: "image", imageId: d2.id, url: d2.url, width: 200, height: 152 },
      { type: "text", text: "개봉 영상 참고\n<script>alert(1)</script>" }, // 글자 그대로 저장(화면은 글자로만 그린다)
      { type: "image", imageId: d1.id, url: d1.url, width: 200, height: 151 },
      { type: "image", imageId: d2.id, url: d2.url, width: 200, height: 152 },
    ]);
    expect((await getProductDetail(db, s.ctx, p.id)).images.map((i) => i.id)).toEqual([d1.id, d2.id]);
    const pub = await publicDetailBlocks(db, s.seller.id, s.seller.slug, p.id);
    expect(pub[0]).toMatchObject({ type: "image", url: expect.stringMatching(new RegExp(`^/api/shop/${s.seller.slug}/products/${p.id}/images/${d2.id}\\?v=`)) });

    // 상세 사진을 지우면 그 블록도 빠지고, 남은 상세 사진 순서를 다시 매긴다
    const del = await deleteProductImage(db, s.ctx, p.id, d2.id);
    expect(del.images.map((i) => [i.id, i.sortOrder])).toEqual([[d1.id, 0]]);
    expect((await getProductDetail(db, s.ctx, p.id)).blocks.map((b) => b.type)).toEqual(["text", "image"]);
    expect(await db.auditLog.count({ where: { sellerId: s.seller.id, action: "product.detail" } })).toBe(1);
  });

  it("대표 사진·다른 상품 사진·없는 사진, HTML 모양·빈 글·2000자 초과·31블록·모르는 칸은 저장하지 않는다", async () => {
    const s = await seller();
    const p = await product(s.ctx);
    const q = await product(s.ctx);
    const g = await upload(s.ctx, p.id, "GALLERY");
    const other = await upload(s.ctx, q.id, "DETAIL");
    const d = await upload(s.ctx, p.id, "DETAIL");
    for (const blocks of [
      [{ type: "image", imageId: g.id }],
      [{ type: "image", imageId: other.id }],
      [{ type: "image", imageId: "00000000-0000-0000-0000-000000000000" }],
      [{ type: "html", html: "<b>x</b>" }],
      [{ type: "text", text: "  " }],
      [{ type: "text", text: "가".repeat(2001) }],
      [{ type: "text", text: "a\u0007b" }],
      [{ type: "text", text: "x", style: "color:red" }],
      [{ type: "image", imageId: d.id, text: "x" }],
      Array.from({ length: DETAIL_MAX_BLOCKS + 1 }, () => ({ type: "text", text: "x" })),
      "x",
    ]) {
      expect(await setProductDetail(db, s.ctx, p.id, { blocks }), JSON.stringify(blocks).slice(0, 60)).toEqual({ ok: false, reason: "invalid_detail" });
    }
    expect(await setProductDetail(db, s.ctx, p.id, { blocks: [] })).toMatchObject({ ok: true, value: { blocks: [] } });
    expect(await setProductDetail(db, s.ctx, p.id, { blocks: Array.from({ length: DETAIL_MAX_BLOCKS }, () => ({ type: "text", text: "가".repeat(2000) })) })).toMatchObject({ ok: true });
  });

  it(`상세 사진은 ${MAX_DETAIL_IMAGES}장까지(대표 사진 10장과 따로), 다른 판매자·조회 전용은 막는다`, async () => {
    const s = await seller();
    const other = await seller();
    const p = await product(s.ctx);
    await db.productImage.createMany({
      data: Array.from({ length: MAX_DETAIL_IMAGES }, (_, i) => ({
        sellerId: s.seller.id,
        productId: p.id,
        storageKey: `db:00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
        contentType: "image/png",
        byteSize: 1,
        width: 1,
        height: 1,
        sha256: "0".repeat(64),
        kind: "DETAIL" as const,
        sortOrder: i,
      })),
    });
    expect(await uploadProductImage(db, s.ctx, p.id, png(200, 150), {}, "DETAIL")).toEqual({ ok: false, reason: "too_many_detail_images" });
    expect(await uploadProductImage(db, s.ctx, p.id, png(200, 150), {}, "GALLERY")).toMatchObject({ ok: true });
    await expect(setProductDetail(db, other.ctx, p.id, { blocks: [] })).rejects.toMatchObject({ status: 404 });
    await expect(getProductDetail(db, other.ctx, p.id)).rejects.toMatchObject({ status: 404 });
    await expect(setProductDetail(db, { ...s.ctx, readOnly: true, impersonationScopes: ["ORDERS", "MEMBERS"] }, p.id, { blocks: [] })).rejects.toMatchObject({ status: 403 });
    expect((await getProductDetail(db, { ...s.ctx, readOnly: true, impersonationScopes: ["ORDERS", "MEMBERS"] }, p.id)).blocks).toEqual([]);
  });
});

describe("HTTP", () => {
  it("상세 사진은 ?kind=detail로 올리고, 상세 페이지 GET·PUT, 권한 없는 직원 403·다른 출처 403·잘못된 본문 400과 문구", async () => {
    const s = await seller();
    const p = await product(s.ctx);
    const cookie = async (email: string) => {
      const r = await loginSeller(db, { email, password: PASSWORD }, {});
      if (!r.ok) throw new Error(r.reason);
      return `lo_seller=${r.token}`;
    };
    const owner = await cookie(s.owner.email);
    const broadcaster = await cookie((await createSellerUser(s.seller.id, "BROADCASTER")).email);
    const pp = { params: Promise.resolve({ productId: p.id }) };
    const up = await imagesPost(
      new Request(`http://localhost:3000/api/seller/products/${p.id}/images?kind=detail`, { method: "POST", headers: { ...H, cookie: owner }, body: Uint8Array.from(png(300, 300)) }),
      pp,
    );
    expect(up.status).toBe(201);
    const { image } = await up.json();
    const list = (q: string, c = owner) => imagesGet(new Request(`http://localhost:3000/api/seller/products/${p.id}/images${q}`, { headers: { ...H, cookie: c } }), pp);
    expect((await (await list("?kind=detail")).json()).images.map((i: { id: string }) => i.id)).toEqual([image.id]);
    expect((await (await list("")).json()).images).toEqual([]);
    expect((await list("", broadcaster)).status).toBe(403);

    const put = (body: unknown, c = owner, headers: Record<string, string> = H) =>
      detailPut(new Request("http://localhost:3000/x", { method: "PUT", headers: { ...headers, "content-type": "application/json", cookie: c }, body: JSON.stringify(body) }), pp);
    expect((await put({ blocks: [] }, owner, { ...H, origin: "http://evil.example" })).status).toBe(403);
    expect((await put({ blocks: [] }, broadcaster)).status).toBe(403);
    const bad = await put({ blocks: [{ type: "html" }] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_detail", message: ORDER_ERROR_MESSAGES_FORMAL.invalid_detail });
    const ok = await put({ blocks: [{ type: "text", text: "설명" }, { type: "image", imageId: image.id }] });
    expect(ok.status).toBe(200);
    const got = await (await detailGet(new Request("http://localhost:3000/x", { headers: { ...H, cookie: owner } }), pp)).json();
    expect(got.blocks).toEqual([
      { type: "text", text: "설명" },
      { type: "image", imageId: image.id, url: image.url, width: 300, height: 300 },
    ]);
  });
});
