import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as catProductsGet, PUT as catProductsPut } from "../../app/api/seller/categories/[categoryId]/products/route";
import { PUT as settingsPut } from "../../app/api/seller/display/settings/route";
import { GET as homeRoute } from "../../app/api/shop/[slug]/home/route";
import { GET as listRoute } from "../../app/api/shop/[slug]/products/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { ORDER_ERROR_MESSAGES_FORMAL } from "../../lib/server/orders/messages";
import { createProduct, updateProduct } from "../../lib/server/products/manage";
import { markOrderPaid } from "../../lib/server/queue/service";
import { createCategory, listCategoryProducts, reorderCategoryProducts, setProductCategories } from "../../lib/server/shop-category/service";
import { getDisplay, setListSort, setSections } from "../../lib/server/shop-display/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 상품 진열 확장(SA-016): 방송·베스트·할인·명예의 전당 영역, 진열 옵션 3개, 카테고리 안 진열 순서
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" };
const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const shippingAddress = { recipientName: "김구매", phone: "01012345678", zipCode: "06236", address1: "서울 강남구 테헤란로 1" };

async function seller() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, grade, owner, ctx };
}
async function made(ctx: TenantContext, name: string, body: Record<string, unknown> = {}) {
  const r = await createProduct(db, ctx, { name, price: 1000, status: "ON_SALE", options: [{ name: "o", stock: 50 }], ...body });
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}
const home = async (slug: string) => {
  const res = await homeRoute(new Request("http://localhost:3000/x"), { params: Promise.resolve({ slug }) });
  return (await res.json()) as { sections: { kind: string; title: string; products: { name: string }[] }[] };
};
const titles = (b: Awaited<ReturnType<typeof home>>) => b.sections.map((s) => [s.kind, s.products.map((p) => p.name)]);
const listNames = async (slug: string, qs = "") => {
  const res = await listRoute(new Request(`http://localhost:3000/api/shop/${slug}/products?${qs}`), { params: Promise.resolve({ slug }) });
  return (await res.json()).products.map((p: { name: string }) => p.name);
};

// 결제 완료 주문을 만들고, live면 그 방송의 대기열로 넣는다(방송 중 주문)
async function paidOrder(s: Awaited<ReturnType<typeof seller>>, optionId: string, quantity: number, liveId?: string) {
  const buyer = await createLoginBuyer(s.seller.id, s.grade.id);
  const o = await createOrder(db, { sellerId: s.seller.id, buyerMemberId: buyer.id, items: [{ optionId, quantity }], consent, shippingAddress });
  if (!o.ok) throw new Error(o.reason);
  await markOrderPaid(db, { sellerId: s.seller.id, orderId: o.orderId, paymentMethod: "CARD" });
  const q = await db.queueItem.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId: s.seller.id, orderId: o.orderId } });
  if (liveId) await db.queueItem.update({ where: { id: q.id }, data: { broadcastSessionId: liveId } });
  return q;
}

describe("새 진열 영역", () => {
  it("방송 상품(지금 방송 주문)·베스트(결제 완료 판매량)·할인 중(이벤트)·명예의 전당(HIT 카드)을 홈에 보이고, 종류마다 하나씩만", async () => {
    const s = await seller();
    const a = await made(s.ctx, "A");
    const b = await made(s.ctx, "B");
    const c = await made(s.ctx, "C");
    const d = await made(s.ctx, "D");
    const e = await made(s.ctx, "E");
    const live = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "LIVE" } });
    const ended = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "ENDED", startedAt: new Date("2026-01-01T00:00:00Z"), endedAt: new Date("2026-01-01T01:00:00Z") } });
    await paidOrder(s, a.options[0].id, 1, live.id);
    const qb = await paidOrder(s, b.options[0].id, 5, live.id);
    await paidOrder(s, c.options[0].id, 2, ended.id); // 끝난 방송은 방송 상품 아님
    // 30일 넘은 판매는 베스트에 넣지 않는다
    const old = await paidOrder(s, d.options[0].id, 9);
    await db.order.update({ where: { id: old.orderId! }, data: { paidAt: new Date(Date.now() - 31 * 86_400_000) } });
    await db.queueItem.update({ where: { id: old.id }, data: { broadcastSessionId: null } }); // 방송 전 주문(결제 때 지금 방송에 붙은 것을 되돌림)
    // 취소된 대기열은 방송 상품이 아니다(오버레이와 같은 기준)
    const qe = await paidOrder(s, e.options[0].id, 1, live.id);
    await db.queueItem.update({ where: { id: qe.id }, data: { status: "CANCELLED" } });
    await db.order.update({ where: { id: qe.orderId! }, data: { status: "CANCELLED" } });
    await db.hitCard.create({ data: { sellerId: s.seller.id, queueItemId: qb.id, broadcastSessionId: live.id, nicknameSnapshot: "구매자", cardName: "리자몽 SAR" } });
    await db.product.update({
      where: { id: c.id },
      data: { eventDiscountType: "RATE", eventDiscountValue: 10, eventStartsAt: new Date(Date.now() - 60_000), eventEndsAt: new Date(Date.now() + 86_400_000) },
    });
    const r = await setSections(db, s.ctx, {
      sections: [
        { kind: "LIVE", title: "방송 중" },
        { kind: "BEST", title: "베스트", itemCount: 2 },
        { kind: "SALE", title: "할인 중" },
        { kind: "HALL_OF_FAME", title: "명예의 전당" },
      ],
    });
    expect(r).toMatchObject({ ok: true });
    expect(titles(await home(s.seller.slug))).toEqual([
      ["LIVE", ["B", "A"]], // 최근 주문 순
      ["BEST", ["B", "C"]], // 최근 30일 결제 완료 판매량(D는 31일 전, E는 취소)
      ["SALE", ["C"]],
      ["HALL_OF_FAME", ["B"]],
    ]);
    // 방송이 끝나면 방송 상품·명예의 전당 영역은 빠진다(오버레이처럼 지금 방송 기준)
    await db.broadcastSession.update({ where: { id: live.id }, data: { status: "ENDED", endedAt: new Date() } });
    expect(titles(await home(s.seller.slug)).map((x) => x[0])).toEqual(["BEST", "SALE"]);
    // 판매량이 같으면 최근에 팔린 상품이 앞
    await paidOrder(s, c.options[0].id, 3);
    expect(titles(await home(s.seller.slug))[0]).toEqual(["BEST", ["C", "B"]]);
    for (const kind of ["LIVE", "BEST", "SALE", "HALL_OF_FAME"]) {
      expect(await setSections(db, s.ctx, { sections: [{ kind, title: "a" }, { kind, title: "b" }] }), kind).toEqual({ ok: false, reason: "invalid_display_settings" });
    }
  });
});

describe("진열 옵션", () => {
  it("품절 맨 뒤로·품절 숨기기·방송 상품 앞으로가 구매자 목록과 홈에 걸리고, 다른 쇼핑몰에는 영향이 없다", async () => {
    const s = await seller();
    const other = await seller();
    const a = await made(s.ctx, "A");
    const b = await made(s.ctx, "B", { status: "SOLD_OUT" });
    const c = await made(s.ctx, "C");
    await made(other.ctx, "X", { status: "SOLD_OUT" });
    await made(other.ctx, "Y");
    for (const [p, t] of [
      [a, "2026-01-03"],
      [b, "2026-01-02"],
      [c, "2026-01-01"],
    ] as const) {
      await db.product.update({ where: { id: p.id }, data: { createdAt: new Date(`${t}T00:00:00Z`) } });
    }
    expect(await listNames(s.seller.slug)).toEqual(["A", "B", "C"]);
    expect(await setListSort(db, s.ctx, { soldOutLast: true })).toMatchObject({ ok: true, value: { listSort: "new", options: { soldOutLast: true, hideSoldOut: false, liveFirst: false } } });
    expect(await listNames(s.seller.slug)).toEqual(["A", "C", "B"]);
    await setListSort(db, s.ctx, { hideSoldOut: true });
    expect(await listNames(s.seller.slug)).toEqual(["A", "C"]);
    await setListSort(db, s.ctx, { hideSoldOut: false });

    // 방송 상품 앞으로: 지금 방송에서 주문된 C가 앞으로(품절 맨 뒤로는 그대로)
    const live = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "LIVE" } });
    await paidOrder(s, c.options[0].id, 1, live.id);
    expect(await listNames(s.seller.slug)).toEqual(["A", "C", "B"]);
    await setListSort(db, s.ctx, { liveFirst: true });
    expect(await listNames(s.seller.slug)).toEqual(["C", "A", "B"]);
    expect(await listNames(s.seller.slug, "sort=high")).toEqual(["C", "A", "B"]); // 고른 정렬에도 건다

    // 홈 신상품 영역에도 같은 옵션
    await setSections(db, s.ctx, { sections: [{ kind: "NEW", title: "신상품" }] });
    expect(titles(await home(s.seller.slug))).toEqual([["NEW", ["C", "A", "B"]]]);
    await setListSort(db, s.ctx, { hideSoldOut: true });
    expect(titles(await home(s.seller.slug))).toEqual([["NEW", ["C", "A"]]]);

    // 다른 쇼핑몰은 옵션이 꺼진 그대로
    expect(await listNames(other.seller.slug)).toEqual(["Y", "X"]);
    expect((await getDisplay(db, other.ctx)).options).toEqual({ soldOutLast: false, hideSoldOut: false, liveFirst: false });
    for (const body of [{}, { soldOutLast: "yes" }, { liveFirst: 1 }, { listSort: "name" }]) {
      expect(await setListSort(db, s.ctx, body)).toEqual({ ok: false, reason: "invalid_display_settings" });
    }
  });
});

describe("카테고리 안 진열 순서", () => {
  it("새로 지정하면 맨 뒤, 순서를 바꾸면 구매자 카테고리 목록(진열 순서)에 반영, 대분류는 직접 지정한 상품 → 하위 순, 목록이 다르면 거부", async () => {
    const s = await seller();
    const other = await seller();
    const top = await createCategory(db, s.ctx, { name: "카드" });
    if (!top.ok) throw new Error(top.reason);
    const topId = top.value[0].id;
    const sub = await createCategory(db, s.ctx, { name: "포켓몬", parentId: topId });
    if (!sub.ok) throw new Error(sub.reason);
    const subId = sub.value[0].children[0].id;
    const ps = [];
    for (const n of ["A", "B", "C"]) {
      const p = await made(s.ctx, n);
      await setProductCategories(db, s.ctx, p.id, { categoryIds: [topId] });
      ps.push(p);
    }
    const d = await made(s.ctx, "D");
    await setProductCategories(db, s.ctx, d.id, { categoryIds: [subId] });
    expect((await listCategoryProducts(db, s.ctx, topId)).map((x) => [x.name, x.sortOrder])).toEqual([
      ["A", 0],
      ["B", 1],
      ["C", 2],
    ]);
    const r = await reorderCategoryProducts(db, s.ctx, topId, { productIds: [ps[2].id, ps[0].id, ps[1].id] });
    expect(r).toMatchObject({ ok: true });
    expect(await listNames(s.seller.slug, `categoryId=${topId}&sort=recommended`)).toEqual(["C", "A", "B", "D"]);
    expect(await listNames(s.seller.slug, `categoryId=${subId}&sort=recommended`)).toEqual(["D"]);

    for (const productIds of [[ps[0].id], [ps[0].id, ps[0].id, ps[1].id], [ps[0].id, ps[1].id, d.id], "x"]) {
      expect(await reorderCategoryProducts(db, s.ctx, topId, { productIds })).toEqual({ ok: false, reason: "invalid_category_order" });
    }
    await expect(reorderCategoryProducts(db, other.ctx, topId, { productIds: [] })).rejects.toMatchObject({ status: 404 });
    await expect(listCategoryProducts(db, other.ctx, topId)).rejects.toMatchObject({ status: 404 });
    await expect(reorderCategoryProducts(db, { ...s.ctx, readOnly: true }, topId, { productIds: [] })).rejects.toMatchObject({ status: 403 });

    // 상품을 숨기거나 지워도 순서 목록은 지우지 않은 상품만
    await updateProduct(db, s.ctx, ps[0].id, { status: "HIDDEN" });
    expect((await listCategoryProducts(db, s.ctx, topId)).map((x) => x.name)).toEqual(["C", "A", "B"]);
    expect(await db.auditLog.count({ where: { sellerId: s.seller.id, action: "shop_category.product_order" } })).toBe(1);
  });
});

describe("HTTP", () => {
  it("권한 없는 직원 403, 다른 출처 403, 잘못된 본문 400·409와 문구", async () => {
    const s = await seller();
    const cat = await createCategory(db, s.ctx, { name: "카드" });
    if (!cat.ok) throw new Error(cat.reason);
    const cookie = async (email: string) => {
      const r = await loginSeller(db, { email, password: PASSWORD }, {});
      if (!r.ok) throw new Error(r.reason);
      return `lo_seller=${r.token}`;
    };
    const owner = await cookie(s.owner.email);
    const broadcaster = await cookie((await createSellerUser(s.seller.id, "BROADCASTER")).email);
    const put = (body: unknown, c = owner, headers: Record<string, string> = H) =>
      settingsPut(new Request("http://localhost:3000/api/seller/display/settings", { method: "PUT", headers: { ...headers, cookie: c }, body: JSON.stringify(body) }));
    expect((await put({ soldOutLast: true }, broadcaster)).status).toBe(403);
    expect((await put({ soldOutLast: true }, owner, { ...H, origin: "http://evil.example" })).status).toBe(403);
    const bad = await put({ soldOutLast: "y" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_display_settings", message: ORDER_ERROR_MESSAGES_FORMAL.invalid_display_settings });
    expect((await (await put({ liveFirst: true })).json()).options).toEqual({ soldOutLast: false, hideSoldOut: false, liveFirst: true });

    const pp = { params: Promise.resolve({ categoryId: cat.value[0].id }) };
    expect((await catProductsGet(new Request("http://localhost:3000/x", { headers: { ...H, cookie: broadcaster } }), pp)).status).toBe(403);
    expect(await (await catProductsGet(new Request("http://localhost:3000/x", { headers: { ...H, cookie: owner } }), pp)).json()).toEqual({ products: [] });
    const stale = await catProductsPut(new Request("http://localhost:3000/x", { method: "PUT", headers: { ...H, cookie: owner }, body: JSON.stringify({ productIds: ["00000000-0000-0000-0000-000000000000"] }) }), pp);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "invalid_category_order", message: ORDER_ERROR_MESSAGES_FORMAL.invalid_category_order });
  });
});
