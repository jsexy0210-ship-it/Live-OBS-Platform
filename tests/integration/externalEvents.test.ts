import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sealBillingKey } from "../../lib/server/billing/secret";
import { externalConfig } from "../../lib/server/external/config";
import { ExternalHttpError, HttpExternalProvider, type ExternalOrderApi, type ExternalOrderData, type ExternalShopProvider, type TokenSet } from "../../lib/server/external/provider";
import { maskBuyerName, processWebhookEvents } from "../../lib/server/external/process";
import { prisma } from "../../lib/server/db";
import { createSeller, db, resetDb } from "./helpers";

// 웹훅 이벤트 → 주문대기·취소. 쇼핑몰 API는 가짜(실제 호출 없음). 이벤트 모양은 공식 문서 샘플(webhook/sample) 기준.
beforeAll(() => {
  process.env.BILLING_KEY_SECRET = "test-billing-key-secret-0123456789abcdef";
});
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

class FakeApi implements ExternalOrderApi, Pick<ExternalShopProvider, "refresh"> {
  orders = new Map<string, ExternalOrderData | null>();
  fetched: string[] = [];
  tokensUsed: string[] = [];
  fetchError: Error | null = null;
  refreshes = 0;
  async fetchOrder(_shop: string, token: string, id: string) {
    if (this.fetchError) throw this.fetchError;
    this.fetched.push(id);
    this.tokensUsed.push(token);
    return this.orders.get(id) ?? null;
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
  items: [{ productName: "스타라이트 박스", optionValue: "블루", quantity: 2 }],
  ...over,
});

async function shop(opts: { accessExpired?: boolean } = {}) {
  const { seller } = await createSeller();
  const conn = await db.externalShopConnection.create({
    data: {
      sellerId: seller.id,
      shopKey: `ext-${seller.slug}`,
      status: "CONNECTED",
      accessTokenCipher: sealBillingKey("AT-old", seller.id),
      refreshTokenCipher: sealBillingKey("RT-old", seller.id),
      accessExpiresAt: new Date(Date.now() + (opts.accessExpired ? -60_000 : 3600_000)),
      refreshExpiresAt: new Date(Date.now() + 10 * 86400_000),
    },
  });
  return { seller, conn };
}
let n = 0;
async function event(connId: string, sellerId: string, eventNo: number, orderId: string, resource: Record<string, unknown> = {}) {
  return db.externalWebhookEvent.create({
    data: { sellerId, connectionId: connId, eventKey: `k${++n}`, payload: { event_no: eventNo, resource: { mall_id: "x", order_id: orderId, ...resource } } },
  });
}
const queue = (sellerId: string) => db.queueItem.findMany({ where: { sellerId }, orderBy: { position: "asc" } });

describe("외부 주문 웹훅 이벤트 처리", () => {
  it("입금 완료 주문은 조회한 줄(품목·옵션·수량)로 주문대기에 올리고 처리됨으로 표시한다. 구매자 이름은 가려서 쓴다", async () => {
    const { seller, conn } = await shop();
    const api = new FakeApi();
    api.orders.set("20261005-0000001", data("20261005-0000001"));
    const ev = await event(conn.id, seller.id, 90025, "20261005-0000001", { paid: "T" });
    expect(await processWebhookEvents(db, api, {})).toEqual({ processed: 1, deferred: 0 });
    const q = await queue(seller.id);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ productLabel: "스타라이트 박스 (블루)", quantity: 2, nicknameSnapshot: "홍*동" });
    expect((await db.externalWebhookEvent.findUniqueOrThrow({ where: { id: ev.id } })).processedAt).not.toBeNull();
    expect(api.tokensUsed).toEqual(["AT-old"]);
    expect(await db.order.count()).toBe(0);
  });

  it("접수(90023) 때 입금 전(paid F)이면 조회하지 않고 닫고, 입금 이벤트가 오면 올린다. 같은 주문이 접수·입금 둘 다 와도 한 번만 올라간다", async () => {
    const { seller, conn } = await shop();
    const api = new FakeApi();
    api.orders.set("A1", data("A1"));
    await event(conn.id, seller.id, 90023, "A1", { paid: "F" });
    await processWebhookEvents(db, api, {});
    expect(api.fetched).toEqual([]);
    expect(await queue(seller.id)).toHaveLength(0);
    await event(conn.id, seller.id, 90025, "A1", { paid: "T" });
    await event(conn.id, seller.id, 90023, "A1", { paid: "T" });
    await processWebhookEvents(db, api, {});
    expect(await queue(seller.id)).toHaveLength(1);
  });

  it("조회 결과 결제 전이거나 이미 취소된 주문, 품목이 없는 주문은 올리지 않는다", async () => {
    const { seller, conn } = await shop();
    const api = new FakeApi();
    api.orders.set("U1", data("U1", { paid: false }));
    api.orders.set("C1", data("C1", { canceled: true }));
    api.orders.set("E1", data("E1", { items: [] }));
    for (const id of ["U1", "C1", "E1", "NONE"]) await event(conn.id, seller.id, 90025, id);
    expect(await processWebhookEvents(db, api, {})).toEqual({ processed: 4, deferred: 0 });
    expect(await queue(seller.id)).toHaveLength(0);
  });

  it("일괄 이벤트(주문번호 쉼표 목록)는 각각 처리한다", async () => {
    const { seller, conn } = await shop();
    const api = new FakeApi();
    api.orders.set("B1", data("B1"));
    api.orders.set("B2", data("B2", { buyerName: "김철" }));
    await event(conn.id, seller.id, 90025, "B1, B2");
    await processWebhookEvents(db, api, {});
    const q = await queue(seller.id);
    expect(q.map((i) => i.nicknameSnapshot)).toEqual(["홍*동", "김*"]);
  });

  it("취소·환불 이벤트는 조회 결과 주문 전체가 취소일 때만 대기 항목을 취소한다. 부분 취소(취소 아님)는 건드리지 않는다. 다시 받아도 같은 결과", async () => {
    const { seller, conn } = await shop();
    const api = new FakeApi();
    api.orders.set("D1", data("D1"));
    api.orders.set("D2", data("D2"));
    await event(conn.id, seller.id, 90025, "D1");
    await event(conn.id, seller.id, 90025, "D2");
    await processWebhookEvents(db, api, {});
    api.orders.set("D1", data("D1", { canceled: true }));
    await event(conn.id, seller.id, 90026, "D1");
    await event(conn.id, seller.id, 90029, "D2"); // 환불 이벤트지만 조회상 취소 아님
    await event(conn.id, seller.id, 90026, "D1"); // 중복
    await processWebhookEvents(db, api, {});
    const byLabel = Object.fromEntries((await db.queueItem.findMany({ where: { sellerId: seller.id }, include: { externalOrder: true } })).map((i) => [i.externalOrder!.externalOrderId, i.status]));
    expect(byLabel).toEqual({ D1: "CANCELLED", D2: "WAITING" });
  });

  it("처리 대상이 아닌 이벤트(상품 등록 등)와 모양이 틀린 이벤트는 쇼핑몰을 부르지 않고 닫는다", async () => {
    const { seller, conn } = await shop();
    const api = new FakeApi();
    await event(conn.id, seller.id, 90001, "P1");
    await db.externalWebhookEvent.create({ data: { sellerId: seller.id, connectionId: conn.id, eventKey: "bad", payload: { resource: {} } } });
    await db.externalWebhookEvent.create({ data: { sellerId: seller.id, connectionId: conn.id, eventKey: "bad2", payload: { event_no: 90025, resource: { order_id: "../x" } } } });
    expect(await processWebhookEvents(db, api, {})).toEqual({ processed: 3, deferred: 0 });
    expect(api.fetched).toEqual([]);
  });

  it("일시 오류(429·5xx)는 처리됨으로 표시하지 않고 다음 번에 다시 올린다", async () => {
    const { seller, conn } = await shop();
    const api = new FakeApi();
    api.orders.set("R1", data("R1"));
    await event(conn.id, seller.id, 90025, "R1");
    api.fetchError = new ExternalHttpError(429);
    expect(await processWebhookEvents(db, api, {})).toEqual({ processed: 0, deferred: 1 });
    expect(await queue(seller.id)).toHaveLength(0);
    api.fetchError = null;
    expect(await processWebhookEvents(db, api, {})).toEqual({ processed: 1, deferred: 0 });
    expect(await queue(seller.id)).toHaveLength(1);
  });

  it("접근 토큰이 만료돼 있으면 갱신해서 쓴다. 갱신할 수 없으면 쇼핑몰을 부르지 않고 미룬다", async () => {
    const { seller, conn } = await shop({ accessExpired: true });
    const api = new FakeApi();
    api.orders.set("T1", data("T1"));
    await event(conn.id, seller.id, 90025, "T1");
    await processWebhookEvents(db, api, {});
    expect(api.refreshes).toBe(1);
    expect(api.tokensUsed).toEqual(["AT-new"]);
    expect(await queue(seller.id)).toHaveLength(1);

    const s2 = await shop({ accessExpired: true });
    const failing = new FakeApi();
    failing.refresh = async () => {
      throw new Error("down");
    };
    await event(s2.conn.id, s2.seller.id, 90025, "T2");
    expect(await processWebhookEvents(db, failing, {})).toEqual({ processed: 0, deferred: 1 });
    expect(failing.fetched).toEqual([]);
  });

  it("조회가 401이면 토큰을 바로 새로 받아 두고 미룬다. 갱신까지 무효면 다시 연결 필요로 바뀐다", async () => {
    const { seller, conn } = await shop();
    const api = new FakeApi();
    await event(conn.id, seller.id, 90025, "X1");
    api.fetchError = new ExternalHttpError(401);
    expect(await processWebhookEvents(db, api, {})).toEqual({ processed: 0, deferred: 1 });
    expect(api.refreshes).toBe(1);
    expect((await db.externalShopConnection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe("CONNECTED");
    api.refresh = async () => {
      throw new ExternalHttpError(401);
    };
    await processWebhookEvents(db, api, {});
    expect((await db.externalShopConnection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe("REAUTH_REQUIRED");
  });

  it("연결이 해제됐거나 결제 유예가 끝난 파트너스의 이벤트는 쇼핑몰을 부르지 않고 닫는다. 연결 지정 시 그 연결 이벤트만 처리한다", async () => {
    const a = await shop();
    const b = await shop();
    const c = await shop();
    const api = new FakeApi();
    for (const x of [a, b, c]) api.orders.set(`Z-${x.seller.id.slice(0, 4)}`, data(`Z-${x.seller.id.slice(0, 4)}`));
    await db.externalShopConnection.update({ where: { id: a.conn.id }, data: { status: "DISCONNECTED" } });
    await db.seller.update({ where: { id: b.seller.id }, data: { trialEndsAt: new Date(Date.now() - 86400_000) } });
    for (const x of [a, b, c]) await event(x.conn.id, x.seller.id, 90025, `Z-${x.seller.id.slice(0, 4)}`);
    expect(await processWebhookEvents(db, api, { connectionId: c.conn.id })).toEqual({ processed: 1, deferred: 0 });
    expect(await db.externalWebhookEvent.count({ where: { processedAt: null } })).toBe(2);
    expect(await processWebhookEvents(db, api, {})).toEqual({ processed: 2, deferred: 0 });
    expect(api.fetched).toHaveLength(1);
    expect(await queue(a.seller.id)).toHaveLength(0);
    expect(await queue(b.seller.id)).toHaveLength(0);
    expect(await queue(c.seller.id)).toHaveLength(1);
  });

  it("공급자가 없으면(연동 키 없음) 아무것도 하지 않고 이벤트를 남겨 둔다", async () => {
    const { seller, conn } = await shop();
    await event(conn.id, seller.id, 90025, "N1");
    expect(await processWebhookEvents(db, null, {})).toEqual({ processed: 0, deferred: 0 });
    expect(await db.externalWebhookEvent.count({ where: { processedAt: null } })).toBe(1);
  });
});

describe("구매자 이름 가리기", () => {
  it("한 글자는 그대로, 두 글자는 뒤를, 세 글자 이상은 가운데를 가린다. 비면 null", () => {
    expect(maskBuyerName("김")).toBe("김");
    expect(maskBuyerName("김철")).toBe("김*");
    expect(maskBuyerName("홍길동")).toBe("홍*동");
    expect(maskBuyerName("남궁민수")).toBe("남**수");
    expect(maskBuyerName("   ")).toBeNull();
    expect(maskBuyerName(null)).toBeNull();
  });
});

describe("주문 조회 호출(HttpExternalProvider.fetchOrder)", () => {
  const prov = new HttpExternalProvider(externalConfig({ EXTERNAL_SHOP_CLIENT_ID: "c", EXTERNAL_SHOP_CLIENT_SECRET: "s", EXTERNAL_SHOP_REDIRECT_URI: "https://x.test/cb" }));
  const reply = (status: number, body?: unknown) => vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body === undefined ? null : JSON.stringify(body), { status }));
  it("공식 응답 모양(order.items)에서 필요한 값만 뽑고, 수량이 잘못된 품목은 뺀다. 호출은 검증된 몰 주소·Bearer 토큰·items,buyer 포함으로만 한다", async () => {
    const f = reply(200, {
      order: {
        order_id: "20261005-0000001",
        paid: "T",
        canceled: "F",
        billing_name: "입금자",
        buyer: { name: "홍길동", email: "x@y.z" },
        items: [
          { product_name: "카드팩", option_value: "A형", quantity: 3, order_item_code: "i1" },
          { product_name: "수량없음", quantity: 0 },
          { quantity: 1 },
        ],
      },
    });
    expect(await prov.fetchOrder("myshop", "TOKEN", "20261005-0000001")).toEqual({
      orderId: "20261005-0000001",
      paid: true,
      canceled: false,
      buyerName: "홍길동",
      items: [{ productName: "카드팩", optionValue: "A형", quantity: 3 }],
    });
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe("https://myshop.cafe24api.com/api/v2/admin/orders/20261005-0000001?embed=items,buyer");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer TOKEN");
    f.mockRestore();
  });
  it("404·422는 주문 없음(null), 401·429·5xx는 상태 오류, 잘못된 몰 id·주문번호는 호출 전에 거절한다", async () => {
    for (const st of [404, 422]) {
      const f = reply(st);
      expect(await prov.fetchOrder("myshop", "T", "o1")).toBeNull();
      f.mockRestore();
    }
    for (const st of [401, 429, 503]) {
      const f = reply(st, { secret: "x" });
      await expect(prov.fetchOrder("myshop", "T", "o1")).rejects.toMatchObject({ status: st });
      f.mockRestore();
    }
    const f = reply(200, { order: {} });
    expect(await prov.fetchOrder("myshop", "T", "o1")).toBeNull();
    await expect(prov.fetchOrder("evil.com/x", "T", "o1")).rejects.toThrow("bad_input");
    await expect(prov.fetchOrder("myshop", "T", "../o1")).rejects.toThrow("bad_input");
    expect(f).toHaveBeenCalledTimes(1);
    f.mockRestore();
  });
});
