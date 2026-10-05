import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as summaryRoute } from "../../app/api/seller/broadcast/summary/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { PASSWORD, createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";

// SA-001 방송 대시보드 요약: 귀속 규칙(주문·개봉 완료·HIT 생성 시각이 방송 [시작, 종료] 안), 권한(BROADCAST_RUN), 판매자 격리.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const MIN = 60_000;
const ago = (m: number) => new Date(Date.now() - m * MIN);
const summary = async (cookie: string) => {
  const res = await summaryRoute(new Request(BASE + "/api/seller/broadcast/summary", { headers: { host: "localhost:3000", cookie } }));
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
};
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

// 주문 하나(시각·상태 지정). 결제 주문은 paidAt을 채운다.
async function order(sellerId: string, buyerId: string, createdAt: Date, status: "PAID" | "PENDING_PAYMENT" | "CANCELLED" | "REFUNDED", refundAmount?: number) {
  const { order, item } = await createPaidOrderItem(sellerId, buyerId);
  await db.order.update({
    where: { id: order.id },
    data: { createdAt, status, paidAt: status === "PAID" || status === "REFUNDED" ? createdAt : null, refundAmount: refundAmount ?? null },
  });
  return { order, item };
}

describe("방송 대시보드 요약", () => {
  it("지금 방송의 주문·결제·매출·개봉 완료·취소·HIT를 방송 시간 안 것만 센다", async () => {
    const s = await shop();
    await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "ENDED", title: "지난 방송", startedAt: ago(180), endedAt: ago(120) } });
    const live = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "LIVE", title: "오늘 방송", startedAt: ago(60) } });
    await order(s.seller.id, s.buyer.id, ago(150), "PAID"); // 지난 방송
    const paid = await order(s.seller.id, s.buyer.id, ago(30), "PAID"); // 5000
    await order(s.seller.id, s.buyer.id, ago(20), "PENDING_PAYMENT");
    await order(s.seller.id, s.buyer.id, ago(15), "CANCELLED");
    await order(s.seller.id, s.buyer.id, ago(10), "REFUNDED", 2000); // 결제 5000, 환불 2000
    await db.queueItem.create({
      data: {
        sellerId: s.seller.id, orderId: paid.order.id, orderItemId: paid.item.id, status: "DONE", position: 1, receivedAt: ago(30),
        nicknameSnapshot: "닉", productLabel: "부스터 팩", quantity: 1, doneAt: ago(5),
      },
    });
    await db.hitCard.create({ data: { sellerId: s.seller.id, nicknameSnapshot: "닉", cardName: "리자몽", createdAt: ago(5) } });
    await db.hitCard.create({ data: { sellerId: s.seller.id, nicknameSnapshot: "닉", cardName: "지난 카드", createdAt: ago(150) } });
    // 다른 쇼핑몰의 같은 시간 주문·카드는 세지 않는다
    const t = await shop();
    await order(t.seller.id, t.buyer.id, ago(30), "PAID");
    await db.hitCard.create({ data: { sellerId: t.seller.id, nicknameSnapshot: "닉", cardName: "남의 카드", createdAt: ago(5) } });

    for (const cookie of [s.owner, s.runner]) {
      const r = await summary(cookie);
      expect(r.status).toBe(200);
      expect(r.body.broadcast).toMatchObject({ id: live.id, title: "오늘 방송", status: "live", endedAt: null });
      expect(r.body.summary).toEqual({ orders: 4, paidOrders: 2, sales: 8000, completed: 1, cancelled: 2, hits: 1 });
    }
    expect((await summary(s.noPerm)).status).toBe(403);
    const other = await summary(t.owner);
    expect([other.body.broadcast, other.body.summary.orders]).toEqual([null, 0]);
  });

  it("방송 중이 아니면 오늘 시작한 가장 최근 방송, 없으면 null", async () => {
    const s = await shop();
    expect(await summary(s.owner)).toEqual({ status: 200, body: { broadcast: null, summary: { orders: 0, paidOrders: 0, sales: 0, completed: 0, cancelled: 0, hits: 0 } } });
    const startedAt = new Date(Date.now() - 1000);
    const b = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "ENDED", startedAt, endedAt: new Date() } });
    const r = await summary(s.owner);
    expect(r.body.broadcast).toMatchObject({ id: b.id, status: "ended" });
  });
});
