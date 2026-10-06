import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { broadcastDetail } from "../../lib/server/broadcast/detail";
import { exportBroadcastReport, saveBroadcastMemo } from "../../lib/server/broadcast/insights";
import type { TenantContext } from "../../lib/server/tenant/context";
import { prisma } from "../../lib/server/db";
import { createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";

// SA-055: 평균 오픈·최대 대기·시간대별 주문·메모·리포트 CSV
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const at = (min: number) => new Date(Date.UTC(2026, 9, 1, 11, 0, 0) + min * 60_000); // 20:00 KST 기준

async function setup() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const buyer = await createBuyer(seller.id, grade.id);
  const session = await db.broadcastSession.create({ data: { sellerId: seller.id, status: "ENDED", startedAt: at(-2), endedAt: at(25), title: "=테스트" } });
  return { seller, buyer, ctx, session };
}

describe("방송 상세 지표", () => {
  it("평균 오픈·최대 대기·10분 칸 주문 수", async () => {
    const s = await setup();
    const mk = async (minute: number, open?: [number, number]) => {
      const o = await createPaidOrderItem(s.seller.id, s.buyer.id);
      await db.order.update({ where: { id: o.order.id }, data: { createdAt: at(minute) } });
      await db.queueItem.create({
        data: { sellerId: s.seller.id, orderId: o.order.id, orderItemId: o.item.id, position: minute + 10, receivedAt: at(minute), nicknameSnapshot: "닉", productLabel: "박스", quantity: 1, ...(open ? { status: "DONE", openingStartedAt: new Date(at(minute).getTime() + open[0] * 1000), doneAt: new Date(at(minute).getTime() + open[1] * 1000) } : {}) },
      });
    };
    await mk(1, [90, 130]); // 대기 90초, 오픈 40초
    await mk(2, [120, 180]); // 대기 120초, 오픈 60초
    await mk(12);
    const d = await broadcastDetail(db, s.ctx, s.session.id);
    expect(d.summary.avgOpenSeconds).toBe(50);
    expect(d.summary.maxWaiting).toBe(2);
    expect(d.hourly.map((h) => h.orders)).toEqual([0, 2, 1, 0]);
    expect(d.hourly[0].at.toISOString()).toBe("2026-10-01T10:50:00.000Z");
    expect(d.broadcast.memo).toBeNull();
  });

  it("주문이 없으면 평균 오픈 null·최대 대기 0", async () => {
    const s = await setup();
    const d = await broadcastDetail(db, s.ctx, s.session.id);
    expect(d.summary).toMatchObject({ avgOpenSeconds: null, maxWaiting: 0 });
  });
});

describe("메모·리포트", () => {
  it("메모 저장·지우기·길이 제한·다른 판매자 404·직원 권한", async () => {
    const s = await setup();
    expect(await saveBroadcastMemo(db, s.ctx, s.session.id, "반응 좋음")).toEqual({ ok: true, memo: "반응 좋음" });
    expect((await broadcastDetail(db, s.ctx, s.session.id)).broadcast.memo).toBe("반응 좋음");
    expect(await saveBroadcastMemo(db, s.ctx, s.session.id, "x".repeat(1001))).toMatchObject({ ok: false });
    expect(await saveBroadcastMemo(db, s.ctx, s.session.id, 5)).toMatchObject({ ok: false });
    expect(await saveBroadcastMemo(db, s.ctx, s.session.id, "  ")).toEqual({ ok: true, memo: null });
    const other = await createSeller();
    const otherOwner = await createSellerUser(other.seller.id, "OWNER");
    const otherCtx: TenantContext = { ...s.ctx, sellerId: other.seller.id, actorId: otherOwner.id };
    await expect(saveBroadcastMemo(db, otherCtx, s.session.id, "침범")).rejects.toThrow();
    await expect(saveBroadcastMemo(db, { ...s.ctx, isOwner: false, permissions: [] }, s.session.id, "직원")).rejects.toThrow();
    await expect(saveBroadcastMemo(db, { ...s.ctx, readOnly: true }, s.session.id, "대리")).rejects.toThrow();
  });

  it("리포트 CSV: 끝난 방송만, 수식 글자 방어", async () => {
    const s = await setup();
    const o = await createPaidOrderItem(s.seller.id, s.buyer.id);
    await db.order.update({ where: { id: o.order.id }, data: { createdAt: at(1) } });
    const r = await exportBroadcastReport(db, s.ctx, s.session.id);
    expect(r.ok && r.csv).toContain("'=테스트");
    expect(r.ok && r.csv.split("\r\n").length).toBeGreaterThan(4);
    await db.broadcastSession.update({ where: { id: s.session.id }, data: { status: "LIVE", endedAt: null } });
    expect(await exportBroadcastReport(db, s.ctx, s.session.id)).toEqual({ ok: false, reason: "live" });
  });
});
