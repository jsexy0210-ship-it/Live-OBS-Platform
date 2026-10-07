import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as liveRoute } from "../../app/api/shop/[slug]/live/route";
import { GET as detailRoute } from "../../app/api/shop/[slug]/products/[productId]/route";
import { GET as recRoute } from "../../app/api/shop/[slug]/products/[productId]/recommendations/route";
import { GET as listRoute } from "../../app/api/shop/[slug]/products/route";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { createProduct } from "../../lib/server/products/manage";
import { markOrderPaid } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 지금 방송 중 표시: GET /api/shop/{slug}/live, 상품 카드·상세·추천의 isLive
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const shippingAddress = { recipientName: "김구매", phone: "01012345678", zipCode: "06236", address1: "서울 강남구 테헤란로 1" };

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const make = async (name: string) => {
    const r = await createProduct(db, ctx, { name, price: 1000, status: "ON_SALE", options: [{ name: "o", stock: 50 }] });
    if (!r.ok) throw new Error(r.reason);
    return r.value;
  };
  // 결제 완료 주문을 만들고 그 방송의 대기열로 넣는다(방송 중 주문)
  const orderIn = async (optionId: string, sessionId: string) => {
    const buyer = await createLoginBuyer(seller.id, grade.id);
    const o = await createOrder(db, { sellerId: seller.id, buyerMemberId: buyer.id, items: [{ optionId, quantity: 1 }], consent, shippingAddress });
    if (!o.ok) throw new Error(o.reason);
    await markOrderPaid(db, { sellerId: seller.id, orderId: o.orderId, paymentMethod: "CARD" });
    const q = await db.queueItem.findFirstOrThrow({ where: { sellerId: seller.id, orderId: o.orderId } });
    await db.queueItem.update({ where: { id: q.id }, data: { broadcastSessionId: sessionId } });
    return q;
  };
  const link = (data: Record<string, unknown>) => db.youtubeLiveLink.create({ data: { sellerId: seller.id, videoId: "abcDEF12345", title: "유튜브 제목", status: "LIVE", ...data } as never });
  return { seller, ctx, make, orderIn, link };
}
type Shop = Awaited<ReturnType<typeof shop>>;
const live = async (slug: string) => {
  const res = await liveRoute(new Request("http://localhost:3000/x"), { params: Promise.resolve({ slug }) });
  return { status: res.status, body: (await res.json()) as Record<string, any>, cache: res.headers.get("cache-control") };
};
const list = async (s: Shop) => ((await (await listRoute(new Request("http://localhost:3000/x"), { params: Promise.resolve({ slug: s.seller.slug }) })).json()) as { products: any[] }).products;

describe("GET /api/shop/{slug}/live", () => {
  it("방송이 없으면 live=false이고 나머지는 null이다", async () => {
    const s = await shop();
    const r = await live(s.seller.slug);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ live: false, title: null, startedAt: null, watchUrl: null });
    expect(r.cache).toBe("public, max-age=15");
  });

  it("진행 중 방송은 제목·시작 시각을 주고, 유튜브 연결이 없으면 watchUrl은 null이다", async () => {
    const s = await shop();
    const startedAt = new Date(Date.now() - 600_000);
    await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "LIVE", title: "오늘의 박스 오픈", startedAt } });
    const r = await live(s.seller.slug);
    expect(r.body).toEqual({ live: true, title: "오늘의 박스 오픈", startedAt: startedAt.toISOString(), watchUrl: null });
  });

  it("진행 중인 유튜브 연결이 있으면 보기 주소를 주고, 방송 제목이 없으면 영상 제목을 쓴다", async () => {
    const s = await shop();
    await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "LIVE" } });
    await s.link({});
    const r = await live(s.seller.slug);
    expect(r.body).toMatchObject({ live: true, title: "유튜브 제목", watchUrl: "https://www.youtube.com/watch?v=abcDEF12345" });
  });

  it("예정(UPCOMING)·끝난 유튜브 연결은 주소를 주지 않고, 끝난 방송은 방송 중이 아니다", async () => {
    const s = await shop();
    const session = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "LIVE", title: "방송" } });
    await s.link({ status: "UPCOMING" });
    expect((await live(s.seller.slug)).body.watchUrl).toBeNull();
    await db.youtubeLiveLink.updateMany({ where: { sellerId: s.seller.id }, data: { status: "ENDED" } });
    expect((await live(s.seller.slug)).body.watchUrl).toBeNull();
    await s.link({ videoId: "liveVid0001", status: "LIVE", broadcastSessionId: session.id });
    expect((await live(s.seller.slug)).body.watchUrl).toBe("https://www.youtube.com/watch?v=liveVid0001");
    await db.broadcastSession.update({ where: { id: session.id }, data: { status: "ENDED", endedAt: new Date() } });
    expect((await live(s.seller.slug)).body).toEqual({ live: false, title: null, startedAt: null, watchUrl: null });
  });

  it("다른 판매자의 방송·유튜브 연결은 섞이지 않고, 운영 중이 아닌 쇼핑몰·없는 쇼핑몰은 404이다", async () => {
    const a = await shop();
    const b = await shop();
    await db.broadcastSession.create({ data: { sellerId: b.seller.id, status: "LIVE", title: "남의 방송" } });
    await b.link({});
    expect((await live(a.seller.slug)).body).toEqual({ live: false, title: null, startedAt: null, watchUrl: null });
    expect((await live("no-such-shop")).status).toBe(404);
    await db.seller.update({ where: { id: b.seller.id }, data: { status: "SUSPENDED" } });
    expect((await live(b.seller.slug)).status).toBe(404);
  });
});

describe("상품의 isLive", () => {
  it("지금 방송에서 주문된 상품만 isLive이고, 끝난 방송·취소된 대기열·방송 밖 주문은 아니다", async () => {
    const s = await shop();
    const a = await s.make("방송중A");
    const b = await s.make("끝난방송B");
    const c = await s.make("취소C");
    const d = await s.make("일반D");
    const now = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "LIVE" } });
    const old = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "ENDED", startedAt: new Date("2026-01-01T00:00:00Z"), endedAt: new Date("2026-01-01T01:00:00Z") } });
    await s.orderIn(a.options[0].id, now.id);
    await s.orderIn(b.options[0].id, old.id);
    const qc = await s.orderIn(c.options[0].id, now.id);
    await db.queueItem.update({ where: { id: qc.id }, data: { status: "CANCELLED" } });
    const byName = Object.fromEntries((await list(s)).map((p) => [p.name, p.isLive]));
    expect(byName).toEqual({ 방송중A: true, 끝난방송B: false, 취소C: false, 일반D: false });
    expect(d.id).toBeTruthy();
  });

  it("상품 상세와 추천 상품 카드도 같은 isLive를 준다", async () => {
    const s = await shop();
    const a = await s.make("방송중A");
    const b = await s.make("일반B");
    const session = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "LIVE" } });
    await s.orderIn(a.options[0].id, session.id);
    await s.orderIn(a.options[0].id, session.id);
    const cancelled = await s.orderIn(a.options[0].id, session.id);
    await db.queueItem.update({ where: { id: cancelled.id }, data: { status: "CANCELLED" } });
    const previous = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "ENDED", startedAt: new Date(Date.now() - 60_000), endedAt: new Date() } });
    await s.orderIn(a.options[0].id, previous.id);
    const other = await shop();
    const otherProduct = await other.make("다른 판매자 상품");
    const otherSession = await db.broadcastSession.create({ data: { sellerId: other.seller.id, status: "LIVE" } });
    await other.orderIn(otherProduct.options[0].id, otherSession.id);
    const detail = async (id: string) => (await (await detailRoute(new Request("http://localhost:3000/x"), { params: Promise.resolve({ slug: s.seller.slug, productId: id }) })).json()) as { product: { isLive: boolean; broadcast: { waitingCount: number } | null } };
    expect((await detail(a.id)).product.isLive).toBe(true);
    expect((await detail(a.id)).product.broadcast).toEqual({ waitingCount: 2 });
    expect((await detail(b.id)).product.isLive).toBe(false);
    expect((await detail(b.id)).product.broadcast).toBeNull();
    const rec = (await (await recRoute(new Request("http://localhost:3000/x"), { params: Promise.resolve({ slug: s.seller.slug, productId: b.id }) })).json()) as { products: { name: string; isLive: boolean }[] };
    expect(rec.products.find((p) => p.name === "방송중A")?.isLive).toBe(true);
  });

  it("방송이 없으면 모든 상품이 isLive=false이고, 다른 판매자 방송은 영향이 없다", async () => {
    const a = await shop();
    const b = await shop();
    const p = await a.make("A상품");
    const bp = await b.make("B상품");
    const session = await db.broadcastSession.create({ data: { sellerId: b.seller.id, status: "LIVE" } });
    await b.orderIn(bp.options[0].id, session.id);
    expect((await list(a)).map((x) => x.isLive)).toEqual([false]);
    expect((await list(b)).map((x) => x.isLive)).toEqual([true]);
    expect(p.id).toBeTruthy();
  });
});
