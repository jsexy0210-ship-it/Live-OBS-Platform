import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sealBillingKey } from "../../lib/server/billing/secret";
import { ExternalHttpError, type ExternalOrderApi, type ExternalOrderData, type ExternalOrderListQuery, type ExternalShopProvider, type TokenSet } from "../../lib/server/external/provider";
import { MAX_PAGES, PAGE_SIZE, reconcileOrders } from "../../lib/server/external/reconcile";
import { prisma } from "../../lib/server/db";
import { createSeller, db, resetDb } from "./helpers";

// 누락 보정: 웹훅을 못 받은 최근 결제·취소 주문을 목록 조회로 다시 올린다. 쇼핑몰 API는 가짜(실제 호출 없음).
beforeAll(() => {
  process.env.BILLING_KEY_SECRET = "test-billing-key-secret-0123456789abcdef";
});
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

class FakeApi implements ExternalOrderApi, Pick<ExternalShopProvider, "refresh"> {
  pay: ExternalOrderData[] = [];
  cancel: ExternalOrderData[] = [];
  queries: ExternalOrderListQuery[] = [];
  error: Error | null = null;
  refreshes = 0;
  async fetchOrder(): Promise<ExternalOrderData | null> {
    return null;
  }
  async listOrders(_shop: string, _token: string, q: ExternalOrderListQuery) {
    if (this.error) throw this.error;
    this.queries.push(q);
    const all = q.dateType === "pay_date" ? this.pay : this.cancel;
    return all.slice(q.offset, q.offset + q.limit);
  }
  async refresh(): Promise<TokenSet> {
    this.refreshes++;
    return { accessToken: "AT-new", refreshToken: "RT-new", accessExpiresAt: new Date(Date.now() + 7200_000), refreshExpiresAt: new Date(Date.now() + 14 * 86400_000), scopes: null };
  }
}
const data = (id: string, over: Partial<ExternalOrderData> = {}): ExternalOrderData => ({
  orderId: id,
  paid: true,
  canceled: false,
  buyerName: "홍길동",
  paidAt: new Date(),
  items: [{ productName: "스타라이트 박스", optionValue: null, quantity: 1 }],
  ...over,
});

async function shop(connectedAt = new Date(Date.now() - 3 * 86400_000)) {
  const { seller } = await createSeller();
  const conn = await db.externalShopConnection.create({
    data: {
      sellerId: seller.id,
      shopKey: `ext-${seller.slug}`,
      status: "CONNECTED",
      connectedAt,
      accessTokenCipher: sealBillingKey("AT", seller.id),
      refreshTokenCipher: sealBillingKey("RT", seller.id),
      accessExpiresAt: new Date(Date.now() + 3600_000),
      refreshExpiresAt: new Date(Date.now() + 10 * 86400_000),
    },
  });
  return { seller, conn };
}
const queue = (sellerId: string) => db.queueItem.findMany({ where: { sellerId }, orderBy: { position: "asc" } });

describe("누락 보정", () => {
  it("웹훅을 못 받은 결제 주문을 올린다. 이미 올라간 주문은 다시 올리지 않는다(몇 번 돌려도 같다)", async () => {
    const { seller, conn } = await shop();
    const api = new FakeApi();
    api.pay = [data("M1"), data("M2", { buyerName: "김철" })];
    await db.externalOrder.create({ data: { sellerId: seller.id, connectionId: conn.id, externalOrderId: "M1", buyerLabel: "이미 있음" } });
    expect(await reconcileOrders(db, api)).toMatchObject({ connections: 1, stored: 1, cancelled: 0 });
    expect((await queue(seller.id)).map((i) => i.nicknameSnapshot)).toEqual(["김*"]);
    expect(await reconcileOrders(db, api)).toMatchObject({ stored: 0 });
    expect(await queue(seller.id)).toHaveLength(1);
  });

  it("결제 전·취소·품목 없음 주문과 연결 전에 결제된 주문은 올리지 않는다", async () => {
    const { seller } = await shop(new Date(Date.now() - 3600_000));
    const api = new FakeApi();
    api.pay = [
      data("U", { paid: false }),
      data("C", { canceled: true }),
      data("E", { items: [] }),
      data("OLD", { paidAt: new Date(Date.now() - 5 * 3600_000) }), // 연결(1시간 전)보다 먼저 결제
      data("OK", { paidAt: new Date(Date.now() - 600_000) }),
    ];
    expect(await reconcileOrders(db, api)).toMatchObject({ stored: 1 });
    expect((await db.queueItem.findMany({ where: { sellerId: seller.id }, include: { externalOrder: true } })).map((i) => i.externalOrder!.externalOrderId)).toEqual(["OK"]);
  });

  it("취소 주문은 이미 올라간 주문의 대기 항목만 취소한다(없는 주문은 무시, 다시 돌려도 같다)", async () => {
    const { seller } = await shop();
    const api = new FakeApi();
    api.pay = [data("K1"), data("K2")];
    await reconcileOrders(db, api);
    api.cancel = [data("K1", { canceled: true }), data("GHOST", { canceled: true }), data("K2", { canceled: false })];
    expect(await reconcileOrders(db, api)).toMatchObject({ cancelled: 1 });
    expect((await db.queueItem.findMany({ where: { sellerId: seller.id }, include: { externalOrder: true }, orderBy: { position: "asc" } })).map((i) => [i.externalOrder!.externalOrderId, i.status])).toEqual([["K1", "CANCELLED"], ["K2", "WAITING"]]);
    expect(await reconcileOrders(db, api)).toMatchObject({ cancelled: 0 });
  });

  it("조회 범위는 KST 날짜로 최근 24시간(연결 이후), 결제일·취소일 두 종류를 쪽 단위로 훑는다. 쪽 수에 상한이 있다", async () => {
    await shop();
    const api = new FakeApi();
    api.pay = Array.from({ length: PAGE_SIZE * (MAX_PAGES + 2) }, (_, i) => data(`P${i}`, { paid: false }));
    const now = new Date();
    const kst = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
    await reconcileOrders(db, api, { now });
    const pay = api.queries.filter((q) => q.dateType === "pay_date");
    expect(pay).toHaveLength(MAX_PAGES);
    expect(pay.map((q) => q.offset)).toEqual([0, 100, 200]);
    expect(pay[0]).toMatchObject({ startDate: kst(new Date(now.getTime() - 24 * 3600_000)), endDate: kst(now), limit: PAGE_SIZE });
    expect(api.queries.filter((q) => q.dateType === "cancel_date")).toHaveLength(1);
  });

  it("일시 오류는 다음 번에 다시 한다. 401이면 토큰을 새로 받아 두고, 연결 해제·결제 유예 만료 파트너스는 부르지 않는다. 공급자가 없으면 아무것도 하지 않는다", async () => {
    const a = await shop();
    const api = new FakeApi();
    api.pay = [data("R1")];
    api.error = new ExternalHttpError(429);
    expect(await reconcileOrders(db, api)).toMatchObject({ stored: 0, deferred: 1 });
    api.error = new ExternalHttpError(401);
    expect(await reconcileOrders(db, api)).toMatchObject({ deferred: 1 });
    expect(api.refreshes).toBe(1);
    api.error = null;
    expect(await reconcileOrders(db, api)).toMatchObject({ stored: 1 });
    expect(await queue(a.seller.id)).toHaveLength(1);

    const gone = await shop();
    await db.externalShopConnection.update({ where: { id: gone.conn.id }, data: { status: "DISCONNECTED" } });
    const locked = await shop();
    await db.seller.update({ where: { id: locked.seller.id }, data: { trialEndsAt: new Date(Date.now() - 86400_000) } });
    const api2 = new FakeApi();
    api2.pay = [data("S1")];
    await reconcileOrders(db, api2);
    expect(await queue(gone.seller.id)).toHaveLength(0);
    expect(await queue(locked.seller.id)).toHaveLength(0);
    expect(await reconcileOrders(db, null)).toEqual({ connections: 0, stored: 0, cancelled: 0, deferred: 0 });
  });

  it("시간 예산이 0이면 쇼핑몰을 부르지 않고 모두 미룬다", async () => {
    await shop();
    const api = new FakeApi();
    expect(await reconcileOrders(db, api, { budgetMs: 0 })).toMatchObject({ connections: 0, deferred: 1 });
    expect(api.queries).toHaveLength(0);
  });
});
