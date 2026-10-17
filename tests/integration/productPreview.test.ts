import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as previewRoute } from "../../app/api/seller/products/[productId]/preview/route";
import { createSellerSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { uploadProductImage } from "../../lib/server/products/images";
import { createProduct } from "../../lib/server/products/manage";
import type { TenantContext } from "../../lib/server/tenant/context";
import { png } from "../unit/shopContentFixtures";
import { createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

async function shop(staff: "OWNER" | "BROADCASTER" = "OWNER") {
  const { seller, grade } = await createSeller();
  const user = await createSellerUser(seller.id, staff);
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: user.id, isOwner: staff === "OWNER", permissions: [], readOnly: false };
  const cookie = `lo_seller=${(await createSellerSession(db, seller.id, user.id, {}, user.credentialVersion)).token}`;
  const get = (productId: string) => previewRoute(new Request(`http://localhost:3000/api/seller/products/${productId}/preview`, { headers: { cookie } }), { params: Promise.resolve({ productId }) });
  return { seller, grade, ctx, get };
}
async function product(s: Awaited<ReturnType<typeof shop>>, over: Record<string, unknown> = {}) {
  const r = await createProduct(db, s.ctx, { name: "스타라이트 부스터 박스", price: 99000, status: "ON_SALE", description: "정품 미개봉 박스예요", options: [{ name: "1박스", stock: 12 }], ...over });
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}

describe("상품 상세 미리보기(SA-013)", () => {
  it("구매자에게 보이는 값·점검 항목·공유 링크를 한 번에 준다(쓰기 없음)", async () => {
    const s = await shop();
    const p = await product(s);
    for (const rgb of [[1, 2, 3], [4, 5, 6]] as const) {
      const r = await uploadProductImage(db, s.ctx, p.id, png(200, 200, [...rgb]));
      if (!r.ok) throw new Error(r.reason);
    }
    const cat = await db.shopCategory.create({ data: { sellerId: s.seller.id, name: "포켓몬" } });
    await db.productCategory.create({ data: { sellerId: s.seller.id, productId: p.id, categoryId: cat.id } });
    const before = await db.auditLog.count();
    const res = await s.get(p.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shop).toEqual({ slug: s.seller.slug, name: s.seller.shopName });
    expect(body.product).toMatchObject({ id: p.id, name: "스타라이트 부스터 박스", price: 99000, status: "ON_SALE", stock: 12, soldOut: false, visibleToBuyers: true, categories: ["포켓몬"], purchaseLimits: null, event: null });
    expect(body.product.images).toHaveLength(2);
    expect(body.checks).toEqual([
      { key: "images", status: "ok", detail: "2장 · 1:1" },
      { key: "description", status: "ok", detail: "표시 정상" },
      { key: "price", status: "ok", detail: "99,000원" },
      { key: "stock", status: "ok", detail: "재고 12" },
      { key: "categories", status: "ok", detail: "포켓몬" },
    ]);
    expect(body.open).toEqual({ canOpen: true, path: `/shop/${s.seller.slug}/products/${p.id}` });
    expect(body.share.path).toBe(body.open.path);
    expect(body.share.card).toMatchObject({ title: "스타라이트 부스터 박스", price: 99000, imageUrl: expect.stringMatching(new RegExp(`^/api/shop/${s.seller.slug}/products/${p.id}/images/`)) });
    expect(await db.auditLog.count()).toBe(before);
  });

  it("이미지·설명·카테고리가 없고 재고가 적으면 주의, 이벤트 할인 중이면 할인가가 가격·공유 카드에 쓰인다", async () => {
    const s = await shop();
    const p = await product(s, { description: null, options: [{ name: "1박스", stock: 3 }] });
    const bare = await (await s.get(p.id)).json();
    expect(bare.checks.map((c: { key: string; status: string }) => [c.key, c.status])).toEqual([["images", "warn"], ["description", "warn"], ["price", "ok"], ["stock", "warn"], ["categories", "warn"]]);
    expect(bare.share.card.imageUrl).toBeNull();
    const now = Date.now();
    await db.product.update({
      where: { id: p.id },
      data: { eventDiscountType: "RATE", eventDiscountValue: 10, eventStartsAt: new Date(now - 3_600_000), eventEndsAt: new Date(now + 5 * 86_400_000) },
    });
    const sale = await (await s.get(p.id)).json();
    expect(sale.product.event).toMatchObject({ active: true, discountedPrice: 89100, discountRate: 10 });
    expect(sale.share.card.price).toBe(89100);
    expect(sale.checks.find((c: { key: string }) => c.key === "price").detail).toBe("정가 99,000원 · 할인가 89,100원");
  });

  it("숨김 상품은 미리볼 수 있지만 쇼핑몰에서 열 수 없다. 품절은 soldOut, 적립률은 기본 등급 기준", async () => {
    const s = await shop();
    const hidden = await product(s, { status: "HIDDEN" });
    const h = await (await s.get(hidden.id)).json();
    expect([h.product.visibleToBuyers, h.open.canOpen]).toEqual([false, false]);
    const out = await product(s, { status: "SOLD_OUT", options: [{ name: "1박스", stock: 0 }] });
    const o = await (await s.get(out.id)).json();
    expect([o.product.soldOut, o.open.canOpen]).toEqual([true, true]);
    expect(o.checks.find((c: { key: string }) => c.key === "stock")).toMatchObject({ status: "warn", detail: "재고가 없습니다" });
    const basic = await db.memberGrade.findFirstOrThrow({ where: { sellerId: s.seller.id, systemKey: "BASIC" } });
    expect(o.earn).toEqual({ gradeName: basic.displayName, card: 0, bankTransfer: 0 });
    await db.rewardPolicy.create({ data: { sellerId: s.seller.id, rates: { [basic.id]: { card: 1, bankTransfer: 2 } } } });
    expect((await (await s.get(out.id)).json()).earn).toEqual({ gradeName: basic.displayName, card: 1, bankTransfer: 2 });
  });

  it("다른 쇼핑몰·지운·잘못된 id는 404, 상품 관리 권한이 없는 직원은 403", async () => {
    const a = await shop();
    const b = await shop();
    const p = await product(a);
    expect((await b.get(p.id)).status).toBe(404);
    expect((await a.get("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await a.get("not-a-uuid")).status).toBe(404);
    await db.product.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
    expect((await a.get(p.id)).status).toBe(404);
    const staff = await shop("BROADCASTER");
    const sp = await db.product.create({ data: { sellerId: staff.seller.id, name: "팩", price: 1000, status: "ON_SALE" } });
    expect((await staff.get(sp.id)).status).toBe(403);
  });
});
