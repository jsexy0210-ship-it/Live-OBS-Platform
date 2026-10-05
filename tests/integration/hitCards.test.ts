import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DELETE as deleteRoute } from "../../app/api/seller/hit-cards/[hitCardId]/route";
import { GET as listRoute, POST as createRoute } from "../../app/api/seller/hit-cards/route";
import { loginSeller } from "../../lib/server/auth/login";
import { HIT_MESSAGES, HIT_PAGE_SIZE } from "../../lib/server/broadcast/hitCards";
import { prisma } from "../../lib/server/db";
import { getOverlayState } from "../../lib/server/overlay/state";
import { PASSWORD, createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";

// SA-053 HIT 카드: 등록(주문대기 항목·닉네임)·해제·목록 필터·cursor, 권한(BROADCAST_RUN), 판매자 격리, 오버레이 반영, 감사 로그.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const json = (path: string, method: string, cookie: string, body?: unknown) =>
  new Request(BASE + path, { method, headers: { ...H, "content-type": "application/json", cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
async function queueItem(sellerId: string, buyerId: string, broadcastSessionId: string | null) {
  const { order, item } = await createPaidOrderItem(sellerId, buyerId);
  return db.queueItem.create({
    data: { sellerId, orderId: order.id, orderItemId: item.id, broadcastSessionId, status: "OPENING", position: 1, receivedAt: new Date(), nicknameSnapshot: "피카츄팬", productLabel: "부스터 팩", quantity: 1 },
    include: { order: true },
  });
}
const create = async (cookie: string, body: unknown) => {
  const res = await createRoute(json("/api/seller/hit-cards", "POST", cookie, body));
  return { status: res.status, body: await res.json() };
};
const list = async (cookie: string, q = "") => {
  const res = await listRoute(new Request(`${BASE}/api/seller/hit-cards${q}`, { headers: { ...H, cookie } }));
  return { status: res.status, body: await res.json() };
};
const remove = (cookie: string, id: string) => deleteRoute(json(`/api/seller/hit-cards/${id}`, "DELETE", cookie), { params: Promise.resolve({ hitCardId: id }) });

describe("HIT 카드", () => {
  it("주문대기 항목으로 등록하면 그 닉네임·구매자·지금 방송으로 남고, 오버레이에 바로 보인다", async () => {
    const s = await shop();
    const live = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "LIVE", title: "오늘 방송" } });
    const q = await queueItem(s.seller.id, s.buyer.id, live.id);
    const before = (await db.seller.findUniqueOrThrow({ where: { id: s.seller.id } })).liveVersion;
    const r = await create(s.runner, { cardName: "리자몽 SAR", note: "첫 히트", queueItemId: q.id });
    expect(r.status).toBe(201);
    expect(r.body.card).toMatchObject({ cardName: "리자몽 SAR", note: "첫 히트", nickname: "피카츄팬", broadcast: { id: live.id, title: "오늘 방송" }, order: { id: q.orderId, orderNo: q.order.orderNo, productLabel: "부스터 팩" } });
    const row = await db.hitCard.findUniqueOrThrow({ where: { id: r.body.card.id } });
    expect([row.buyerMemberId, row.queueItemId, row.createdByUserId]).toEqual([s.buyer.id, q.id, expect.any(String)]);
    expect((await db.seller.findUniqueOrThrow({ where: { id: s.seller.id } })).liveVersion).toBe(before + 1);
    expect((await getOverlayState(db, s.seller.id)).hits.map((h) => h.cardName)).toEqual(["리자몽 SAR"]);
    expect(await db.auditLog.count({ where: { sellerId: s.seller.id, action: "hit_card.create" } })).toBe(1);
  });

  it("닉네임만으로도 등록, 잘못된 값·다른 판매자 주문대기 항목은 400, 권한 없는 직원은 403", async () => {
    const s = await shop();
    const t = await shop();
    const tq = await queueItem(t.seller.id, t.buyer.id, null);
    expect((await create(s.owner, { cardName: "뮤", nickname: "손님1" })).body.card).toMatchObject({ nickname: "손님1", broadcast: null, order: null });
    for (const [body, error] of [
      [{ cardName: "", nickname: "a" }, "invalid_card_name"],
      [{ cardName: "가".repeat(61), nickname: "a" }, "invalid_card_name"],
      [{ cardName: "뮤" }, "invalid_nickname"],
      [{ cardName: "뮤", nickname: "a", note: "가".repeat(201) }, "invalid_note"],
      [{ cardName: "뮤", queueItemId: "x" }, "invalid_queue_item"],
      [{ cardName: "뮤", queueItemId: tq.id }, "invalid_queue_item"],
    ] as const) {
      const r = await create(s.owner, body);
      expect([r.status, r.body]).toEqual([400, { error, message: HIT_MESSAGES[error] }]);
    }
    expect((await create(s.noPerm, { cardName: "뮤", nickname: "a" })).status).toBe(403);
    expect((await list(s.noPerm)).status).toBe(403);
    expect(await db.hitCard.count({ where: { sellerId: s.seller.id } })).toBe(1);
  });

  it("목록: 최신순·다음 쪽·방송·기간 필터, 다른 판매자 카드는 없다", async () => {
    const s = await shop();
    const t = await shop();
    const b1 = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "ENDED", startedAt: new Date("2026-09-01T10:00:00+09:00"), endedAt: new Date("2026-09-01T12:00:00+09:00") } });
    await db.hitCard.create({ data: { sellerId: s.seller.id, broadcastSessionId: b1.id, nicknameSnapshot: "a", cardName: "9월 카드", createdAt: new Date("2026-09-01T11:00:00+09:00") } });
    for (let i = 0; i < HIT_PAGE_SIZE; i++) {
      await db.hitCard.create({ data: { sellerId: s.seller.id, nicknameSnapshot: "a", cardName: `10월${i}`, createdAt: new Date(Date.UTC(2026, 9, 2, 0, i)) } });
    }
    await db.hitCard.create({ data: { sellerId: t.seller.id, nicknameSnapshot: "a", cardName: "남의 카드" } });
    const p1 = await list(s.owner);
    expect([p1.body.items.length, p1.body.items[0].cardName]).toEqual([HIT_PAGE_SIZE, `10월${HIT_PAGE_SIZE - 1}`]);
    const p2 = await list(s.runner, `?cursor=${p1.body.nextCursor}`);
    expect([p2.body.items.map((c: { cardName: string }) => c.cardName), p2.body.nextCursor]).toEqual([["9월 카드"], null]);
    expect((await list(s.owner, `?broadcastId=${b1.id}`)).body.items.map((c: { cardName: string }) => c.cardName)).toEqual(["9월 카드"]);
    expect((await list(s.owner, "?from=2026-09-01&to=2026-09-01")).body.items).toHaveLength(1);
    expect((await list(s.owner, "?from=2026-10-02&to=2026-10-02")).body.items).toHaveLength(HIT_PAGE_SIZE);
    expect((await list(t.owner, `?broadcastId=${b1.id}`)).body.items).toEqual([]);
    for (const q of ["?from=2026-02-30", "?from=2026-10-02&to=2026-10-01", "?broadcastId=x"]) expect((await list(s.owner, q)).status).toBe(400);
  });

  it("해제하면 지워지고 오버레이에서 빠진다. 다른 판매자 카드는 404", async () => {
    const s = await shop();
    const t = await shop();
    await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "LIVE" } });
    const id = (await create(s.runner, { cardName: "뮤", nickname: "a" })).body.card.id;
    expect((await remove(t.owner, id)).status).toBe(404);
    expect((await remove(s.noPerm, id)).status).toBe(403);
    expect((await remove(s.runner, id)).status).toBe(200);
    expect((await getOverlayState(db, s.seller.id)).hits).toEqual([]);
    expect((await remove(s.runner, id)).status).toBe(404);
    expect(await db.auditLog.count({ where: { sellerId: s.seller.id, action: "hit_card.delete" } })).toBe(1);
  });
});
