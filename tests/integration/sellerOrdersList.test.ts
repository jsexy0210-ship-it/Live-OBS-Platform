import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as listRoute } from "../../app/api/seller/orders/route";
import { loginSeller } from "../../lib/server/auth/login";
import { PASSWORD, createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000" };

async function sellerCookie(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  // 숫자 없는 닉네임으로 고정한다(주문번호 검색 q=1이 닉네임에 걸리지 않게)
  const buyer = await db.buyerMember.update({ where: { id: (await createBuyer(seller.id, grade.id)).id }, data: { broadcastNickname: "기본닉" } });
  const cookie = await sellerCookie(owner.email);
  let n = 0;
  const order = (data: { status?: "PENDING_PAYMENT" | "PAID" | "CANCELLED" | "REFUNDED"; createdAt?: Date; nickname?: string } = {}) =>
    db.order.create({
      data: {
        sellerId: seller.id,
        orderNo: ++n,
        buyerMemberId: buyer.id,
        broadcastNicknameSnapshot: data.nickname ?? buyer.broadcastNickname,
        totalAmount: 10000,
        status: data.status ?? "PENDING_PAYMENT",
        ...(data.createdAt ? { createdAt: data.createdAt } : {}),
      },
    });
  return { seller, grade, buyer, owner, cookie, order };
}

async function list(cookie: string, qs = "") {
  const r = await listRoute(new Request(`http://localhost:3000/api/seller/orders${qs}`, { headers: { ...H, cookie } }));
  return { status: r.status, body: await r.json() };
}

describe("판매자 주문 목록 GET /api/seller/orders", () => {
  it("내 쇼핑몰 주문만 주문 시각 내림차순으로 주고, 다른 판매자 주문은 검색어·커서와 상관없이 나오지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    const a1 = await a.order({ createdAt: new Date("2026-10-01T01:00:00Z") });
    const a2 = await a.order({ createdAt: new Date("2026-10-02T01:00:00Z") });
    const other = await b.order({ createdAt: new Date("2026-10-03T01:00:00Z"), nickname: "같은닉" });
    const r = await list(a.cookie);
    expect(r.status).toBe(200);
    expect(r.body.orders.map((o: { id: string }) => o.id)).toEqual([a2.id, a1.id]);
    expect(r.body.nextCursor).toBeNull();
    expect((await list(a.cookie, `?q=${encodeURIComponent("같은닉")}`)).body.orders).toEqual([]);
    expect((await list(a.cookie, `?q=${other.orderNo}`)).body.orders.map((o: { id: string }) => o.id)).toEqual([a1.id]);
  });

  it("응답 행에 구매자·합계·상품 요약(첫 상품명 + 외 N건)·발송 여부·환불 가능 여부를 담는다", async () => {
    const s = await shop();
    const { order, product, option } = await createPaidOrderItem(s.seller.id, s.buyer.id);
    for (const name of ["둘째", "셋째"]) {
      await db.orderItem.create({ data: { sellerId: s.seller.id, orderId: order.id, productId: product.id, optionId: option.id, productNameSnapshot: name, optionNameSnapshot: "1팩", unitPrice: 1000, quantity: 1, createdAt: new Date(Date.now() + 1000) } });
    }
    const [row] = (await list(s.cookie)).body.orders;
    expect(row).toEqual({
      id: order.id,
      orderNo: order.orderNo,
      status: "PAID",
      createdAt: order.createdAt.toISOString(),
      paidAt: order.paidAt!.toISOString(),
      buyer: { id: s.buyer.id, broadcastNickname: s.buyer.broadcastNickname },
      totalAmount: 5000,
      itemSummary: { firstProductName: "부스터 팩", otherCount: 2, refundedQuantity: 0 },
      shipped: false,
      refundable: true,
    });
    await db.shipment.create({ data: { sellerId: s.seller.id, orderId: order.id, courier: "CJ", trackingNumber: "1", shippedAt: new Date() } });
    expect((await list(s.cookie)).body.orders[0]).toMatchObject({ shipped: true, refundable: true });
  });

  it("상태 필터는 여러 개를 받고, 없는 상태는 400", async () => {
    const s = await shop();
    const pending = await s.order({ status: "PENDING_PAYMENT" });
    const paid = await s.order({ status: "PAID" });
    await s.order({ status: "CANCELLED" });
    const refunded = await s.order({ status: "REFUNDED" });
    const ids = async (qs: string) => (await list(s.cookie, qs)).body.orders.map((o: { id: string }) => o.id).sort();
    expect(await ids("?status=PAID")).toEqual([paid.id]);
    expect(await ids("?status=PAID&status=REFUNDED")).toEqual([paid.id, refunded.id].sort());
    expect(await ids("?status=PENDING_PAYMENT,PAID")).toEqual([pending.id, paid.id].sort());
    expect((await list(s.cookie, "?status=SHIPPED")).status).toBe(400);
  });

  it("q는 주문번호(전체 일치)·방송 닉네임을 찾고, 받는 분 이름은 개인정보 열람 권한이 있을 때만 찾는다", async () => {
    const s = await shop();
    const byNick = await s.order({ nickname: "포켓왕" });
    const byRecipient = await s.order();
    await db.orderShippingAddress.create({ data: { sellerId: s.seller.id, orderId: byRecipient.id, recipientName: "김받음", phone: "01000000000", zipCode: "00000", address1: "주소" } });
    for (let i = 0; i < 10; i++) await s.order();
    const ids = async (cookie: string, q: string) => (await list(cookie, `?q=${encodeURIComponent(q)}`)).body.orders.map((o: { id: string }) => o.id);
    expect(await ids(s.cookie, "켓왕")).toEqual([byNick.id]);
    expect(await ids(s.cookie, "1")).toEqual([byNick.id]); // 주문번호 1만(10·11·12는 부분 일치라 아님)
    expect(await ids(s.cookie, "김받")).toEqual([byRecipient.id]);
    const noPii = await createSellerUser(s.seller.id, { permissions: ["ORDER_SHIPPING"] });
    expect(await ids(await sellerCookie(noPii.email), "김받")).toEqual([]);
    expect((await list(s.cookie, `?q=${"가".repeat(51)}`)).status).toBe(400);
  });

  it("받는 분 이름까지 찾는 검색(권한 있음 + q)은 열람 기록 1건(검색어 없이 주문 id·건수), 권한 없음·q 없음은 0건", async () => {
    const s = await shop();
    const hit = await s.order();
    await db.orderShippingAddress.create({ data: { sellerId: s.seller.id, orderId: hit.id, recipientName: "김받음", phone: "01000000000", zipCode: "00000", address1: "주소" } });
    const piiLogs = () => db.auditLog.findMany({ where: { sellerId: s.seller.id, action: "customer.pii.view" } });
    await list(s.cookie);
    await list(s.cookie, "?status=PENDING_PAYMENT");
    const noPii = await createSellerUser(s.seller.id, { permissions: ["ORDER_SHIPPING"] });
    await list(await sellerCookie(noPii.email), `?q=${encodeURIComponent("김받")}`);
    expect(await piiLogs()).toHaveLength(0);
    await list(s.cookie, `?q=${encodeURIComponent("김받")}`);
    const logs = await piiLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actorId: s.owner.id, targetType: "OrderSearch", after: { orderIds: [hit.id], count: 1 } });
    expect(JSON.stringify(logs[0])).not.toContain("김받");
  });

  it("같은 시각 주문이 여러 건이어도 커서로 빠짐·겹침 없이 끝까지 넘기고, 잘못된 커서는 400", async () => {
    const s = await shop();
    const at = new Date("2026-10-02T03:00:00.123Z");
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await s.order({ createdAt: at }));
    made.push(await s.order({ createdAt: new Date(at.getTime() - 1) }));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await list(s.cookie, `?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(r.status).toBe(200);
      expect(r.body.orders.length).toBeLessThanOrEqual(2);
      seen.push(...r.body.orders.map((o: { id: string }) => o.id));
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(6);
    expect(seen.sort()).toEqual(made.map((o) => o.id).sort());
    expect((await list(s.cookie, "?cursor=abc")).status).toBe(400);
  });

  it("from·to는 KST 날짜로 주문 시각을 거르고, 잘못된 날짜는 400", async () => {
    const s = await shop();
    await s.order({ createdAt: new Date("2026-10-01T14:59:59.999Z") }); // KST 10-01 23:59
    const d2a = await s.order({ createdAt: new Date("2026-10-01T15:00:00Z") }); // KST 10-02 00:00
    const d2b = await s.order({ createdAt: new Date("2026-10-02T14:59:59.999Z") }); // KST 10-02 23:59
    await s.order({ createdAt: new Date("2026-10-02T15:00:00Z") }); // KST 10-03 00:00
    const r = await list(s.cookie, "?from=2026-10-02&to=2026-10-02");
    expect(r.body.orders.map((o: { id: string }) => o.id)).toEqual([d2b.id, d2a.id]);
    expect((await list(s.cookie, "?from=2026-02-30")).status).toBe(400);
    expect((await list(s.cookie, "?to=2026/10/02")).status).toBe(400);
  });

  it("limit은 기본 50·최대 200이고, 0·음수·숫자 아님은 400", async () => {
    const s = await shop();
    await db.order.createMany({
      data: Array.from({ length: 205 }, (_, i) => ({ sellerId: s.seller.id, orderNo: 1000 + i, buyerMemberId: s.buyer.id, broadcastNicknameSnapshot: "닉", totalAmount: 1000 })),
    });
    expect((await list(s.cookie)).body.orders).toHaveLength(50);
    const max = await list(s.cookie, "?limit=1000");
    expect(max.body.orders).toHaveLength(200);
    expect(max.body.nextCursor).not.toBeNull();
    for (const bad of ["0", "-1", "abc", "1.5"]) expect((await list(s.cookie, `?limit=${bad}`)).status).toBe(400);
  });

  it("주문 권한 없는 직원은 403, 로그인 안 하면 401, 이용이 잠긴 쇼핑몰도 목록은 볼 수 있다", async () => {
    const s = await shop();
    await s.order();
    const broadcaster = await createSellerUser(s.seller.id, "BROADCASTER");
    expect((await list(await sellerCookie(broadcaster.email))).status).toBe(403);
    expect((await list("")).status).toBe(401);
    await db.seller.update({ where: { id: s.seller.id }, data: { trialEndsAt: new Date("2000-01-01T00:00:00Z") } });
    expect((await list(s.cookie)).body.orders).toHaveLength(1);
  });
});
