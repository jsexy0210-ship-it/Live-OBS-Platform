import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as detailGet, PUT as detailPut } from "../../app/api/seller/products/[productId]/detail/route";
import { GET as shopDetail } from "../../app/api/shop/[slug]/products/[productId]/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { ORDER_ERROR_MESSAGES_FORMAL } from "../../lib/server/orders/messages";
import { getProductDetail, publicDetailHtml, setProductDetail } from "../../lib/server/products/detail";
import { DETAIL_HTML_MAX_TEXT } from "../../lib/server/products/detailHtml";
import { deleteProductImage, uploadProductImage } from "../../lib/server/products/images";
import { createProduct } from "../../lib/server/products/manage";
import type { TenantContext } from "../../lib/server/tenant/context";
import { png } from "../unit/shopContentFixtures";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 상세 설명 에디터 HTML: 저장 때 서버 정화, 사진 src 규칙, 예전 블록 호환, 구매자 공개 주소
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
async function upload(ctx: TenantContext, productId: string, kind: "GALLERY" | "DETAIL", n = 1) {
  const r = await uploadProductImage(db, ctx, productId, png(200, 150 + n), {}, kind);
  if (!r.ok) throw new Error(r.reason);
  return r.image;
}
const save = async (ctx: TenantContext, productId: string, body: unknown) => {
  const r = await setProductDetail(db, ctx, productId, body);
  if (!r.ok) throw new Error(r.reason);
  return r.value as { blocks: unknown[]; html: string | null; images: { id: string }[]; sanitized?: { removedCount: number } };
};
const stored = (productId: string) => db.productDetail.findUniqueOrThrow({ where: { productId }, select: { html: true, blocks: true } });

describe("에디터 HTML 저장", () => {
  it("허용한 것만 남기고 지운 곳 수를 알려 주며, 사진 주소는 읽는 쪽에 맞게 바뀐다(저장은 버전 없는 주소)", async () => {
    const s = await seller();
    const p = await product(s.ctx);
    const d = await upload(s.ctx, p.id, "DETAIL");
    const html = `<h2>소개</h2><p onclick="alert(1)">본문 <strong>굵게</strong></p><script>alert(1)</script><img src="${d.url}" alt="사진" onerror="alert(2)"><table><tr><td colspan="2">값</td></tr></table><a href="javascript:alert(3)">클릭</a>`;
    const r = await save(s.ctx, p.id, { html });
    expect(r.sanitized?.removedCount).toBe(4); // onclick · script · onerror · javascript 링크
    expect(r.blocks).toEqual([]);
    expect(r.html).toContain("<h2>소개</h2>");
    expect(r.html).toContain("<strong>굵게</strong>");
    expect(r.html).toContain(`src="${d.url}"`); // 파트너스 관리자 주소(버전 포함)
    expect(r.html).not.toMatch(/script|onclick|onerror|javascript/);
    expect(r.html).toContain("클릭"); // 링크는 글자만 남는다
    const row = await stored(p.id);
    expect(row.html).toContain(`src="/api/seller/products/${p.id}/images/${d.id}"`); // 저장 주소에는 버전이 없다
    expect(row.html).not.toContain("?v=");
    expect(row.blocks).toEqual([]);
    expect((await getProductDetail(db, s.ctx, p.id)).html).toBe(r.html);
    // 구매자 공개: 쇼핑몰 주소로
    const pub = await publicDetailHtml(db, s.seller.id, s.seller.slug, p.id);
    expect(pub).toContain(`src="/api/shop/${s.seller.slug}/products/${p.id}/images/${d.id}?v=`);
    expect(pub).not.toContain("/api/seller/");
    // 로그 추적에는 글 내용이 아니라 크기·지운 곳 수만
    const audit = await db.auditLog.findFirstOrThrow({ where: { sellerId: s.seller.id, action: "product.detail" }, orderBy: { createdAt: "desc" } });
    expect(audit.after).toEqual({ html: true, textLength: expect.any(Number), removedCount: 4 });
  });

  it("사진은 이 상품의 상세 사진만: 대표 사진·다른 상품·다른 파트너스·없는 사진·외부 주소는 지운다", async () => {
    const s = await seller();
    const other = await seller();
    const p = await product(s.ctx);
    const q = await product(s.ctx, "다른 팩");
    const g = await upload(s.ctx, p.id, "GALLERY");
    const qd = await upload(s.ctx, q.id, "DETAIL", 2);
    const op = await product(other.ctx);
    const od = await upload(other.ctx, op.id, "DETAIL", 3);
    const own = await upload(s.ctx, p.id, "DETAIL", 4);
    const r = await save(s.ctx, p.id, {
      html: `<p>글</p><img src="${g.url}"><img src="${qd.url}"><img src="/api/seller/products/${op.id}/images/${od.id}"><img src="/api/seller/products/${p.id}/images/00000000-0000-4000-8000-000000000000"><img src="https://evil.example/x.png"><img src="${own.url}">`,
    });
    expect(r.sanitized?.removedCount).toBe(5);
    expect(r.html?.match(/<img/g)).toHaveLength(1);
    expect(r.html).toContain(`/images/${own.id}`);
  });

  it("글자색·배경색(#hex·rgb)은 저장·읽기에 남고, url()·var() 같은 값은 지운다", async () => {
    const s = await seller();
    const p = await product(s.ctx);
    const r = await save(s.ctx, p.id, { html: '<p><span style="color:#E00;background-color:rgb(255, 255, 0)">강조</span> <span style="color:url(https://evil.example/x)">나쁨</span> <span style="background-color:var(--x)">변수</span></p>' });
    expect(r.html).toContain('<span style="color:#e00;background-color:rgb(255,255,0)">강조</span>');
    expect(r.html).not.toMatch(/url\(|var\(|evil\.example/);
    expect(r.html).toContain("나쁨");
    expect(r.sanitized?.removedCount).toBe(2 + 2); // 지운 선언 2개 + 스타일이 남지 않은 span 2개
    expect((await stored(p.id)).html).toContain("color:#e00");
    expect((await getProductDetail(db, s.ctx, p.id)).html).toBe(r.html);
  });

  it("예전 글·사진 블록과 호환: html을 저장하면 블록은 비우고, 블록으로 저장하면 html을 지운다. 둘 다/둘 다 없음은 거절", async () => {
    const s = await seller();
    const p = await product(s.ctx);
    await save(s.ctx, p.id, { blocks: [{ type: "text", text: "예전 글" }] });
    expect((await getProductDetail(db, s.ctx, p.id))).toMatchObject({ blocks: [{ type: "text", text: "예전 글" }], html: null });
    await save(s.ctx, p.id, { html: "<p>새 글</p>" });
    expect(await stored(p.id)).toEqual({ html: "<p>새 글</p>", blocks: [] });
    await save(s.ctx, p.id, { blocks: [{ type: "text", text: "다시 블록" }] });
    expect(await stored(p.id)).toEqual({ html: null, blocks: [{ type: "text", text: "다시 블록" }] });
    expect(await publicDetailHtml(db, s.seller.id, s.seller.slug, p.id)).toBeNull();
    for (const body of [{ html: "<p>x</p>", blocks: [] }, {}, { html: 1 }, { html: null }, { html: {} }, null, "x"]) {
      expect(await setProductDetail(db, s.ctx, p.id, body), JSON.stringify(body)).toEqual({ ok: false, reason: "invalid_detail" });
    }
    expect((await stored(p.id)).html).toBeNull();
  });

  it("글자 20,000자까지, 넘으면 detail_too_long이고 저장하지 않는다. 비워 저장하면 상세 설명을 지운다", async () => {
    const s = await seller();
    const p = await product(s.ctx);
    await save(s.ctx, p.id, { html: `<p>${"가".repeat(DETAIL_HTML_MAX_TEXT)}</p>` });
    expect(await setProductDetail(db, s.ctx, p.id, { html: `<p>${"가".repeat(DETAIL_HTML_MAX_TEXT + 1)}</p>` })).toEqual({ ok: false, reason: "detail_too_long" });
    expect((await stored(p.id)).html).toContain("가가가");
    const cleared = await save(s.ctx, p.id, { html: "  <p> </p> " });
    expect(cleared.html).toBeNull();
    expect(await stored(p.id)).toEqual({ html: null, blocks: [] });
  });

  it("상세 사진을 지우면 HTML과 예전 블록에서 그 사진이 빠진다(다른 사진은 그대로)", async () => {
    const s = await seller();
    const p = await product(s.ctx);
    const a = await upload(s.ctx, p.id, "DETAIL", 1);
    const b = await upload(s.ctx, p.id, "DETAIL", 2);
    await save(s.ctx, p.id, { html: `<p>앞</p><img src="${a.url}"><p>중간</p><img src="${b.url}"><img src="${a.url}">` });
    await deleteProductImage(db, s.ctx, p.id, a.id);
    const row = await stored(p.id);
    expect(row.html).not.toContain(a.id);
    expect(row.html).toContain(b.id);
    expect(row.html).toContain("<p>중간</p>");
    expect((await getProductDetail(db, s.ctx, p.id)).html).toContain(`/images/${b.id}`);
  });

  it("다른 파트너스 상품은 404, 상품 관리 권한 없는 직원·조회 전용은 쓰기 거절(조회 전용은 읽기 가능)", async () => {
    const s = await seller();
    const other = await seller();
    const p = await product(s.ctx);
    await save(s.ctx, p.id, { html: "<p>비공개 글</p>" });
    await expect(setProductDetail(db, other.ctx, p.id, { html: "<p>x</p>" })).rejects.toMatchObject({ status: 404 });
    await expect(getProductDetail(db, other.ctx, p.id)).rejects.toMatchObject({ status: 404 });
    await expect(setProductDetail(db, { ...s.ctx, isOwner: false, permissions: [] }, p.id, { html: "<p>x</p>" })).rejects.toBeDefined();
    await expect(setProductDetail(db, { ...s.ctx, readOnly: true }, p.id, { html: "<p>x</p>" })).rejects.toMatchObject({ status: 403 });
    expect((await getProductDetail(db, { ...s.ctx, readOnly: true }, p.id)).html).toBe("<p>비공개 글</p>");
    expect((await stored(p.id)).html).toBe("<p>비공개 글</p>");
  });
});

describe("API 경로", () => {
  it("PUT { html } 200 + sanitized.removedCount, 20,000자 초과 400 detail_too_long, 둘 다 400 invalid_detail, 구매자 상품 상세에 detailHtml", async () => {
    const s = await seller();
    const p = await product(s.ctx);
    const login = await loginSeller(db, { email: s.owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    const cookie = `lo_seller=${login.token}`;
    const pp = { params: Promise.resolve({ productId: p.id }) };
    const put = (body: unknown) => detailPut(new Request(`http://localhost:3000/api/seller/products/${p.id}/detail`, { method: "PUT", headers: { ...H, "content-type": "application/json", cookie }, body: JSON.stringify(body) }), pp);
    const ok = await put({ html: '<p>안녕</p><script>alert(1)</script><iframe src="https://evil.example"></iframe>' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ blocks: [], html: "<p>안녕</p>", sanitized: { removedCount: 2 } });
    const long = await put({ html: `<p>${"가".repeat(DETAIL_HTML_MAX_TEXT + 1)}</p>` });
    expect([long.status, await long.json()]).toEqual([400, { error: "detail_too_long", message: ORDER_ERROR_MESSAGES_FORMAL.detail_too_long }]);
    const both = await put({ html: "<p>x</p>", blocks: [] });
    expect([both.status, (await both.json()).error]).toEqual([400, "invalid_detail"]);
    const get = await detailGet(new Request(`http://localhost:3000/api/seller/products/${p.id}/detail`, { headers: { ...H, cookie } }), pp);
    expect(await get.json()).toMatchObject({ html: "<p>안녕</p>", blocks: [] });
    // 구매자 상품 상세: detailHtml(정화된 것), detail(예전 블록)은 비어 있다
    const res = await shopDetail(new Request("http://localhost:3000/x"), { params: Promise.resolve({ slug: s.seller.slug, productId: p.id }) });
    const body = await res.json();
    expect([res.status, body.product.detailHtml, body.product.detail]).toEqual([200, "<p>안녕</p>", []]);
  });
});
