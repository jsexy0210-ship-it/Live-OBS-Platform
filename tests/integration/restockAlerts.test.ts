import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as sellerRoute } from "../../app/api/seller/restock-alerts/route";
import { DELETE as removeRoute } from "../../app/api/shop/[slug]/restock-alerts/[productId]/route";
import { GET as listRoute, POST as addRoute } from "../../app/api/shop/[slug]/restock-alerts/route";
import { loginBuyer } from "../../lib/server/auth/login";
import { withdrawBuyer } from "../../lib/server/buyers/withdraw";
import { prisma } from "../../lib/server/db";
import { MAX_RESTOCK_ALERTS, RESTOCK_MESSAGES, listRestockAlerts, sweepRestock } from "../../lib/server/shop-restock-alerts/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 재입고 알림(SA-017)
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

async function cookieOf(sellerId: string, loginId: string) {
  const r = await loginBuyer(db, { sellerId, loginId, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_buyer=${r.token}`;
}

async function product(sellerId: string, name = "부스터 팩", stock = 0, data: Record<string, unknown> = {}) {
  const p = await db.product.create({ data: { sellerId, name, price: 5000, status: "ON_SALE", ...data } });
  const o = await db.productOption.create({ data: { sellerId, productId: p.id, name: "기본", stock } });
  return { p, o };
}

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const other = await createLoginBuyer(seller.id, grade.id);
  return { seller, grade, ctx, buyer, other, cookie: await cookieOf(seller.id, buyer.loginId), otherCookie: await cookieOf(seller.id, other.loginId) };
}

const req = (url: string, method: string, cookie?: string, body?: unknown) =>
  new Request(`http://localhost:3000${url}`, {
    method,
    headers: { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const p1 = (slug: string) => ({ params: Promise.resolve({ slug }) });
const list = (slug: string, cookie?: string) => listRoute(req(`/api/shop/${slug}/restock-alerts`, "GET", cookie), p1(slug));
const add = (slug: string, cookie: string | undefined, productId: unknown) => addRoute(req(`/api/shop/${slug}/restock-alerts`, "POST", cookie, { productId }), p1(slug));
const remove = (slug: string, cookie: string, productId: string) =>
  removeRoute(req(`/api/shop/${slug}/restock-alerts/${productId}`, "DELETE", cookie), { params: Promise.resolve({ slug, productId }) });

describe("재입고 알림", () => {
  it("로그인 전에는 401", async () => {
    const s = await shop();
    expect((await list(s.seller.slug)).status).toBe(401);
    expect((await add(s.seller.slug, undefined, "x")).status).toBe(401);
  });

  it("품절 상품만 신청(다시 신청해도 하나), 재고가 있으면 409, 취소는 신청한 것만", async () => {
    const s = await shop();
    const out = await product(s.seller.id);
    const inStock = await product(s.seller.id, "카드 슬리브", 5);
    expect(await (await add(s.seller.slug, s.cookie, out.p.id)).json()).toEqual({ productId: out.p.id, count: 1 });
    const again = await add(s.seller.slug, s.cookie, out.p.id);
    expect([again.status, (await again.json()).count]).toEqual([200, 1]);
    const r = await add(s.seller.slug, s.cookie, inStock.p.id);
    expect([r.status, (await r.json()).error]).toEqual([409, "not_sold_out"]);
    expect((await add(s.seller.slug, s.cookie, "bad")).status).toBe(400);
    expect((await remove(s.seller.slug, s.otherCookie, out.p.id)).status).toBe(404);
    expect((await remove(s.seller.slug, s.cookie, out.p.id)).status).toBe(200);
    expect((await remove(s.seller.slug, s.cookie, out.p.id)).status).toBe(404);
  });

  it("준비 중·숨김·삭제 상품과 다른 쇼핑몰 상품은 신청할 수 없다", async () => {
    const s = await shop();
    const o = await createSeller();
    for (const data of [{ status: "DRAFT" }, { status: "HIDDEN" }, { deletedAt: new Date() }]) {
      const x = await product(s.seller.id, "x", 0, data);
      expect((await add(s.seller.slug, s.cookie, x.p.id)).status).toBe(409);
    }
    const foreign = await product(o.seller.id);
    expect((await add(s.seller.slug, s.cookie, foreign.p.id)).status).toBe(409);
  });

  it("회원당 상한", async () => {
    const s = await shop();
    const p = await product(s.seller.id);
    const prods = await Promise.all(Array.from({ length: MAX_RESTOCK_ALERTS }, (_, i) => product(s.seller.id, `p${i}`)));
    await db.restockAlert.createMany({ data: prods.map((x) => ({ sellerId: s.seller.id, buyerMemberId: s.buyer.id, productId: x.p.id })) });
    const r = await add(s.seller.slug, s.cookie, p.p.id);
    expect([r.status, (await r.json()).message]).toEqual([409, RESTOCK_MESSAGES.restock_full]);
  });

  it("재고가 들어오면 대기 → 발송 대기, 야간 예약은 시각이 지나야 발송 기록", async () => {
    const s = await shop();
    const x = await product(s.seller.id);
    await add(s.seller.slug, s.cookie, x.p.id);
    await add(s.seller.slug, s.otherCookie, x.p.id);
    await sweepRestock(db, s.seller.id);
    expect((await db.restockAlert.findMany({ select: { status: true } })).map((r) => r.status)).toEqual(["WAITING", "WAITING"]);
    await db.productOption.update({ where: { id: x.o.id }, data: { stock: 3 } });
    await sweepRestock(db, s.seller.id);
    const rows = await db.restockAlert.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.every((r) => r.restockedAt && r.notifyAt)).toBe(true);
    expect(rows.every((r) => r.status === "QUEUED" || r.status === "SENT")).toBe(true);
    // 첫 건은 미래 예약(야간), 둘째는 지난 예약으로 맞춘다
    await db.restockAlert.update({ where: { id: rows[0].id }, data: { status: "QUEUED", notifyAt: new Date(Date.now() + 3600_000), notifiedAt: null } });
    await db.restockAlert.update({ where: { id: rows[1].id }, data: { status: "QUEUED", notifyAt: new Date(Date.now() - 1000), notifiedAt: null } });
    await sweepRestock(db, s.seller.id);
    const after = await db.restockAlert.findMany({ orderBy: { createdAt: "asc" } });
    expect([after[0].status, after[0].notifiedAt]).toEqual(["QUEUED", null]);
    expect([after[1].status, after[1].notifiedAt === null]).toEqual(["SENT", false]);
  });

  it("판매 중지·품절 표시 상품은 재고가 있어도 보내지 않고, 보낸 뒤 품절이 되어 다시 신청하면 처음부터", async () => {
    const s = await shop();
    const x = await product(s.seller.id);
    await add(s.seller.slug, s.cookie, x.p.id);
    await db.productOption.update({ where: { id: x.o.id }, data: { stock: 2 } });
    await db.product.update({ where: { id: x.p.id }, data: { status: "HIDDEN" } });
    await sweepRestock(db, s.seller.id);
    expect((await db.restockAlert.findFirstOrThrow()).status).toBe("WAITING");
    await db.product.update({ where: { id: x.p.id }, data: { status: "ON_SALE" } });
    await sweepRestock(db, s.seller.id);
    await db.restockAlert.updateMany({ data: { status: "SENT", notifiedAt: new Date() } });
    await db.productOption.update({ where: { id: x.o.id }, data: { stock: 0 } });
    expect((await add(s.seller.slug, s.cookie, x.p.id)).status).toBe(201);
    const row = await db.restockAlert.findFirstOrThrow();
    expect([row.status, row.restockedAt, row.notifyAt, row.notifiedAt]).toEqual(["WAITING", null, null, null]);
  });

  it("판매자 목록은 상품별 수만(회원 정보 없음), 권한 없는 직원·다른 판매자는 못 본다", async () => {
    const s = await shop();
    const a = await product(s.seller.id, "가 상품");
    const b = await product(s.seller.id, "나 상품");
    await add(s.seller.slug, s.cookie, a.p.id);
    await add(s.seller.slug, s.otherCookie, a.p.id);
    await add(s.seller.slug, s.cookie, b.p.id);
    const res = await listRestockAlerts(db, s.ctx);
    expect(res.items.map((i) => [i.name, i.soldOut, i.waiting, i.queued, i.sent])).toEqual([
      ["가 상품", true, 2, 0, 0],
      ["나 상품", true, 1, 0, 0],
    ]);
    expect(JSON.stringify(res)).not.toContain(s.buyer.id);
    const staff: TenantContext = { ...s.ctx, isOwner: false, permissions: [] };
    await expect(listRestockAlerts(db, staff)).rejects.toBeDefined();
    const o = await shop();
    expect((await listRestockAlerts(db, o.ctx)).items).toEqual([]);
    expect((await sellerRoute(req("/api/seller/restock-alerts", "GET"))).status).toBe(401);
  });

  it("내 목록은 내 신청만, 탈퇴하면 지워진다", async () => {
    const s = await shop();
    const x = await product(s.seller.id);
    await add(s.seller.slug, s.cookie, x.p.id);
    await add(s.seller.slug, s.otherCookie, x.p.id);
    const mine = await (await list(s.seller.slug, s.cookie)).json();
    expect([mine.count, mine.items[0].status, mine.items[0].name]).toEqual([1, "WAITING", "부스터 팩"]);
    const w = await withdrawBuyer(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id }, { password: PASSWORD });
    expect(w).toEqual({ ok: true });
    expect(await db.restockAlert.count({ where: { buyerMemberId: s.buyer.id } })).toBe(0);
    expect(await db.restockAlert.count({ where: { buyerMemberId: s.other.id } })).toBe(1);
  });
});
