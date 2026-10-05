import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as historyRoute } from "../../app/api/seller/broadcast/history/route";
import { loginSeller } from "../../lib/server/auth/login";
import { HISTORY_PAGE } from "../../lib/server/broadcast/history";
import { prisma } from "../../lib/server/db";
import { PASSWORD, createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";

// SA-054 방송 이력: 최신순·다음 쪽·기간(KST, 시작일 기준)·방송별 집계, 권한(BROADCAST_RUN), 판매자 격리, 잘못된 기간 400.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const MIN = 60_000;
async function cookieOf(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}
async function shop() {
  const { seller, grade } = await createSeller();
  const buyer = await createBuyer(seller.id, grade.id);
  const owner = await createSellerUser(seller.id, "OWNER");
  const runner = await createSellerUser(seller.id, { permissions: ["BROADCAST_RUN"] });
  const other = await createSellerUser(seller.id, { permissions: ["PRODUCT_MANAGE"] });
  return { seller, buyer, owner: await cookieOf(owner.email), runner: await cookieOf(runner.email), noPerm: await cookieOf(other.email) };
}
const history = async (cookie: string, q = "") => {
  const res = await historyRoute(new Request(`${BASE}/api/seller/broadcast/history${q}`, { headers: { host: "localhost:3000", cookie } }));
  return { status: res.status, body: await res.json() };
};
const session = (sellerId: string, startedAt: Date, minutes = 60, title?: string) =>
  db.broadcastSession.create({ data: { sellerId, status: "ENDED", title, startedAt, endedAt: new Date(startedAt.getTime() + minutes * MIN) } });

describe("방송 이력", () => {
  it("최신순, 방송별 집계, 기간 필터(KST 시작일), 다른 판매자 방송은 없다", async () => {
    const s = await shop();
    const t = await shop();
    // 10월 1일 23:30 KST 시작(UTC로는 14:30) — KST 날짜 경계 확인
    const late = await session(s.seller.id, new Date("2026-10-01T23:30:00+09:00"), 60, "밤 방송");
    const day2 = await session(s.seller.id, new Date("2026-10-02T20:00:00+09:00"), 60, "금요 방송");
    const { order } = await createPaidOrderItem(s.seller.id, s.buyer.id);
    await db.order.update({ where: { id: order.id }, data: { createdAt: new Date("2026-10-02T20:10:00+09:00"), paidAt: new Date("2026-10-02T20:10:00+09:00") } });
    await db.hitCard.create({ data: { sellerId: s.seller.id, nicknameSnapshot: "a", cardName: "뮤", createdAt: new Date("2026-10-02T20:20:00+09:00") } });
    await session(t.seller.id, new Date("2026-10-02T21:00:00+09:00"), 60, "남의 방송");

    for (const cookie of [s.owner, s.runner]) {
      const r = await history(cookie);
      expect(r.status).toBe(200);
      expect(r.body.items.map((b: { id: string }) => b.id)).toEqual([day2.id, late.id]);
      expect(r.body.items[0]).toMatchObject({ title: "금요 방송", status: "ended", summary: { orders: 1, paidOrders: 1, sales: 5000, completed: 0, cancelled: 0, hits: 1 } });
      expect(r.body.items[1].summary).toEqual({ orders: 0, paidOrders: 0, sales: 0, completed: 0, cancelled: 0, hits: 0 });
    }
    expect((await history(s.owner, "?from=2026-10-01&to=2026-10-01")).body.items.map((b: { id: string }) => b.id)).toEqual([late.id]);
    expect((await history(s.owner, "?from=2026-10-02")).body.items.map((b: { id: string }) => b.id)).toEqual([day2.id]);
    expect((await history(s.owner, "?to=2026-10-01")).body.items.map((b: { id: string }) => b.id)).toEqual([late.id]);
    expect((await history(t.owner)).body.items.map((b: { title: string }) => b.title)).toEqual(["남의 방송"]);
    expect((await history(s.noPerm)).status).toBe(403);
    for (const q of ["?from=2026-02-30", "?from=2026-10-02&to=2026-10-01", "?to=10/01"]) {
      expect(await history(s.owner, q)).toEqual({ status: 400, body: { error: "invalid_range", message: "조회 기간을 다시 확인해 주십시오" } });
    }
  });

  it("50개씩 다음 쪽, 방송 중인 방송도 나온다", async () => {
    const s = await shop();
    const base = new Date("2026-09-01T10:00:00+09:00");
    for (let i = 0; i < HISTORY_PAGE + 1; i++) await session(s.seller.id, new Date(base.getTime() + i * 120 * MIN));
    const live = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "LIVE", startedAt: new Date(Date.now() - 10 * MIN) } });
    const p1 = await history(s.owner);
    expect([p1.body.items.length, p1.body.items[0].id, p1.body.items[0].status, p1.body.items[0].endedAt]).toEqual([HISTORY_PAGE, live.id, "live", null]);
    const p2 = await history(s.owner, `?cursor=${p1.body.nextCursor}`);
    expect([p2.body.items.length, p2.body.nextCursor]).toEqual([2, null]);
    expect(new Set([...p1.body.items, ...p2.body.items].map((b: { id: string }) => b.id)).size).toBe(HISTORY_PAGE + 2);
  });
});
