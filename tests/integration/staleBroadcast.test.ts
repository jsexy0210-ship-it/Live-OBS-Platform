import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as forceEndRoute } from "../../app/api/admin/ops/live-broadcasts/[broadcastId]/end/route";
import { GET as infoGet } from "../../app/api/seller/overlay/address-info/route";
import { POST as tokenPost } from "../../app/api/seller/overlay/token/route";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession } from "../../lib/server/auth/session";
import { BROADCAST_ABANDON_MS, BROADCAST_STALE_MS, closeAbandonedBroadcasts } from "../../lib/server/broadcast/stale";
import { prisma } from "../../lib/server/db";
import { applyQueueAction, endBroadcast } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createAdmin, createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 방송이 LIVE로 남아도 재발급이 영구히 막히지 않는다 · 오래 버려진 방송 자동 종료 · 마스터 관리자 강제 종료
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const ago = (ms: number) => new Date(Date.now() - ms);

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const r = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  await db.overlayToken.create({ data: { sellerId: seller.id, tokenHash: `h-${seller.id}` } });
  return { seller, grade, ctx, cookie: `lo_seller=${r.token}` };
}
const live = (sellerId: string, startedAgo: number) => db.broadcastSession.create({ data: { sellerId, status: "LIVE", startedAt: ago(startedAgo) } });
const seen = (sellerId: string, msAgo: number | null) => db.overlayToken.updateMany({ where: { sellerId }, data: { lastSeenAt: msAgo === null ? null : ago(msAgo) } });
const issue = async (cookie: string) => (await tokenPost(new Request("http://localhost:3000/api/seller/overlay/token", { method: "POST", headers: { ...H, cookie }, body: "{}" }))).status;
const info = async (cookie: string) => (await infoGet(new Request("http://localhost:3000/api/seller/overlay/address-info", { headers: { ...H, cookie } }))).json();

describe("방송 중 재발급 기준", () => {
  it("신호가 최근이거나 방금 시작했으면 막고, 신호 없이 LIVE만 남았으면 허용한다", async () => {
    const s = await shop();
    await live(s.seller.id, 60 * 60_000); // 1시간 전 시작
    await seen(s.seller.id, 30_000); // 30초 전 접속 → 방송 중
    expect(await issue(s.cookie)).toBe(409);
    expect(await info(s.cookie)).toMatchObject({ live: true, liveSession: true });
    await seen(s.seller.id, BROADCAST_STALE_MS + 60_000); // 6분 전 → 신호 끊김
    expect(await info(s.cookie)).toMatchObject({ live: false, liveSession: true });
    expect(await issue(s.cookie)).toBe(200);
  });

  it("방금 시작한 방송은 접속 신호가 아직 없어도 막는다", async () => {
    const s = await shop();
    await live(s.seller.id, 60_000);
    await seen(s.seller.id, null);
    expect(await issue(s.cookie)).toBe(409);
  });
});

describe("오래 버려진 방송 자동 종료", () => {
  it("12시간 넘게 신호가 없고 개봉 중이 없는 방송만 끝내고, 감사 로그를 남긴다", async () => {
    const stale = await shop();
    const fresh = await shop();
    const justSeen = await shop();
    const a = await live(stale.seller.id, BROADCAST_ABANDON_MS + 3600_000);
    await live(fresh.seller.id, 3600_000);
    await live(justSeen.seller.id, BROADCAST_ABANDON_MS + 3600_000);
    await seen(stale.seller.id, BROADCAST_ABANDON_MS + 1800_000);
    await seen(justSeen.seller.id, 60_000);
    expect(await closeAbandonedBroadcasts(db)).toBe(1);
    expect((await db.broadcastSession.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("ENDED");
    expect(await db.broadcastSession.count({ where: { status: "LIVE" } })).toBe(2);
    expect(await db.auditLog.count({ where: { action: "broadcast.auto_end", targetId: a.id, actorType: "SYSTEM" } })).toBe(1);
    expect(await closeAbandonedBroadcasts(db)).toBe(0);
  });

  it("개봉 중이 남은 방송은 자동으로 끝내지 않는다", async () => {
    const s = await shop();
    const b = await live(s.seller.id, BROADCAST_ABANDON_MS + 3600_000);
    const buyer = await createBuyer(s.seller.id, s.grade.id);
    const o = await createPaidOrderItem(s.seller.id, buyer.id);
    await db.queueItem.create({ data: { sellerId: s.seller.id, orderId: o.order.id, orderItemId: o.item.id, broadcastSessionId: b.id, status: "OPENING", position: 1, receivedAt: new Date(), openingStartedAt: new Date(), nicknameSnapshot: "닉", productLabel: "박스", quantity: 1 } });
    expect(await closeAbandonedBroadcasts(db)).toBe(0);
    expect((await db.broadcastSession.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("LIVE");
  });
});

describe("마스터 관리자 강제 종료", () => {
  async function admin(role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY") {
    const a = await createAdmin(role);
    return `lo_admin=${(await createAdminSession(db, a.id, {})).token}`;
  }
  const end = async (cookie: string, id: string, body: unknown) => {
    const r = await forceEndRoute(new Request("http://localhost:3000/x", { method: "POST", headers: { ...H, cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ broadcastId: id }) });
    return { status: r.status, body: await r.json() };
  };

  it("개봉 중이 남아도 끝내고 그 항목은 그대로 두어 파트너스가 완료할 수 있다. 사유 필수·권한·이미 끝난 방송", async () => {
    const s = await shop();
    const b = await live(s.seller.id, 3600_000);
    const buyer = await createBuyer(s.seller.id, s.grade.id);
    const o = await createPaidOrderItem(s.seller.id, buyer.id);
    const q = await db.queueItem.create({ data: { sellerId: s.seller.id, orderId: o.order.id, orderItemId: o.item.id, broadcastSessionId: b.id, status: "OPENING", position: 1, receivedAt: new Date(), openingStartedAt: new Date(), nicknameSnapshot: "닉", productLabel: "박스", quantity: 1 } });
    const ops = await admin("OPERATIONS");
    expect((await end(await admin("CS"), b.id, { reason: "x" })).status).toBe(403);
    expect((await end(await admin("READ_ONLY"), b.id, { reason: "x" })).status).toBe(403);
    expect((await end(ops, b.id, {})).status).toBe(400);
    expect((await end(ops, "not-a-uuid", { reason: "x" })).status).toBe(404);
    // 파트너스 본인 종료는 개봉 중이 남아 있으면 여전히 거부된다
    expect(await endBroadcast(db, s.ctx)).toMatchObject({ ok: false, reason: "opening_in_progress" });
    expect((await db.broadcastSession.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("LIVE");
    const ok = await end(ops, b.id, { reason: "PC 꺼짐 · 개봉 중 잔존" });
    expect(ok).toMatchObject({ status: 200, body: { ok: true, broadcastId: b.id } });
    expect((await db.broadcastSession.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("ENDED");
    expect((await db.queueItem.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("OPENING");
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "broadcast.force_end", targetId: b.id } });
    expect(audit).toMatchObject({ actorType: "PLATFORM_ADMIN", sellerId: s.seller.id });
    expect(audit.after).toMatchObject({ forced: true, reason: "PC 꺼짐 · 개봉 중 잔존" });
    expect((await end(ops, b.id, { reason: "again" })).status).toBe(409);
    // 방송이 끝난 뒤에도 파트너스는 개봉 중 항목을 완료할 수 있다
    const done = await applyQueueAction(db, s.ctx, q.id, "complete");
    expect(done.ok).toBe(true);
    expect(await issue(s.cookie)).toBe(200);
  });
});
