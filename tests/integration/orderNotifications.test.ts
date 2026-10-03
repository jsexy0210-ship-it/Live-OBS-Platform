import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_NOTIFICATION_ATTEMPTS, claimPaymentDueSoon, markNotificationFailed, markNotificationSent } from "../../lib/server/orders/notifications";
import { createBuyer, createSeller, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(() => db.$disconnect());

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function shop() {
  const { seller, grade } = await createSeller();
  const buyer = await createBuyer(seller.id, grade.id);
  let orderNo = 0;
  // 입금 기한까지 남은 시간(dueIn)과 주문 뒤 지난 시간(age)으로 결제 대기 주문을 만든다
  const order = (dueIn: number, age = 2 * DAY, status: "PENDING_PAYMENT" | "PAID" | "CANCELLED" = "PENDING_PAYMENT") =>
    db.order.create({
      data: {
        sellerId: seller.id,
        orderNo: ++orderNo,
        buyerMemberId: buyer.id,
        broadcastNicknameSnapshot: "닉",
        totalAmount: 10000,
        status,
        createdAt: new Date(Date.now() - age),
        paymentDueAt: new Date(Date.now() + dueIn),
      },
    });
  return { seller, buyer, order };
}

const ids = (r: { orderId: string }[]) => r.map((x) => x.orderId).sort();

describe("입금 기한 알림 「보냈음」 기록", () => {
  it("알림 대상(기한 하루 전, 입금 기간이 하루 이하면 1시간 전)만 잡고, 두 번째에는 다시 잡지 않는다", async () => {
    const s = await shop();
    const soon = await s.order(12 * HOUR);
    const shortSoon = await s.order(30 * 60_000, 2 * HOUR);
    await s.order(2 * DAY); // 아직 하루 전이 아님
    await s.order(2 * HOUR, 2 * HOUR); // 입금 기간이 짧아 1시간 전부터
    await s.order(-60_000); // 기한 지남
    await s.order(12 * HOUR, 2 * DAY, "PAID");
    await s.order(12 * HOUR, 2 * DAY, "CANCELLED");
    const first = await claimPaymentDueSoon(db);
    expect(ids(first)).toEqual([soon.id, shortSoon.id].sort());
    expect(first[0]).toMatchObject({ sellerId: s.seller.id, buyerMemberId: s.buyer.id, totalAmount: 10000, attempts: 1 });
    expect(await claimPaymentDueSoon(db)).toEqual([]);
    expect(await db.orderNotification.findMany({ orderBy: { createdAt: "asc" } })).toMatchObject([
      { kind: "PAYMENT_DUE_SOON", status: "PENDING", attempts: 1 },
      { kind: "PAYMENT_DUE_SOON", status: "PENDING", attempts: 1 },
    ]);
  });

  it("여러 곳에서 동시에 잡아도 한 주문은 한 번만 잡힌다", async () => {
    const s = await shop();
    const orders = await Promise.all(Array.from({ length: 6 }, () => s.order(6 * HOUR)));
    const runs = await Promise.all(Array.from({ length: 5 }, () => claimPaymentDueSoon(db)));
    const claimed = runs.flatMap((r) => r.map((x) => x.orderId));
    expect(claimed.sort()).toEqual(orders.map((o) => o.id).sort());
    expect(await db.orderNotification.count()).toBe(6);
  });

  it("보냈음으로 바꾸면 다시 잡지 않고, 실패하면 시도 횟수(3번) 안에서만 다시 잡는다", async () => {
    const s = await shop();
    const sent = await s.order(6 * HOUR);
    const flaky = await s.order(6 * HOUR);
    const claimed = await claimPaymentDueSoon(db);
    const idOf = (orderId: string) => claimed.find((c) => c.orderId === orderId)!.notificationId;
    expect(await markNotificationSent(db, idOf(sent.id))).toBe(true);
    expect(await markNotificationSent(db, idOf(sent.id))).toBe(false);
    expect(await markNotificationFailed(db, idOf(flaky.id), "provider timeout")).toBe(true);
    for (let attempt = 2; attempt <= MAX_NOTIFICATION_ATTEMPTS; attempt++) {
      const again = await claimPaymentDueSoon(db);
      expect(again.map((c) => [c.orderId, c.attempts])).toEqual([[flaky.id, attempt]]);
      await markNotificationFailed(db, again[0].notificationId, "provider timeout");
    }
    expect(await claimPaymentDueSoon(db)).toEqual([]);
    expect(await db.orderNotification.findFirstOrThrow({ where: { orderId: sent.id } })).toMatchObject({ status: "SENT", sentAt: expect.any(Date) });
    expect(await db.orderNotification.findFirstOrThrow({ where: { orderId: flaky.id } })).toMatchObject({ status: "FAILED", attempts: MAX_NOTIFICATION_ATTEMPTS, failureReason: "provider timeout" });
  });

  it("잡아 둔 채 10분 넘게 멈춘 기록은 다시 잡고, 그 안이면 잡지 않는다. 그사이 입금된 주문은 다시 잡지 않는다", async () => {
    const s = await shop();
    const stuck = await s.order(6 * HOUR);
    const paidLater = await s.order(6 * HOUR);
    const claimed = await claimPaymentDueSoon(db);
    expect(claimed).toHaveLength(2);
    expect(await claimPaymentDueSoon(db)).toEqual([]);
    await db.orderNotification.updateMany({ data: { claimedAt: new Date(Date.now() - 11 * 60_000) } });
    await db.order.update({ where: { id: paidLater.id }, data: { status: "PAID" } });
    expect((await claimPaymentDueSoon(db)).map((c) => [c.orderId, c.attempts])).toEqual([[stuck.id, 2]]);
  });
  it("기한이 이른 주문에 기록이 이미 있어도 한도(limit) 안에서 새 주문을 잡고, 다시 잡기도 한도를 지킨다", async () => {
    const s = await shop();
    const sent = await s.order(1 * HOUR);
    const exhausted = await s.order(2 * HOUR);
    const fresh = await s.order(10 * HOUR);
    await claimPaymentDueSoon(db, { limit: 2 });
    await db.orderNotification.update({ where: { orderId_kind: { orderId: sent.id, kind: "PAYMENT_DUE_SOON" } }, data: { status: "SENT" } });
    await db.orderNotification.update({ where: { orderId_kind: { orderId: exhausted.id, kind: "PAYMENT_DUE_SOON" } }, data: { status: "FAILED", attempts: MAX_NOTIFICATION_ATTEMPTS } });
    // 기록 있는 주문 2개가 기한이 더 일러도 새 주문은 잡힌다
    expect(ids(await claimPaymentDueSoon(db, { limit: 2 }))).toEqual([fresh.id]);
    // 다시 잡을 기록이 3개여도 한도만큼만 잡는다(기한 이른 순)
    const more = await Promise.all([s.order(3 * HOUR), s.order(4 * HOUR), s.order(5 * HOUR)]);
    for (const o of await claimPaymentDueSoon(db, { limit: 3 })) await markNotificationFailed(db, o.notificationId, "실패");
    expect(ids(await claimPaymentDueSoon(db, { limit: 2 }))).toEqual([more[0].id, more[1].id].sort());
  });
});
