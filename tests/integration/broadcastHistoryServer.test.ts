import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as historyRoute } from "../../app/api/seller/broadcast/history/route";
import { GET as exportRoute } from "../../app/api/seller/broadcast/history/export/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { exportBroadcastHistory, monthBroadcastSummary } from "../../lib/server/broadcast/history";
import { PASSWORD, createAdmin, createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";

// SA-054 방송 기록: 이번 달(KST) 요약 4칸, 내보내기(조건 전체·최신순·권한·격리·감사).
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const MIN = 60_000;
const at = (iso: string) => new Date(iso);
async function cookieOf(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}
async function shop() {
  const { seller, grade } = await createSeller();
  const buyer = await createBuyer(seller.id, grade.id);
  const owner = await createSellerUser(seller.id, "OWNER");
  const other = await createSellerUser(seller.id, { permissions: ["PRODUCT_MANAGE"] });
  return { seller, buyer, owner: await cookieOf(owner.email), noPerm: await cookieOf(other.email) };
}
async function order(sellerId: string, buyerId: string, createdAt: Date, status: "PAID" | "REFUNDED", refundAmount?: number) {
  const { order, item } = await createPaidOrderItem(sellerId, buyerId);
  await db.order.update({ where: { id: order.id }, data: { createdAt, status, paidAt: createdAt, refundAmount: refundAmount ?? null } });
  return { order, item };
}
let pos = 0;
async function opened(sellerId: string, o: { order: { id: string }; item: { id: string } }, start: Date, seconds: number) {
  await db.queueItem.create({
    data: { sellerId, orderId: o.order.id, orderItemId: o.item.id, status: "DONE", position: ++pos, receivedAt: start, nicknameSnapshot: "닉", productLabel: "박스", quantity: 1, openingStartedAt: start, doneAt: new Date(start.getTime() + seconds * 1000) },
  });
}
const get = (route: typeof historyRoute, path: string, cookie: string) => route(new Request(BASE + path, { headers: { host: "localhost:3000", cookie } }));

describe("방송 기록 이번 달 요약", () => {
  it("KST 이번 달 방송만 방송 수·시간·주문·방송당 평균 매출·평균 오픈 시간으로 센다", async () => {
    const s = await shop();
    const now = at("2026-10-20T03:00:00Z"); // KST 10/20 12:00
    const mk = (startedAt: string, endedAt: string | null, title: string) =>
      db.broadcastSession.create({ data: { sellerId: s.seller.id, title, startedAt: at(startedAt), endedAt: endedAt ? at(endedAt) : null, status: endedAt ? "ENDED" : "LIVE" } });
    await mk("2026-09-30T14:30:00Z", "2026-09-30T15:20:00Z", "지난달"); // KST 9/30 23:30 — 제외
    await mk("2026-09-30T15:30:00Z", "2026-09-30T16:30:00Z", "1일 새벽"); // KST 10/1 00:30 — 포함, 3600초
    await mk("2026-10-10T10:00:00Z", "2026-10-10T11:30:00Z", "중순"); // 5400초
    await mk("2026-10-20T02:00:00Z", null, "진행 중"); // 지금까지 3600초
    const o0 = await order(s.seller.id, s.buyer.id, at("2026-09-30T14:40:00Z"), "PAID");
    await opened(s.seller.id, o0, at("2026-09-30T14:41:00Z"), 1000); // 지난달 — 평균에서 제외
    const o1 = await order(s.seller.id, s.buyer.id, at("2026-09-30T15:40:00Z"), "PAID"); // 5000
    await opened(s.seller.id, o1, at("2026-09-30T15:41:00Z"), 30);
    const o2 = await order(s.seller.id, s.buyer.id, at("2026-10-10T10:10:00Z"), "PAID"); // 5000
    await opened(s.seller.id, o2, at("2026-10-10T10:11:00Z"), 90);
    await order(s.seller.id, s.buyer.id, at("2026-10-10T10:20:00Z"), "REFUNDED", 2000); // 결제 5000 − 환불 2000
    // 다른 쇼핑몰은 세지 않는다
    const t = await shop();
    await db.broadcastSession.create({ data: { sellerId: t.seller.id, title: "남의 방송", startedAt: at("2026-10-10T10:00:00Z"), endedAt: at("2026-10-10T11:00:00Z"), status: "ENDED" } });
    await order(t.seller.id, t.buyer.id, at("2026-10-10T10:10:00Z"), "PAID");

    // 주문 3(1+2), 매출 5000+8000=13000 ÷ 방송 3 = 4333, 시간 3600+5400+3600, 오픈 평균 (30+90)/2
    expect(await monthBroadcastSummary(db, s.seller.id, now)).toEqual({ broadcasts: 3, seconds: 12600, orders: 3, avgSales: 4333, avgOpenSeconds: 60 });
    expect(await monthBroadcastSummary(db, t.seller.id, now)).toEqual({ broadcasts: 1, seconds: 3600, orders: 1, avgSales: 5000, avgOpenSeconds: null });
    // 방송이 없는 달: 0과 null
    expect(await monthBroadcastSummary(db, s.seller.id, at("2026-11-02T03:00:00Z"))).toEqual({ broadcasts: 0, seconds: 0, orders: 0, avgSales: 0, avgOpenSeconds: null });
  });

  it("목록 응답에 monthSummary가 같이 오고 기간 필터와 상관없다", async () => {
    const s = await shop();
    const start = new Date(Date.now() - 120 * MIN);
    await db.broadcastSession.create({ data: { sellerId: s.seller.id, title: "방금", startedAt: start, endedAt: new Date(start.getTime() + 60 * MIN), status: "ENDED" } });
    const res = await get(historyRoute, "/api/seller/broadcast/history?from=2020-01-01&to=2020-01-02", s.owner);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.items).toEqual([]);
    expect(Object.keys(body.monthSummary).sort()).toEqual(["avgOpenSeconds", "avgSales", "broadcasts", "orders", "seconds"]);
  });
});

describe("방송 기록 내보내기", () => {
  it("방송 열람 범위가 있는 대리조회도 금전 CSV는 자료를 읽기 전에 403으로 막는다", async () => {
    const s = await shop();
    const admin = await createAdmin("SUPER_ADMIN");
    const findMany = vi.spyOn(db.broadcastSession, "findMany");
    try {
      await expect(exportBroadcastHistory(db, { sellerId: s.seller.id, actorType: "PLATFORM_ADMIN", actorId: admin.id, isOwner: false, permissions: [], readOnly: true, impersonationScopes: ["BROADCAST"] }, {})).rejects.toMatchObject({ status: 403, code: "forbidden" });
      expect(findMany).not.toHaveBeenCalled();
      expect(await db.auditLog.count({ where: { sellerId: s.seller.id, action: "broadcast.history.export" } })).toBe(0);
    } finally {
      findMany.mockRestore();
    }
  });

  it("조건에 맞는 방송 전체를 최신순 CSV로 내려주고 권한·격리·잘못된 기간을 막는다", async () => {
    const s = await shop();
    const mk = (title: string, hoursAgo: number, layoutAspect: string | null, live = false) => {
      const startedAt = new Date(Date.now() - hoursAgo * 3_600_000);
      return db.broadcastSession.create({ data: { sellerId: s.seller.id, title, startedAt, endedAt: live ? null : new Date(startedAt.getTime() + 90 * MIN), status: live ? "LIVE" : "ENDED", layoutAspect } });
    };
    const a = await mk("=SUM(1)", 30, "9x16");
    await mk("가로 방송", 20, "16x9");
    await mk("진행 중", 1, null, true);
    await order(s.seller.id, s.buyer.id, new Date(a.startedAt.getTime() + 10 * MIN), "PAID");
    const t = await shop();
    await db.broadcastSession.create({ data: { sellerId: t.seller.id, title: "남의 방송", startedAt: new Date(Date.now() - 3_600_000), endedAt: new Date(), status: "ENDED" } });

    const res = await get(exportRoute, "/api/seller/broadcast/history/export", s.owner);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const text = (await res.text()).replace(/^﻿/, "");
    const lines = text.trim().split(/\r?\n/);
    expect(lines[0]).toBe("제목,시작,종료,시간(초),주문,완료,뺀 주문,HIT,매출,레이아웃,상태");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^진행 중,.*,,,0,0,0,0,0,,진행 중$/);
    expect(lines[2]).toMatch(/^가로 방송,.*,5400,0,0,0,0,0,가로형,종료$/);
    expect(lines[3]).toMatch(/^'=SUM\(1\),.*,5400,1,0,0,0,5000,세로형,종료$/);
    expect(text).not.toContain("남의 방송");

    // 레이아웃 조건
    const vertical = (await (await get(exportRoute, "/api/seller/broadcast/history/export?layout=9x16", s.owner)).text()).trim().split(/\r?\n/);
    expect(vertical).toHaveLength(2);
    expect((await get(exportRoute, "/api/seller/broadcast/history/export", s.noPerm)).status).toBe(403);
    expect((await get(exportRoute, "/api/seller/broadcast/history/export?from=2026-13-01", s.owner)).status).toBe(400);
    expect((await get(exportRoute, "/api/seller/broadcast/history/export?layout=bad", s.owner)).status).toBe(400);
    expect(await db.auditLog.count({ where: { sellerId: s.seller.id, action: "broadcast.history.export" } })).toBe(2);
  });
});
