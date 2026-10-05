import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getQueueSnapshot } from "../../lib/server/queue/read";
import {
  applyQueueAction,
  endBroadcast,
  markOrderPaid,
  reorderWaiting,
  startBroadcast,
} from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(() => db.$disconnect());

const t0 = new Date("2026-10-02T12:00:00Z");
const sec = (n: number) => new Date(t0.getTime() + n * 1000);

async function setupShop() {
  const { seller, grade } = await createSeller();
  const user = await createSellerUser(seller.id, "BROADCASTER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: user.id, isOwner: false, permissions: user.permissions, readOnly: false };
  const buyer = await createBuyer(seller.id, grade.id);
  let orderNo = 0;
  // 결제 대기 주문을 만든다. lines: [재고, 수량]
  async function pendingOrder(lines: [number, number][]) {
    const order = await db.order.create({
      data: { sellerId: seller.id, orderNo: ++orderNo, buyerMemberId: buyer.id, broadcastNicknameSnapshot: buyer.broadcastNickname, totalAmount: 0 },
    });
    const options = [];
    for (const [stock, quantity] of lines) {
      const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
      const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1팩", stock } });
      await db.orderItem.create({
        data: {
          sellerId: seller.id,
          orderId: order.id,
          productId: product.id,
          optionId: option.id,
          productNameSnapshot: product.name,
          optionNameSnapshot: option.name,
          unitPrice: 5000,
          quantity,
        },
      });
      options.push(option);
    }
    return { order, options };
  }
  // 결제 완료까지 마친 주문의 주문대기 항목 id
  async function paidItem(now = t0) {
    const { order } = await pendingOrder([[10, 1]]);
    const r = await markOrderPaid(db, { sellerId: seller.id, orderId: order.id, now });
    if (!r.ok) throw new Error(r.reason);
    return r.value.queueItemIds[0];
  }
  return { seller, grade, ctx, buyer, pendingOrder, paidItem };
}

const status = async (id: string) => (await db.queueItem.findUniqueOrThrow({ where: { id } })).status;

describe("결제 완료 → 주문대기", () => {
  it("방송 전 결제는 미배정 대기로 쌓이고, 방송 시작 때 접수 시각 순으로 자동 편입된다", async () => {
    const s = await setupShop();
    // 결제는 들어온 순서대로 방송 전 대기 맨 뒤에 붙는다(순번 = 접수 순). 판매자가 순서를 바꾸면 그 순서를 따른다(아래 「방송 전 대기 순서」).
    const first = await s.paidItem(sec(10));
    const later = await s.paidItem(sec(20));
    const r = await startBroadcast(db, s.ctx, { now: sec(30) });
    expect(r).toMatchObject({ ok: true, value: { absorbed: 2 } });
    const snap = await getQueueSnapshot(db, s.ctx);
    expect(snap.waiting.map((w) => w.id)).toEqual([first, later]);
    expect(snap.waiting.map((w) => w.position)).toEqual([1, 2]);
    expect(snap.beforeBroadcast).toEqual([]);
  });

  it("방송 중 결제는 그 방송 맨 뒤에 붙는다 (주문 품목 1개 = 대기 1건, 수량 표시)", async () => {
    const s = await setupShop();
    await startBroadcast(db, s.ctx, { now: t0 });
    await s.paidItem(sec(1));
    const { order } = await s.pendingOrder([[10, 3], [10, 1]]);
    const r = await markOrderPaid(db, { sellerId: s.seller.id, orderId: order.id, now: sec(2) });
    expect(r.ok && r.value.queueItemIds.length).toBe(2);
    const snap = await getQueueSnapshot(db, s.ctx);
    expect(snap.waiting.map((w) => [w.position, w.quantity])).toEqual([
      [1, 1],
      [2, 3],
      [3, 1],
    ]);
  });

  it("재고가 하나라도 모자라면 모든 품목 차감을 되돌리고 「재고 부족」만 표시한다 (주문대기 없음)", async () => {
    const s = await setupShop();
    const { order, options } = await s.pendingOrder([[5, 2], [1, 2]]);
    const r = await markOrderPaid(db, { sellerId: s.seller.id, orderId: order.id, now: t0 });
    expect(r).toMatchObject({ ok: true, value: { stockShortage: true, queueItemIds: [] } });
    const after = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("PAID");
    expect(after.stockShortageAt).not.toBeNull();
    const stocks = await db.productOption.findMany({ where: { id: { in: options.map((o) => o.id) } }, orderBy: { stock: "desc" } });
    expect(stocks.map((o) => o.stock)).toEqual([5, 1]);
    expect(await db.queueItem.count()).toBe(0);
    expect(await db.stockMovement.count()).toBe(0);
    expect(await db.rewardLedger.count()).toBe(0);
  });

  it("마지막 재고 1개에 결제 2건이 동시에 오면 1건만 주문대기에 들어간다", async () => {
    const s = await setupShop();
    const product = await db.product.create({ data: { sellerId: s.seller.id, name: "한정판", price: 1, status: "ON_SALE" } });
    const option = await db.productOption.create({ data: { sellerId: s.seller.id, productId: product.id, name: "1팩", stock: 1 } });
    const orders = [];
    for (const n of [101, 102]) {
      const order = await db.order.create({
        data: { sellerId: s.seller.id, orderNo: n, buyerMemberId: s.buyer.id, broadcastNicknameSnapshot: "닉", totalAmount: 1 },
      });
      await db.orderItem.create({
        data: { sellerId: s.seller.id, orderId: order.id, productId: product.id, optionId: option.id, productNameSnapshot: "한정판", optionNameSnapshot: "1팩", unitPrice: 1, quantity: 1 },
      });
      orders.push(order);
    }
    const results = await Promise.all(orders.map((o) => markOrderPaid(db, { sellerId: s.seller.id, orderId: o.id })));
    const shortages = results.map((r) => r.ok && r.value.stockShortage).sort();
    expect(shortages).toEqual([false, true]);
    expect(await db.queueItem.count()).toBe(1);
    expect((await db.productOption.findUniqueOrThrow({ where: { id: option.id } })).stock).toBe(0);
  });

  it("이미 결제된 주문을 다시 결제 처리하면 거부", async () => {
    const s = await setupShop();
    const { order } = await s.pendingOrder([[10, 1]]);
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: order.id });
    expect(await markOrderPaid(db, { sellerId: s.seller.id, orderId: order.id })).toEqual({ ok: false, reason: "invalid_transition" });
  });
});

describe("개봉 시작·완료·취소", () => {
  it("대기 → 개봉 중 → 완료, 상태 기록과 감사 로그가 남고 version이 오른다", async () => {
    const s = await setupShop();
    await startBroadcast(db, s.ctx, { now: t0 });
    const id = await s.paidItem(sec(1));
    const v0 = (await getQueueSnapshot(db, s.ctx)).version;
    expect(await applyQueueAction(db, s.ctx, id, "start", { now: sec(2) })).toMatchObject({ ok: true, value: { status: "OPENING" } });
    expect(await applyQueueAction(db, s.ctx, id, "complete", { now: sec(3) })).toMatchObject({ ok: true, value: { status: "DONE" } });
    expect((await getQueueSnapshot(db, s.ctx)).version).toBe(v0 + 2);
    const history = await db.queueItemStatusHistory.findMany({ where: { queueItemId: id }, orderBy: { createdAt: "asc" } });
    expect(history.map((h) => `${h.fromStatus}->${h.toStatus}`)).toEqual(["WAITING->OPENING", "OPENING->DONE"]);
    expect(await db.auditLog.count({ where: { targetId: id, action: { in: ["queue.start", "queue.complete"] } } })).toBe(2);
  });

  it("잘못된 상태 전이는 거부하고 아무것도 바꾸지 않는다", async () => {
    const s = await setupShop();
    await startBroadcast(db, s.ctx, { now: t0 });
    const id = await s.paidItem(sec(1));
    expect(await applyQueueAction(db, s.ctx, id, "complete")).toEqual({ ok: false, reason: "invalid_transition" });
    await applyQueueAction(db, s.ctx, id, "cancel", { reason: "구매자 요청" });
    for (const action of ["start", "complete", "cancel", "revert"] as const) {
      expect(await applyQueueAction(db, s.ctx, id, action, { reason: "다시 시도" })).toEqual({ ok: false, reason: "invalid_transition" });
    }
    expect(await status(id)).toBe("CANCELLED");
    expect(await db.queueItemStatusHistory.count({ where: { queueItemId: id } })).toBe(1);
  });

  it("방송 전(미배정) 항목은 개봉할 수 없다", async () => {
    const s = await setupShop();
    const id = await s.paidItem();
    expect(await applyQueueAction(db, s.ctx, id, "start")).toEqual({ ok: false, reason: "not_live" });
  });

  it("다른 항목이 「개봉 중」이면 개봉 시작 거부", async () => {
    const s = await setupShop();
    await startBroadcast(db, s.ctx, { now: t0 });
    const a = await s.paidItem(sec(1));
    const b = await s.paidItem(sec(2));
    await applyQueueAction(db, s.ctx, a, "start");
    expect(await applyQueueAction(db, s.ctx, b, "start")).toEqual({ ok: false, reason: "other_opening" });
  });

  it("두 화면에서 동시에 개봉 시작해도 1건만 성공", async () => {
    const s = await setupShop();
    await startBroadcast(db, s.ctx, { now: t0 });
    const a = await s.paidItem(sec(1));
    const b = await s.paidItem(sec(2));
    const results = await Promise.all([applyQueueAction(db, s.ctx, a, "start"), applyQueueAction(db, s.ctx, b, "start")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: "other_opening" });
    expect(await db.queueItem.count({ where: { status: "OPENING" } })).toBe(1);
  });

  it("화면이 가진 version이 낡았으면 거부 (낙관적 잠금)", async () => {
    const s = await setupShop();
    await startBroadcast(db, s.ctx, { now: t0 });
    const id = await s.paidItem(sec(1));
    await applyQueueAction(db, s.ctx, id, "timer", { timerSeconds: 60 });
    expect(await applyQueueAction(db, s.ctx, id, "start", { expectedVersion: 0 })).toEqual({ ok: false, reason: "conflict" });
    expect(await applyQueueAction(db, s.ctx, id, "start", { expectedVersion: 1 })).toMatchObject({ ok: true });
  });

  it("타이머는 0~3600초만", async () => {
    const s = await setupShop();
    const id = await s.paidItem();
    expect(await applyQueueAction(db, s.ctx, id, "timer", { timerSeconds: 3601 })).toEqual({ ok: false, reason: "invalid_timer" });
    expect(await applyQueueAction(db, s.ctx, id, "timer", { timerSeconds: 90 })).toMatchObject({ ok: true, value: { timerSeconds: 90 } });
  });
});

describe("개봉 완료 되돌리기", () => {
  async function doneItem() {
    const s = await setupShop();
    await startBroadcast(db, s.ctx, { now: t0 });
    const id = await s.paidItem(sec(1));
    await applyQueueAction(db, s.ctx, id, "start", { now: sec(2) });
    await applyQueueAction(db, s.ctx, id, "complete", { now: sec(10) });
    return { s, id };
  }

  it("완료 10초 안이면 개봉 중으로 되돌리고 기록을 남긴다", async () => {
    const { s, id } = await doneItem();
    expect(await applyQueueAction(db, s.ctx, id, "revert", { now: sec(20) })).toMatchObject({ ok: true, value: { status: "OPENING", doneAt: null } });
    const last = await db.queueItemStatusHistory.findFirstOrThrow({ where: { queueItemId: id }, orderBy: { createdAt: "desc" } });
    expect([last.fromStatus, last.toStatus]).toEqual(["DONE", "OPENING"]);
    expect(await db.auditLog.count({ where: { action: "queue.revert", targetId: id } })).toBe(1);
  });

  it("10초가 지나면 거부", async () => {
    const { s, id } = await doneItem();
    expect(await applyQueueAction(db, s.ctx, id, "revert", { now: sec(21) })).toEqual({ ok: false, reason: "revert_expired" });
    expect(await status(id)).toBe("DONE");
  });

  it("방송이 끝난 뒤에는 10초 안이어도 되돌릴 수 없다 (다음 방송 개봉이 막히지 않게)", async () => {
    const { s, id } = await doneItem();
    await endBroadcast(db, s.ctx, { now: sec(11) });
    expect(await applyQueueAction(db, s.ctx, id, "revert", { now: sec(12) })).toEqual({ ok: false, reason: "not_live" });
    expect(await status(id)).toBe("DONE");
    // 다음 방송의 개봉은 정상
    await startBroadcast(db, s.ctx, { now: sec(20) });
    const next = await s.paidItem(sec(21));
    expect(await applyQueueAction(db, s.ctx, next, "start", { now: sec(22) })).toMatchObject({ ok: true });
  });

  it("시각을 넘기지 않으면 DB 시계로 판정한다 (방금 완료한 항목은 되돌릴 수 있다)", async () => {
    const s = await setupShop();
    await startBroadcast(db, s.ctx);
    const id = await s.paidItem();
    await applyQueueAction(db, s.ctx, id, "start");
    await applyQueueAction(db, s.ctx, id, "complete");
    expect(await applyQueueAction(db, s.ctx, id, "revert")).toMatchObject({ ok: true, value: { status: "OPENING" } });
  });

  it("다른 항목이 「개봉 중」이면 거부", async () => {
    const { s, id } = await doneItem();
    const other = await s.paidItem(sec(11));
    await applyQueueAction(db, s.ctx, other, "start", { now: sec(12) });
    expect(await applyQueueAction(db, s.ctx, id, "revert", { now: sec(13) })).toEqual({ ok: false, reason: "other_opening" });
  });
});

describe("순서 변경", () => {
  const liveVersion = async (sellerId: string) => (await db.seller.findUniqueOrThrow({ where: { id: sellerId } })).liveVersion;

  it("같은 방송의 대기 항목 전체를 새 순서로 바꾼다", async () => {
    const s = await setupShop();
    const live = await startBroadcast(db, s.ctx, { now: t0 });
    if (!live.ok) throw new Error();
    const ids = [await s.paidItem(sec(1)), await s.paidItem(sec(2)), await s.paidItem(sec(3))];
    const reversed = [...ids].reverse();
    const v = await liveVersion(s.seller.id);
    expect(
      await reorderWaiting(db, s.ctx, { broadcastSessionId: live.value.broadcastSessionId, orderedIds: reversed, expectedLiveVersion: v }),
    ).toMatchObject({ ok: true });
    expect((await getQueueSnapshot(db, s.ctx)).waiting.map((w) => w.id)).toEqual(reversed);
  });

  it("일부만 보내거나 다른 항목을 섞으면 거부", async () => {
    const s = await setupShop();
    const live = await startBroadcast(db, s.ctx, { now: t0 });
    if (!live.ok) throw new Error();
    const ids = [await s.paidItem(sec(1)), await s.paidItem(sec(2))];
    const scope = live.value.broadcastSessionId;
    const v = await liveVersion(s.seller.id);
    expect(await reorderWaiting(db, s.ctx, { broadcastSessionId: scope, orderedIds: [ids[1]], expectedLiveVersion: v })).toEqual({
      ok: false,
      reason: "conflict",
    });
    const other = await setupShop();
    const foreign = await other.paidItem();
    expect(await reorderWaiting(db, s.ctx, { broadcastSessionId: scope, orderedIds: [ids[0], foreign], expectedLiveVersion: v })).toEqual({
      ok: false,
      reason: "conflict",
    });
  });

  it("두 화면이 같은 상태를 보고 순서를 바꾸면 나중 요청은 거부 (낡은 화면)", async () => {
    const s = await setupShop();
    const live = await startBroadcast(db, s.ctx, { now: t0 });
    if (!live.ok) throw new Error();
    const ids = [await s.paidItem(sec(1)), await s.paidItem(sec(2)), await s.paidItem(sec(3))];
    const scope = live.value.broadcastSessionId;
    const seen = await liveVersion(s.seller.id);
    expect(await reorderWaiting(db, s.ctx, { broadcastSessionId: scope, orderedIds: [ids[2], ids[0], ids[1]], expectedLiveVersion: seen })).toMatchObject({
      ok: true,
    });
    expect(await reorderWaiting(db, s.ctx, { broadcastSessionId: scope, orderedIds: [ids[1], ids[2], ids[0]], expectedLiveVersion: seen })).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect((await getQueueSnapshot(db, s.ctx)).waiting.map((w) => w.id)).toEqual([ids[2], ids[0], ids[1]]);
  });
});

describe("방송 전 대기 순서", () => {
  const liveVersion = async (sellerId: string) => (await db.seller.findUniqueOrThrow({ where: { id: sellerId } })).liveVersion;

  it("방송 전 대기 순서를 바꾸면 조회와 방송 시작 편입 모두 그 순서를 따른다", async () => {
    const s = await setupShop();
    const ids = [await s.paidItem(sec(1)), await s.paidItem(sec(2)), await s.paidItem(sec(3))];
    const order = [ids[2], ids[0], ids[1]];
    expect(
      await reorderWaiting(db, s.ctx, { broadcastSessionId: null, orderedIds: order, expectedLiveVersion: await liveVersion(s.seller.id) }),
    ).toMatchObject({ ok: true });
    expect((await getQueueSnapshot(db, s.ctx)).beforeBroadcast.map((w) => w.id)).toEqual(order);
    await startBroadcast(db, s.ctx, { now: sec(10) });
    const snap = await getQueueSnapshot(db, s.ctx);
    expect(snap.waiting.map((w) => w.id)).toEqual(order);
    expect(snap.waiting.map((w) => w.position)).toEqual([1, 2, 3]);
  });

  it("방송 종료 때 남은 대기는 기존 방송 전 대기 뒤로, 원래 순서대로 붙는다", async () => {
    const s = await setupShop();
    await startBroadcast(db, s.ctx, { now: t0 });
    const inLive = [await s.paidItem(sec(1)), await s.paidItem(sec(2))];
    await endBroadcast(db, s.ctx, { now: sec(5) });
    const pending = await s.paidItem(sec(6));
    await startBroadcast(db, s.ctx, { now: sec(7) });
    const live2 = [await s.paidItem(sec(8))];
    await endBroadcast(db, s.ctx, { now: sec(9) });
    expect((await getQueueSnapshot(db, s.ctx)).beforeBroadcast.map((w) => w.id)).toEqual([...inLive, pending, ...live2]);
  });
});

describe("취소 사유", () => {
  it("사유 없이 취소하면 거부하고, 사유가 상태 기록에 남는다", async () => {
    const s = await setupShop();
    const id = await s.paidItem();
    expect(await applyQueueAction(db, s.ctx, id, "cancel")).toEqual({ ok: false, reason: "reason_required" });
    expect(await applyQueueAction(db, s.ctx, id, "cancel", { reason: "  " })).toEqual({ ok: false, reason: "reason_required" });
    expect(await status(id)).toBe("WAITING");
    expect(await applyQueueAction(db, s.ctx, id, "cancel", { reason: "구매자 요청" })).toMatchObject({ ok: true, value: { cancelReason: "구매자 요청" } });
    expect((await db.queueItemStatusHistory.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { queueItemId: id } })).reason).toBe("구매자 요청");
  });
});

describe("방송 시작·종료", () => {
  it("이미 방송 중이면 시작 거부", async () => {
    const s = await setupShop();
    await startBroadcast(db, s.ctx);
    expect(await startBroadcast(db, s.ctx)).toEqual({ ok: false, reason: "already_live" });
  });

  it("「개봉 중」이 남아 있으면 종료 거부, 종료하면 남은 대기는 다음 방송으로 이어진다", async () => {
    const s = await setupShop();
    await startBroadcast(db, s.ctx, { now: t0 });
    const a = await s.paidItem(sec(1));
    const b = await s.paidItem(sec(2));
    await applyQueueAction(db, s.ctx, a, "start");
    expect(await endBroadcast(db, s.ctx)).toEqual({ ok: false, reason: "opening_in_progress" });
    await applyQueueAction(db, s.ctx, a, "complete");
    expect(await endBroadcast(db, s.ctx, { now: sec(60) })).toMatchObject({ ok: true, value: { carriedOver: 1 } });
    expect((await getQueueSnapshot(db, s.ctx)).beforeBroadcast.map((w) => w.id)).toEqual([b]);
    expect(await startBroadcast(db, s.ctx, { now: sec(120) })).toMatchObject({ ok: true, value: { absorbed: 1 } });
  });
});

describe("권한·테넌트 격리", () => {
  it("다른 판매자의 주문대기 항목은 조작할 수 없다 (없음으로 처리)", async () => {
    const a = await setupShop();
    const b = await setupShop();
    await startBroadcast(db, a.ctx);
    const id = await a.paidItem();
    expect(await applyQueueAction(db, b.ctx, id, "start")).toEqual({ ok: false, reason: "not_found" });
    expect(await applyQueueAction(db, b.ctx, id, "cancel", { reason: "x" })).toEqual({ ok: false, reason: "not_found" });
    expect(await status(id)).toBe("WAITING");
  });

  it("방송 진행 권한(BROADCAST_RUN)이 없는 직원은 주문대기를 조회·조작할 수 없다", async () => {
    const s = await setupShop();
    const id = await s.paidItem();
    const noRun: TenantContext = { ...s.ctx, permissions: ["ORDER_SHIPPING", "SALES_VIEW"] };
    await expect(getQueueSnapshot(db, noRun)).rejects.toMatchObject({ status: 403 });
    await expect(applyQueueAction(db, noRun, id, "cancel", { reason: "x" })).rejects.toMatchObject({ status: 403 });
    await expect(startBroadcast(db, noRun)).rejects.toMatchObject({ status: 403 });
  });

  it("마스터 대리 조회(읽기 전용)로는 주문대기를 조작할 수 없다", async () => {
    const s = await setupShop();
    const id = await s.paidItem();
    const ro: TenantContext = { ...s.ctx, actorType: "PLATFORM_ADMIN", isOwner: false, permissions: [], readOnly: true };
    await expect(applyQueueAction(db, ro, id, "cancel", { reason: "x" })).rejects.toMatchObject({ status: 403 });
    await expect(startBroadcast(db, ro)).rejects.toMatchObject({ status: 403 });
  });
});
