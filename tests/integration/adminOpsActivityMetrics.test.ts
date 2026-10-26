import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as activityGet } from "../../app/api/admin/ops/seller-activity/route";
import { GET as exportGet } from "../../app/api/admin/ops/seller-activity/export/route";
import { listSellerActivity } from "../../lib/server/admin/ops";
import { createAdminSession, resolveAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { createAdmin, createBuyer, createPaidOrderItem, createSeller, db, resetDb } from "./helpers";

// 주문·방송 화면 접속 현황(MA-042) 확장: 주문대기·개봉·취소·끊김 지표, 정렬, 내려받기.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { host: "localhost:3000" };
async function admin(role: "SUPER_ADMIN" | "READ_ONLY" = "READ_ONLY") {
  const a = await createAdmin(role);
  const s = await createAdminSession(db, a.id, {});
  return { cookie: `lo_admin=${s.token}`, ctx: (await resolveAdminSession(db, s.token))! };
}
async function shop() {
  const s = await createSeller();
  return { ...s, buyer: await createBuyer(s.seller.id, s.grade.id) };
}
const ago = (min: number) => new Date(Date.now() - min * 60_000);
let pos = 0;
async function queue(s: Awaited<ReturnType<typeof shop>>, o: { received: Date; status?: "WAITING" | "DONE" | "CANCELLED"; open?: [Date, Date]; cancelled?: Date; external?: boolean }) {
  const p = await createPaidOrderItem(s.seller.id, s.buyer.id);
  await db.queueItem.create({
    data: {
      sellerId: s.seller.id, orderId: p.order.id, orderItemId: p.item.id, position: ++pos, receivedAt: o.received, nicknameSnapshot: "닉", productLabel: "박스", quantity: 1,
      ...(o.status === "DONE" && o.open ? { status: "DONE", openingStartedAt: o.open[0], doneAt: o.open[1] } : {}),
      ...(o.status === "CANCELLED" ? { status: "CANCELLED", cancelledAt: o.cancelled ?? o.received } : {}),
    },
  });
}
const event = (s: Awaited<ReturnType<typeof shop>>, kind: "DISCONNECTED" | "RECOVERED", at: Date, downSeconds?: number) =>
  db.broadcastEvent.create({ data: { sellerId: s.seller.id, kind, at, ...(downSeconds === undefined ? {} : { downSeconds }) } });

describe("MA-042 지표·정렬·내려받기", () => {
  it("기간 안 주문대기 등록·개봉 완료·취소(취소율)·평균 오픈과 끊김·복구·평균 끊김을 파트너스별·전체로 준다", async () => {
    const a = await shop();
    const b = await shop();
    const v = await admin();
    await queue(a, { received: ago(30), status: "DONE", open: [ago(20), new Date(ago(20).getTime() + 40_000)] });
    await queue(a, { received: ago(29), status: "DONE", open: [ago(19), new Date(ago(19).getTime() + 60_000)] });
    await queue(a, { received: ago(28), status: "CANCELLED", cancelled: ago(10) });
    await queue(a, { received: ago(27) });
    await queue(b, { received: ago(5) });
    await event(a, "DISCONNECTED", ago(15));
    await event(a, "RECOVERED", ago(14), 60);
    await event(a, "DISCONNECTED", ago(8));
    await event(a, "RECOVERED", ago(7), 30);
    const r = await listSellerActivity(db, v.ctx, { period: "30d" });
    if (!r.ok) throw new Error(r.reason);
    const ia = r.items.find((x) => x.sellerId === a.seller.id)!;
    const ib = r.items.find((x) => x.sellerId === b.seller.id)!;
    expect(ia.queue).toEqual({ registered: 4, externalRegistered: 0, done: 2, cancelled: 1, cancelRatePercent: 25, avgOpenSeconds: 50 });
    expect(ia.screen).toEqual({ disconnected: 2, recovered: 2, avgDownSeconds: 45 });
    expect(ib.queue).toMatchObject({ registered: 1, done: 0, cancelled: 0, cancelRatePercent: 0, avgOpenSeconds: null });
    expect(ib.screen).toEqual({ disconnected: 0, recovered: 0, avgDownSeconds: null });
    expect(r.summary.queue).toMatchObject({ registered: 5, done: 2, cancelled: 1, cancelRatePercent: 20, avgOpenSeconds: 50 });
    expect(r.summary.screen).toEqual({ disconnected: 2, recovered: 2, avgDownSeconds: 45 });
    // 기간 밖(오늘 0시 이전) 기록은 오늘 기간에서 빠진다: 어제 새벽 이벤트
    await event(b, "DISCONNECTED", new Date(Date.now() - 3 * 86_400_000));
    const today = await listSellerActivity(db, v.ctx, { period: "today" });
    if (!today.ok) throw new Error(today.reason);
    expect(today.items.find((x) => x.sellerId === b.seller.id)!.screen.disconnected).toBe(0);
    const thirty = await listSellerActivity(db, v.ctx, { period: "30d" });
    expect(thirty.ok && thirty.items.find((x) => x.sellerId === b.seller.id)!.screen.disconnected).toBe(1);
  });

  it("정렬: 주문 많은 순·끊김 많은 순·최근 접속 순(순번 커서로 이어 받기), 잘못된 정렬·커서는 400", async () => {
    const shops = [await shop(), await shop(), await shop()];
    const v = await admin();
    // 주문: shops[1] 2건, shops[2] 1건 / 끊김: shops[2] 3번, shops[0] 1번 / 접속: shops[0]가 가장 최근
    await createPaidOrderItem(shops[1].seller.id, shops[1].buyer.id);
    await createPaidOrderItem(shops[1].seller.id, shops[1].buyer.id);
    await createPaidOrderItem(shops[2].seller.id, shops[2].buyer.id);
    for (let i = 0; i < 3; i++) await event(shops[2], "DISCONNECTED", ago(30 - i));
    await event(shops[0], "DISCONNECTED", ago(5));
    await db.overlayToken.create({ data: { sellerId: shops[0].seller.id, tokenHash: "h0", lastSeenAt: ago(1) } }).catch(() => null);
    const ids = async (sort: string, cursor?: string) => {
      const r = await listSellerActivity(db, v.ctx, { period: "today", sort, cursor });
      if (!r.ok) throw new Error(r.reason);
      return r.items.map((x) => x.sellerId);
    };
    const [s0, s1, s2] = shops.map((x) => x.seller.id);
    expect((await ids("orders")).slice(0, 2)).toEqual([s1, s2]);
    expect((await ids("disconnects")).slice(0, 2)).toEqual([s2, s0]);
    // 순번 커서: 한 쪽 10곳이라 3곳이면 nextCursor 없음
    const first = await listSellerActivity(db, v.ctx, { sort: "orders" });
    expect(first.ok && first.nextCursor).toBeNull();
    expect(await listSellerActivity(db, v.ctx, { sort: "bogus" })).toEqual({ ok: false, reason: "invalid_sort" });
    expect(await listSellerActivity(db, v.ctx, { sort: "orders", cursor: "x:1" })).toEqual({ ok: false, reason: "invalid_cursor" });
    const res = await activityGet(new Request("http://localhost:3000/api/admin/ops/seller-activity?sort=nope", { headers: { ...H, cookie: v.cookie } }));
    expect(res.status).toBe(400);
  });

  it("정렬 쪽 이동: 11곳이면 첫 쪽 10곳 + o:10 커서로 나머지 1곳, 겹침·빠짐 없음", async () => {
    const v = await admin();
    const made: string[] = [];
    for (let i = 0; i < 11; i++) made.push((await shop()).seller.id);
    const p1 = await listSellerActivity(db, v.ctx, { sort: "orders" });
    if (!p1.ok) throw new Error(p1.reason);
    expect(p1.items).toHaveLength(10);
    expect(p1.nextCursor).toBe("o:10");
    const p2 = await listSellerActivity(db, v.ctx, { sort: "orders", cursor: p1.nextCursor!, asOf: p1.at.toISOString() });
    if (!p2.ok) throw new Error(p2.reason);
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect([...p1.items, ...p2.items].map((x) => x.sellerId).sort()).toEqual([...made].sort());
  });

  it("내려받기: 모든 마스터 역할이 목록과 같은 조건으로 CSV를 받고(BOM·열 이름·수식 방어), 로그 추적에 조건과 건수만 남는다", async () => {
    const a = await shop();
    await db.seller.update({ where: { id: a.seller.id }, data: { shopName: "=SUM(A1)" } });
    await queue(a, { received: ago(5), status: "CANCELLED", cancelled: ago(2) });
    const v = await admin("READ_ONLY");
    const res = await exportGet(new Request("http://localhost:3000/api/admin/ops/seller-activity/export?period=30d&sort=orders", { headers: { ...H, cookie: v.cookie } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("x-truncated")).toBe("0");
    expect([...new Uint8Array(await res.clone().arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM
    const text = await res.text(); // text()는 BOM을 떼고 돌려준다
    expect(text.startsWith("쇼핑몰 이름,쇼핑몰 주소,상태,")).toBe(true);
    expect(text).toContain("'=SUM(A1)");
    expect(text).toContain("주문대기 등록");
    const log = await db.auditLog.findFirst({ where: { action: "admin.ops.activity.export" } });
    expect(log?.after).toMatchObject({ period: "30d", sort: "orders", count: 1 });
    expect(JSON.stringify(log?.after)).not.toContain("SUM");
    const bad = await exportGet(new Request("http://localhost:3000/api/admin/ops/seller-activity/export?period=1y", { headers: { ...H, cookie: v.cookie } }));
    expect(bad.status).toBe(400);
    expect((await exportGet(new Request("http://localhost:3000/api/admin/ops/seller-activity/export", { headers: H }))).status).toBe(401);
  });
});
