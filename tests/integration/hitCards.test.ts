import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DELETE as deleteRoute } from "../../app/api/seller/hit-cards/[hitCardId]/route";
import { GET as overlayStateRoute } from "../../app/api/overlay/[token]/state/route";
import { POST as replayRoute } from "../../app/api/seller/hit-cards/[hitCardId]/replay/route";
import { GET as exportRoute } from "../../app/api/seller/hit-cards/export/route";
import { GET as listRoute, POST as createRoute } from "../../app/api/seller/hit-cards/route";
import { loginSeller } from "../../lib/server/auth/login";
import { HIT_MESSAGES, HIT_PAGE_SIZE } from "../../lib/server/broadcast/hitCards";
import { prisma } from "../../lib/server/db";
import { getOverlayState } from "../../lib/server/overlay/state";
import { issueOverlayToken } from "../../lib/server/overlay/token";
import type { TenantContext } from "../../lib/server/tenant/context";
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
    expect(r.body.card).toMatchObject({ cardName: "리자몽 SAR", note: "첫 히트", nickname: "피카츄팬", broadcast: { id: live.id, title: "오늘 방송" }, order: { id: q.orderId, orderNo: q.order!.orderNo, orderNoLabel: expect.stringMatching(/^\d{8}-\d{4,}$/), productLabel: "부스터 팩" } });
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

describe("HIT 카드 등급(SA-053)", () => {
  it("등급(SAR·SR·UR·SE·SP·AA)을 받아 저장하고 비워 둘 수 있으며, 목록에 grade·grades가 있고 ?grade= 필터로 거른다. 자유 입력(예: L-P)도 받고 형식 오류는 400이다", async () => {
    const s = await shop();
    const a = await create(s.owner, { cardName: "뮤 ex", nickname: "가", grade: "SAR" });
    const b = await create(s.owner, { cardName: "이브이", nickname: "나", grade: "SR" });
    const c = await create(s.owner, { cardName: "무등급", nickname: "다" });
    const d = await create(s.owner, { cardName: "빈 등급", nickname: "라", grade: "" });
    expect([a.status, b.status, c.status, d.status]).toEqual([201, 201, 201, 201]);
    expect([a.body.card.grade, b.body.card.grade, c.body.card.grade, d.body.card.grade]).toEqual(["SAR", "SR", null, null]);
    const free = await create(s.owner, { cardName: "루피", nickname: "바", grade: "  L-P " });
    expect([free.status, free.body.card.grade]).toEqual([201, "L-P"]);
    for (const bad of ["가".repeat(13), 1, true, "\u200b"]) {
      const r = await create(s.owner, { cardName: "x", nickname: "마", grade: bad });
      expect(r.status, String(bad)).toBe(400);
      expect(r.body).toEqual({ error: "invalid_grade", message: HIT_MESSAGES.invalid_grade });
    }
    const all = await list(s.owner);
    expect(all.body.grades).toEqual(["SAR", "SR", "UR", "SE", "SP", "AA"]);
    const pairs = all.body.items.map((x: { cardName: string; grade: string | null }) => [x.cardName, x.grade]);
    expect(pairs).toHaveLength(5);
    expect(pairs).toEqual(expect.arrayContaining([["무등급", null], ["빈 등급", null], ["뮤 ex", "SAR"], ["이브이", "SR"], ["루피", "L-P"]]));
    expect((await list(s.owner, "?grade=SAR")).body.items.map((x: { cardName: string }) => x.cardName)).toEqual(["뮤 ex"]);
    expect((await list(s.owner, "?grade=UR")).body.items).toEqual([]);
    expect((await list(s.owner, "?grade=L-P")).body.items.map((x: { cardName: string }) => x.cardName)).toEqual(["루피"]);
    expect((await list(s.owner, `?grade=${"가".repeat(13)}`)).status).toBe(400);
    expect(await db.auditLog.count({ where: { action: "hit_card.create", sellerId: s.seller.id } })).toBe(5);
  });
});

describe("HIT 카드 기록 쪽 이동·내보내기(SA-053)", () => {
  const exportCsv = (cookie: string, q = "") => exportRoute(new Request(BASE + "/api/seller/hit-cards/export" + q, { headers: { ...H, cookie } }));

  it("total은 조건에 맞는 전체 건수이고 offset으로 쪽을 바로 옮긴다(cursor보다 우선). 잘못된 offset은 400이다", async () => {
    const s = await shop();
    const t = await shop();
    for (let i = 0; i < HIT_PAGE_SIZE + 3; i++) await db.hitCard.create({ data: { sellerId: s.seller.id, nicknameSnapshot: "a", grade: i % 2 ? "SR" : "SAR", cardName: `카드${i}`, createdAt: new Date(Date.UTC(2026, 9, 2, 0, i)) } });
    await db.hitCard.create({ data: { sellerId: t.seller.id, nicknameSnapshot: "a", cardName: "남의 카드" } });
    const p1 = await list(s.owner);
    expect([p1.body.total, p1.body.items.length]).toEqual([HIT_PAGE_SIZE + 3, HIT_PAGE_SIZE]);
    const last = await list(s.owner, `?offset=${HIT_PAGE_SIZE}&cursor=${p1.body.nextCursor}`);
    expect([last.body.items.map((c: { cardName: string }) => c.cardName), last.body.nextCursor]).toEqual([["카드2", "카드1", "카드0"], null]);
    // 등급 조건이 있으면 total도 그 조건의 건수
    const sr = await list(s.owner, "?grade=SR&offset=0");
    expect([sr.body.total, sr.body.items.length]).toEqual([6, 6]);
    expect((await list(t.owner)).body.total).toBe(1);
    expect((await list(s.owner, `?offset=${HIT_PAGE_SIZE * 100}`)).body.items).toEqual([]);
    for (const q of ["?offset=-1", "?offset=abc", "?offset=1.5", "?offset=9999999"]) expect((await list(s.owner, q)).status).toBe(400);
  });

  it("목록에 주문대기 접수 시각(orderReceivedAt)이 있고 직접 입력한 카드는 null이다", async () => {
    const s = await shop();
    const q = await queueItem(s.seller.id, s.buyer.id, null);
    await create(s.owner, { cardName: "주문 카드", queueItemId: q.id });
    await create(s.owner, { cardName: "직접 카드", nickname: "가" });
    const items = (await list(s.owner)).body.items as { cardName: string; orderReceivedAt: string | null }[];
    expect(items.map((c) => [c.cardName, c.orderReceivedAt])).toEqual([["직접 카드", null], ["주문 카드", q.receivedAt.toISOString()]]);
  });

  it("내보내기: 조건에 맞는 카드 전체를 최신순 CSV로. 권한·격리·잘못된 조건·감사", async () => {
    const s = await shop();
    const t = await shop();
    const b = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "ENDED", title: "10/2 방송", startedAt: new Date("2026-10-02T10:00:00+09:00"), endedAt: new Date("2026-10-02T12:00:00+09:00") } });
    await db.hitCard.create({ data: { sellerId: s.seller.id, broadcastSessionId: b.id, nicknameSnapshot: "별빛", grade: "SAR", cardName: "=SUM(1)", note: "메모, 쉼표", createdAt: new Date("2026-10-02T11:03:00+09:00") } });
    await db.hitCard.create({ data: { sellerId: s.seller.id, nicknameSnapshot: "가나", cardName: "피카츄", createdAt: new Date("2026-10-03T09:00:00+09:00") } });
    await db.hitCard.create({ data: { sellerId: t.seller.id, nicknameSnapshot: "x", cardName: "남의 카드" } });
    const res = await exportCsv(s.runner);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const lines = (await res.text()).replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    expect(lines).toEqual([
      "카드,일시,등급,구매자,주문 접수,방송,메모",
      "피카츄,2026.10.03 09:00,,가나,,,",
      "'=SUM(1),2026.10.02 11:03,SAR,별빛,,10/2 방송,\"메모, 쉼표\"",
    ]);
    expect((await (await exportCsv(s.owner, `?broadcastId=${b.id}`)).text()).trim().split(/\r?\n/)).toHaveLength(2);
    expect((await exportCsv(s.noPerm)).status).toBe(403);
    for (const q of ["?from=2026-02-30", "?broadcastId=x"]) expect((await exportCsv(s.owner, q)).status).toBe(400);
    expect(await db.auditLog.count({ where: { sellerId: s.seller.id, action: "hit_card.export" } })).toBe(2);
  });
});

describe("HIT 카드 방송 화면 노출·다시 연출(SA-053)", () => {
  it("오버레이가 카드를 읽어 가면 노출 기록(pending→shown), 방송이 끝나도 안 읽혔으면 skipped. 다시 연출하면 비우고 replayedAt을 올린다", async () => {
    const s = await shop();
    const t = await shop();
    const live = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "LIVE" } });
    const a = (await create(s.runner, { cardName: "A 카드", nickname: "가" })).body.card as { id: string };
    // 방송이 끝난 뒤 남은 카드와 방송 없이 등록된 카드: 안 읽혔으면 노출 생략
    const old = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "ENDED", startedAt: new Date(Date.now() - 7_200_000), endedAt: new Date(Date.now() - 3_600_000) } });
    await db.hitCard.create({ data: { sellerId: s.seller.id, broadcastSessionId: old.id, nicknameSnapshot: "나", cardName: "지난 카드" } });
    await db.hitCard.create({ data: { sellerId: s.seller.id, nicknameSnapshot: "다", cardName: "방송 없음" } });
    const overlay = (items: { cardName: string; overlay: { status: string; shownAt: string | null } }[]) => Object.fromEntries(items.map((c) => [c.cardName, c.overlay.status]));
    expect(overlay((await list(s.owner)).body.items)).toEqual({ "A 카드": "pending", "지난 카드": "skipped", "방송 없음": "skipped" });

    const ownerUser = await db.sellerUser.findFirstOrThrow({ where: { sellerId: s.seller.id, isOwner: true } });
    const ctx: TenantContext = { sellerId: s.seller.id, actorType: "SELLER_USER", actorId: ownerUser.id, isOwner: true, permissions: ownerUser.permissions, readOnly: false };
    const token = await issueOverlayToken(db, ctx);
    const read = async () => {
      const res = await overlayStateRoute(new Request(`http://localhost:3000/api/overlay/${token}/state`), { params: Promise.resolve({ token }) });
      return (await res.json()) as { hits: { id: string; replayedAt: string | null }[]; unshownHitIds?: unknown; version: number };
    };
    const first = await read();
    expect(first.hits.map((h) => h.id)).toEqual([a.id]);
    expect(first.unshownHitIds).toBeUndefined(); // 내부 값은 화면에 나가지 않는다
    const shown = (await list(s.owner)).body.items.find((c: { cardName: string }) => c.cardName === "A 카드");
    expect(shown.overlay.status).toBe("shown");
    const at = shown.overlay.shownAt;
    await read(); // 다시 읽어도 처음 시각을 유지
    expect((await list(s.owner)).body.items.find((c: { cardName: string }) => c.cardName === "A 카드").overlay.shownAt).toBe(at);
    // 다른 쇼핑몰 오버레이는 이 카드를 읽지도 노출 기록도 바꾸지 못한다(판매자 격리)
    expect((await list(t.owner)).body.items).toEqual([]);

    // 다시 연출: 노출 기록 비움 + replayedAt + 버전 증가 + 감사. 오버레이가 다시 읽으면 shown
    const v0 = (await db.seller.findUniqueOrThrow({ where: { id: s.seller.id } })).liveVersion;
    const rp = await replayRoute(json(`/api/seller/hit-cards/${a.id}/replay`, "POST", s.runner), { params: Promise.resolve({ hitCardId: a.id }) });
    expect(rp.status).toBe(200);
    expect((await db.seller.findUniqueOrThrow({ where: { id: s.seller.id } })).liveVersion).toBe(v0 + 1);
    expect((await list(s.owner)).body.items.find((c: { cardName: string }) => c.cardName === "A 카드").overlay.status).toBe("pending");
    const again = await read();
    expect(again.hits[0].replayedAt).not.toBeNull();
    expect((await list(s.owner)).body.items.find((c: { cardName: string }) => c.cardName === "A 카드").overlay.status).toBe("shown");
    expect(await db.auditLog.count({ where: { sellerId: s.seller.id, action: "hit_card.replay" } })).toBe(1);

    // 지난 방송 카드는 409, 다른 쇼핑몰은 404, 권한 없는 직원은 403
    const oldCard = await db.hitCard.findFirstOrThrow({ where: { cardName: "지난 카드" } });
    const call = (id: string, cookie: string) => replayRoute(json(`/api/seller/hit-cards/${id}/replay`, "POST", cookie), { params: Promise.resolve({ hitCardId: id }) });
    expect((await call(oldCard.id, s.owner)).status).toBe(409);
    expect((await call(a.id, t.owner)).status).toBe(404);
    expect((await call(a.id, s.noPerm)).status).toBe(403);
    expect(live.id).toBeTruthy();
  });
});
