import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as route } from "../../app/api/seller/stats/funnel/route";
import { createSellerSession } from "../../lib/server/auth/session";
import { addToCart } from "../../lib/server/shop-cart/service";
import { SCHEDULED_JOBS } from "../../lib/server/jobs/scheduler";
import { funnelStats, purgeFunnelDaily, purgeFunnelSeen, recordCartAdd, recordProductView, resetFunnelMemo } from "../../lib/server/stats/funnel";
import { parseStatsRange } from "../../lib/server/stats/range";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 전환 단계 통계(상품 상세 → 장바구니 → 주문 → 결제): 기록·중복 제거·보관·조회
const KEY = "test-identity-hash-key-0123456789abcdef";
beforeAll(() => {
  process.env.IDENTITY_HASH_KEY = KEY;
});
beforeEach(async () => {
  await resetDb();
  resetFunnelMemo();
});
afterAll(() => db.$disconnect());

type Shop = Awaited<ReturnType<typeof createSeller>>;
const cookieOf = async (s: Shop, user: Awaited<ReturnType<typeof createSellerUser>>) =>
  `lo_seller=${(await createSellerSession(db, s.seller.id, user.id, {}, user.credentialVersion)).token}`;
const get = (q: string, cookie?: string) => route(new Request(`http://localhost:3000/api/seller/stats/funnel?${q}`, { headers: { host: "localhost:3000", ...(cookie ? { cookie } : {}) } }));
const product = (s: Shop, name: string, extra: Record<string, unknown> = {}) => db.product.create({ data: { sellerId: s.seller.id, name, price: 1000, status: "ON_SALE", ...extra } });
const daily = (sellerId: string, productId: string) => db.productFunnelDaily.findMany({ where: { sellerId, productId }, orderBy: { day: "asc" } });

// KST 10/5 정오 = 10/5 03:00Z
const T0 = new Date("2026-10-05T03:00:00Z");
const NEXT_DAY = new Date("2026-10-06T03:00:00Z");

describe("기록", () => {
  it("같은 회원이 같은 상품을 같은 날 여러 번 봐도 한 번만 세고, 다른 회원·다른 날은 따로 센다", async () => {
    const s = await createSeller();
    const [m1, m2] = await Promise.all([createBuyer(s.seller.id, s.grade.id), createBuyer(s.seller.id, s.grade.id)]);
    const p = await product(s, "상품");
    const sc = (m: { id: string }) => ({ sellerId: s.seller.id, buyerMemberId: m.id });
    for (let i = 0; i < 3; i++) await recordProductView(db, sc(m1), p.id, T0);
    await recordProductView(db, sc(m2), p.id, T0);
    resetFunnelMemo(); // 다른 서버처럼 메모리 기억이 없어도 DB 유니크가 막는다
    await recordProductView(db, sc(m1), p.id, T0);
    await recordProductView(db, sc(m1), p.id, NEXT_DAY);
    const rows = await daily(s.seller.id, p.id);
    expect(rows.map((r) => [r.day.toISOString().slice(0, 10), r.views, r.cartAdds])).toEqual([["2026-10-05", 2, 0], ["2026-10-06", 1, 0]]);
  });

  it("장바구니 담기는 조회와 따로 세고, 회원 원문 식별자는 저장하지 않는다(일 단위 해시)", async () => {
    const x = await createSeller();
    const s = Object.assign(await createBuyer(x.seller.id, x.grade.id), { sellerId: x.seller.id });
    const shop = { sellerId: s.sellerId, buyerMemberId: s.id };
    const p = await product(x, "상품");
    await recordProductView(db, shop, p.id, T0);
    await recordCartAdd(db, shop, p.id, T0);
    await recordCartAdd(db, shop, p.id, T0);
    const [row] = await daily(s.sellerId, p.id);
    expect([row.views, row.cartAdds]).toEqual([1, 1]);
    const seen = await db.productFunnelSeen.findMany({ where: { sellerId: s.sellerId } });
    expect(seen.map((x) => x.kind).sort()).toEqual(["C", "V"]);
    for (const x of seen) {
      expect(x.viewerHash).toMatch(/^[0-9a-f]{64}$/);
      expect(x.viewerHash).not.toContain(s.id);
    }
    // 다음 날은 같은 회원도 다른 해시
    await recordProductView(db, shop, p.id, NEXT_DAY);
    const hashes = (await db.productFunnelSeen.findMany({ where: { kind: "V" } })).map((x) => x.viewerHash);
    expect(new Set(hashes).size).toBe(2);
  });

  it("실패는 삼킨다: 잘못된 상품 id·비밀키 없음이어도 던지지 않고, 키가 없으면 아무것도 기록하지 않는다", async () => {
    const s = await createSeller();
    const m = await createBuyer(s.seller.id, s.grade.id);
    const sc = { sellerId: s.seller.id, buyerMemberId: m.id };
    await expect(recordProductView(db, sc, "not-a-uuid", T0)).resolves.toBeUndefined();
    const p = await product(s, "상품");
    process.env.IDENTITY_HASH_KEY = "";
    await expect(recordProductView(db, sc, p.id, T0)).resolves.toBeUndefined();
    process.env.IDENTITY_HASH_KEY = "short";
    await expect(recordCartAdd(db, sc, p.id, T0)).resolves.toBeUndefined();
    process.env.IDENTITY_HASH_KEY = KEY;
    expect(await db.productFunnelDaily.count()).toBe(0);
    expect(await db.productFunnelSeen.count()).toBe(0);
  });

  it("동시에 여러 번 불러도 한 번만 센다", async () => {
    const s = await createSeller();
    const m = await createBuyer(s.seller.id, s.grade.id);
    const p = await product(s, "상품");
    await Promise.all(Array.from({ length: 10 }, () => recordProductView(db, { sellerId: s.seller.id, buyerMemberId: m.id }, p.id, T0)));
    expect((await daily(s.seller.id, p.id))[0].views).toBe(1);
  });
});

describe("장바구니 담기 연결", () => {
  it("담기가 성공했을 때만 담기 횟수가 늘고, 실패(품절)하면 세지 않으며, 같은 날 또 담아도 한 번이다", async () => {
    const s = await createSeller();
    const m = await createBuyer(s.seller.id, s.grade.id);
    const p = await product(s, "상품");
    const ok = await db.productOption.create({ data: { sellerId: s.seller.id, productId: p.id, name: "옵션", stock: 5 } });
    const empty = await db.productOption.create({ data: { sellerId: s.seller.id, productId: p.id, name: "품절 옵션", stock: 0 } });
    const scope = { sellerId: s.seller.id, buyerMemberId: m.id };
    expect((await addToCart(db, scope, { optionId: empty.id, quantity: 1 })).ok).toBe(false);
    expect(await db.productFunnelDaily.count()).toBe(0);
    expect((await addToCart(db, scope, { optionId: ok.id, quantity: 1 })).ok).toBe(true);
    expect((await addToCart(db, scope, { optionId: ok.id, quantity: 1 })).ok).toBe(true);
    const rows = await daily(s.seller.id, p.id);
    expect(rows).toHaveLength(1);
    expect([rows[0].views, rows[0].cartAdds]).toEqual([0, 1]);
  });
});

describe("보관", () => {
  it("중복 제거 표는 8일, 일 집계는 400일이 지난 것을 지우고, 정기 작업에 등록돼 있다", async () => {
    const s = await createSeller();
    const p = await product(s, "상품");
    const now = new Date("2026-10-05T03:00:00Z"); // KST 10/5
    const seen = (day: string) => db.productFunnelSeen.create({ data: { sellerId: s.seller.id, productId: p.id, day: new Date(day), kind: "V", viewerHash: day } });
    await seen("2026-09-27"); // 8일 전(남김: 기준일 9/27 이상)
    await seen("2026-09-26"); // 9일 전 → 삭제
    expect(await db.$transaction((tx) => purgeFunnelSeen(tx, now))).toBe(1);
    expect((await db.productFunnelSeen.findMany()).map((x) => x.viewerHash)).toEqual(["2026-09-27"]);
    const d = (day: string) => db.productFunnelDaily.create({ data: { sellerId: s.seller.id, productId: p.id, day: new Date(day), views: 1 } });
    await d("2025-08-31"); // 400일 전(남김)
    await d("2025-08-30"); // 401일 전 → 삭제
    await d("2026-10-05");
    expect(await db.$transaction((tx) => purgeFunnelDaily(tx, now))).toBe(1);
    expect(await db.productFunnelDaily.count()).toBe(2);
    expect(SCHEDULED_JOBS.map((j) => j.name)).toEqual(expect.arrayContaining(["product_funnel_seen.purge_old", "product_funnel_daily.purge_old"]));
  });
});

describe("조회 GET /api/seller/stats/funnel", () => {
  async function seed() {
    const s = await createSeller();
    const owner = await createSellerUser(s.seller.id, "OWNER");
    const ctx: TenantContext = { sellerId: s.seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
    const members = await Promise.all(Array.from({ length: 4 }, () => createBuyer(s.seller.id, s.grade.id)));
    const a = await product(s, "상품A");
    const b = await product(s, "상품B");
    const gone = await product(s, "지운 상품", { deletedAt: new Date() });
    // 조회: A 4명, B 2명, 지운 상품 1명. 담기: A 2명, B 1명
    for (const m of members) await recordProductView(db, { sellerId: s.seller.id, buyerMemberId: m.id }, a.id, T0);
    for (const m of members.slice(0, 2)) await recordProductView(db, { sellerId: s.seller.id, buyerMemberId: m.id }, b.id, T0);
    await recordProductView(db, { sellerId: s.seller.id, buyerMemberId: members[0].id }, gone.id, T0);
    for (const m of members.slice(0, 2)) await recordCartAdd(db, { sellerId: s.seller.id, buyerMemberId: m.id }, a.id, T0);
    await recordCartAdd(db, { sellerId: s.seller.id, buyerMemberId: members[0].id }, b.id, T0);
    // 주문: A는 2건(1건 결제), B는 1건(결제). 기간 밖 주문 1건은 뺀다
    const order = async (m: { id: string }, p: { id: string; name: string }, at: string, paid: boolean) => {
      const o = await db.productOption.create({ data: { sellerId: s.seller.id, productId: p.id, name: "옵션", stock: 5 } });
      const ord = await db.order.create({
        data: { sellerId: s.seller.id, orderNo: Math.floor(Math.random() * 1e9), buyerMemberId: m.id, broadcastNicknameSnapshot: "닉", totalAmount: 1000, status: paid ? "PAID" : "PENDING_PAYMENT", createdAt: new Date(at), paidAt: paid ? new Date(at) : null } as never,
      });
      await db.orderItem.create({ data: { sellerId: s.seller.id, orderId: ord.id, productId: p.id, optionId: o.id, productNameSnapshot: p.name, optionNameSnapshot: "옵션", unitPrice: 1000, quantity: 1 } });
    };
    await order(members[0], a, "2026-10-05T04:00:00Z", true);
    await order(members[1], a, "2026-10-05T05:00:00Z", false);
    await order(members[0], b, "2026-10-05T06:00:00Z", true);
    await order(members[2], a, "2026-11-20T04:00:00Z", true); // 기간 밖
    return { s, owner, ctx, a, b };
  }

  it("상품별·전체 조회→담기→주문→결제와 단계 비율을 주고, 지운 상품은 뺀다", async () => {
    const { s, owner } = await seed();
    const res = await get("from=2026-10-01&to=2026-10-07", await cookieOf(s, owner));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.basis).toBe("login_members");
    expect(body.totals).toEqual({ views: 6, cartAdds: 3, orders: 3, paidOrders: 2, viewToCart: 0.5, cartToOrder: 1, orderToPaid: 0.6667 });
    expect(body.products.map((p: { name: string }) => p.name)).toEqual(["상품A", "상품B"]);
    expect(body.products[0]).toMatchObject({ views: 4, cartAdds: 2, orders: 2, paidOrders: 1, viewToCart: 0.5, cartToOrder: 1, orderToPaid: 0.5 });
    expect(body.products[1]).toMatchObject({ views: 2, cartAdds: 1, orders: 1, paidOrders: 1, viewToCart: 0.5, cartToOrder: 1, orderToPaid: 1 });
  });

  it("기록이 없으면 비율은 null이고, 기간 밖 기록은 세지 않는다", async () => {
    const { s, owner } = await seed();
    const none = await (await get("from=2026-09-01&to=2026-09-07", await cookieOf(s, owner))).json();
    expect(none.totals).toEqual({ views: 0, cartAdds: 0, orders: 0, paidOrders: 0, viewToCart: null, cartToOrder: null, orderToPaid: null });
    expect(none.products).toEqual([]);
  });

  it("다른 쇼핑몰 기록은 섞이지 않고, 통계 권한 직원만 보며, 잘못된 기간 400·무로그인 401", async () => {
    const { s, owner } = await seed();
    const other = await createSeller();
    const om = await createBuyer(other.seller.id, other.grade.id);
    await recordProductView(db, { sellerId: other.seller.id, buyerMemberId: om.id }, (await product(other, "남의 상품")).id, T0);
    const q = "from=2026-10-01&to=2026-10-07";
    expect((await (await get(q, await cookieOf(s, owner))).json()).totals.views).toBe(6);
    const withPerm = await createSellerUser(s.seller.id, { permissions: ["SALES_VIEW"] });
    const without = await createSellerUser(s.seller.id, { permissions: ["INQUIRY_REPLY"] });
    expect((await get(q, await cookieOf(s, withPerm))).status).toBe(200);
    expect((await get(q, await cookieOf(s, without))).status).toBe(403);
    expect((await get("from=2026-10-07&to=2026-10-01", await cookieOf(s, withPerm))).status).toBe(400);
    expect((await get(q)).status).toBe(401);
  });
});

// 전체 합계가 상품 목록을 20개로 자른 것과 무관한지(합계는 전체 기준)
it("상품별 목록은 20개까지이고 합계는 전체 기준이다", async () => {
  const s = await createSeller();
  const m = await createBuyer(s.seller.id, s.grade.id);
  for (let i = 0; i < 22; i++) await recordProductView(db, { sellerId: s.seller.id, buyerMemberId: m.id }, (await product(s, `P${i}`)).id, T0);
  const range = parseStatsRange({ from: "2026-10-01", to: "2026-10-07" });
  if (!range) throw new Error("range");
  const owner = await createSellerUser(s.seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: s.seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const r = await funnelStats(db, ctx, range);
  expect(r.products).toHaveLength(20);
  expect(r.totals.views).toBe(22);
});
