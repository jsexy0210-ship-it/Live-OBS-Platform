import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { broadcastDetail } from "../../lib/server/broadcast/detail";
import { recordOverlayConnect, recordOverlayDisconnect } from "../../lib/server/broadcast/events";
import { endBroadcast, startBroadcast } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { prisma } from "../../lib/server/db";
import { createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";

// SA-055: 진행자·타이머 설정·방송 화면·연결 로그
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

async function setup() {
  const { seller, grade } = await createSeller();
  const user = await createSellerUser(seller.id, "OWNER");
  await db.sellerUser.update({ where: { id: user.id }, data: { name: "김직원" } });
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: user.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, grade, ctx };
}
const t = (sec: number) => new Date(Date.UTC(2026, 9, 1, 11, 0, 0) + sec * 1000);

describe("방송 진행자·연결 로그", () => {
  it("시작 때 진행자를 남기고, 방송 전 연결·시작·끊김·복구·종료가 순서대로 보인다", async () => {
    const s = await setup();
    await recordOverlayConnect(db, s.seller.id, t(-120)); // 방송 전 연결
    await recordOverlayConnect(db, s.seller.id, t(-100)); // 같은 구간 재접속은 남기지 않음
    const start = await startBroadcast(db, s.ctx, { now: t(0) });
    if (!start.ok) throw new Error("start");
    await recordOverlayConnect(db, s.seller.id, t(5)); // 방송 시작 직전 연결이 있어 중복 없음
    await recordOverlayDisconnect(db, s.seller.id, t(100));
    await recordOverlayDisconnect(db, s.seller.id, t(101)); // 이미 끊김이면 중복 없음
    await recordOverlayConnect(db, s.seller.id, t(142));
    const end = await endBroadcast(db, s.ctx, { now: t(300) });
    if (!end.ok) throw new Error("end");
    const d = await broadcastDetail(db, s.ctx, start.value.broadcastSessionId);
    expect(d.broadcast.hostName).toBe(`${s.seller.shopName} · 김직원`);
    expect(d.events.map((e) => [e.kind, e.at.toISOString(), e.downSeconds, e.waiting])).toEqual([
      ["connected", t(-120).toISOString(), null, null],
      ["live", t(0).toISOString(), null, null],
      ["disconnected", t(100).toISOString(), null, null],
      ["recovered", t(142).toISOString(), 42, null],
      ["ended", t(300).toISOString(), null, 0],
    ]);
  });

  it("방송 시작 뒤 처음 접속하면 연결로 남고, 방송 중이 아니면 끊김은 남기지 않는다", async () => {
    const s = await setup();
    await recordOverlayDisconnect(db, s.seller.id, t(1)); // LIVE 없음
    expect(await db.broadcastEvent.count()).toBe(0);
    const start = await startBroadcast(db, s.ctx, { now: t(0) });
    if (!start.ok) throw new Error("start");
    await recordOverlayConnect(db, s.seller.id, t(10));
    const d = await broadcastDetail(db, s.ctx, start.value.broadcastSessionId);
    expect(d.events.map((e) => e.kind)).toEqual(["live", "connected"]);
  });

  it("타이머 설정은 방송 중 가장 많이 쓴 값, 없으면 null", async () => {
    const s = await setup();
    const start = await startBroadcast(db, s.ctx, { now: t(0) });
    if (!start.ok) throw new Error("start");
    expect((await broadcastDetail(db, s.ctx, start.value.broadcastSessionId)).broadcast.timerSeconds).toBeNull();
    const buyer = await createBuyer(s.seller.id, s.grade.id);
    for (const [i, sec] of [60, 60, 45].entries()) {
      const o = await createPaidOrderItem(s.seller.id, buyer.id);
      await db.queueItem.create({ data: { sellerId: s.seller.id, orderId: o.order.id, orderItemId: o.item.id, broadcastSessionId: start.value.broadcastSessionId, position: i + 1, receivedAt: t(10 + i), nicknameSnapshot: "닉", productLabel: "박스", quantity: 1, timerSeconds: sec } });
    }
    expect((await broadcastDetail(db, s.ctx, start.value.broadcastSessionId)).broadcast.timerSeconds).toBe(60);
  });
});
