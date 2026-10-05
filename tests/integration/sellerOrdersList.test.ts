import { randomUUID } from "node:crypto";
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
      orderNoLabel: expect.stringMatching(new RegExp(`^\\d{8}-${String(order.orderNo).padStart(4, "0")}$`)),
      status: "PAID",
      createdAt: order.createdAt.toISOString(),
      paidAt: order.paidAt!.toISOString(),
      buyer: { id: s.buyer.id, broadcastNickname: s.buyer.broadcastNickname },
      totalAmount: 5000,
      refundedAmount: 0,
      rewardReturned: 0,
      refundedQuantity: 0,
      remainingAmount: 5000,
      paymentMethod: order.paymentMethod,
      paymentDueAt: order.paymentDueAt ? order.paymentDueAt.toISOString() : null,
      itemSummary: { firstProductName: "부스터 팩", otherCount: 2, refundedQuantity: 0 },
      shipped: false,
      shipment: { state: "none", courier: null, trackingNumber: null, deliveredAt: null },
      refundRequest: { pendingCount: 0 },
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

  it("memberId로 회원 한 명의 주문만 주고, 잘못된 값은 400, 다른 판매자 회원 id는 빈 목록이다", async () => {
    const a = await shop();
    const b = await shop();
    const other = await createBuyer(a.seller.id, a.grade.id);
    const mine = await a.order({ createdAt: new Date("2026-10-01T01:00:00Z") });
    await db.order.create({ data: { sellerId: a.seller.id, orderNo: 99, buyerMemberId: other.id, broadcastNicknameSnapshot: "다른회원", totalAmount: 1, status: "PAID" } });
    await b.order();
    const r = await list(a.cookie, `?memberId=${a.buyer.id}`);
    expect(r.body.orders.map((o: { id: string }) => o.id)).toEqual([mine.id]);
    expect(r.body.orders[0].buyer.id).toBe(a.buyer.id);
    expect((await list(a.cookie, `?memberId=${b.buyer.id}`)).body.orders).toEqual([]);
    expect((await list(a.cookie, "?memberId=abc")).status).toBe(400);
  });

  it("shipped=true|false로 발송 정보가 있는 주문·없는 주문만 주고, status·memberId·검색어·커서와 함께 쓸 수 있으며 다른 판매자 주문은 섞이지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    const ship = (sellerId: string, orderId: string) => db.shipment.create({ data: { sellerId, orderId, courier: "CJ", trackingNumber: "123456789", shippedAt: new Date() } });
    const prep1 = await a.order({ status: "PAID", createdAt: new Date("2026-10-01T01:00:00Z") });
    const prep2 = await a.order({ status: "PAID", createdAt: new Date("2026-10-02T01:00:00Z") });
    const sent = await a.order({ status: "PAID", createdAt: new Date("2026-10-03T01:00:00Z") });
    const unpaid = await a.order({ status: "PENDING_PAYMENT", createdAt: new Date("2026-10-04T01:00:00Z") });
    await ship(a.seller.id, sent.id);
    const otherSeller = await b.order({ status: "PAID" });
    const id = (r: { body: { orders: { id: string }[] } }) => r.body.orders.map((o) => o.id);
    // 배송 준비 = 결제 완료 + 미발송
    expect(id(await list(a.cookie, "?status=PAID&shipped=false"))).toEqual([prep2.id, prep1.id]);
    expect(id(await list(a.cookie, "?status=PAID&shipped=true"))).toEqual([sent.id]);
    expect((await list(a.cookie, "?shipped=true")).body.orders[0].shipped).toBe(true);
    expect(id(await list(a.cookie, "?shipped=false"))).toEqual([unpaid.id, prep2.id, prep1.id]);
    expect(id(await list(a.cookie, ""))).toHaveLength(4);
    expect(id(await list(a.cookie, "?shipped="))).toHaveLength(4);
    // 다른 필터·커서와 조합
    expect(id(await list(a.cookie, `?status=PAID&shipped=false&memberId=${a.buyer.id}`))).toEqual([prep2.id, prep1.id]);
    expect(id(await list(a.cookie, "?status=PAID&shipped=false&q=기본닉"))).toEqual([prep2.id, prep1.id]);
    expect(id(await list(a.cookie, "?status=PAID&shipped=false&from=2026-10-02&to=2026-10-02"))).toEqual([prep2.id]);
    const p1 = await list(a.cookie, "?status=PAID&shipped=false&limit=1");
    expect(id(p1)).toEqual([prep2.id]);
    expect(id(await list(a.cookie, `?status=PAID&shipped=false&limit=1&cursor=${p1.body.nextCursor}`))).toEqual([prep1.id]);
    // 다른 판매자 주문은 섞이지 않는다
    expect(id(await list(a.cookie, "?shipped=false"))).not.toContain(otherSeller.id);
    expect(id(await list(b.cookie, "?status=PAID&shipped=false"))).toEqual([otherSeller.id]);
    // 잘못된 값
    for (const bad of ["yes", "1", "TRUE", "null"]) expect((await list(a.cookie, `?shipped=${bad}`)).status, bad).toBe(400);
  });

  it("행에 결제 수단·입금 기한, 배송 상태(none·in_transit·delivered), 대기 중 환불 요청 수를 한 번에 담고 다른 판매자 환불 요청은 세지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    const due = new Date("2026-10-07T00:00:00Z");
    const bank = await a.order({ status: "PENDING_PAYMENT", createdAt: new Date("2026-10-01T00:00:00Z") });
    await db.order.update({ where: { id: bank.id }, data: { paymentMethod: "BANK_TRANSFER", paymentDueAt: due } });
    const card = await a.order({ status: "PAID", createdAt: new Date("2026-10-02T00:00:00Z") });
    await db.order.update({ where: { id: card.id }, data: { paymentMethod: "CARD" } });
    const transit = await a.order({ status: "PAID", createdAt: new Date("2026-10-03T00:00:00Z") });
    const delivered = await a.order({ status: "PAID", createdAt: new Date("2026-10-04T00:00:00Z") });
    const ready = await a.order({ status: "PAID", createdAt: new Date("2026-10-05T00:00:00Z") });
    const sent = new Date("2026-10-04T01:00:00Z");
    const done = new Date("2026-10-06T01:00:00Z");
    const ship = (orderId: string, data: { courier: string; trackingNumber: string; status: "READY" | "IN_TRANSIT" | "DELIVERED"; deliveredAt?: Date }) =>
      db.shipment.create({ data: { sellerId: a.seller.id, orderId, shippedAt: sent, ...data } });
    await ship(transit.id, { courier: "CJ대한통운", trackingNumber: "111", status: "IN_TRANSIT" });
    await ship(delivered.id, { courier: "한진택배", trackingNumber: "222", status: "DELIVERED", deliveredAt: done });
    await ship(ready.id, { courier: "미정", trackingNumber: "0", status: "READY" });
    // 환불 요청: 처리 대기(REQUESTED)만 센다(주문당 대기 중 요청은 1건뿐이라 0 또는 1). 승인·반려·취소는 세지 않는다
    const req = (sellerId: string, orderId: string, buyerMemberId: string, status: "REQUESTED" | "APPROVED" | "REJECTED" | "CANCELLED") =>
      db.refundRequest.create({
        data: { sellerId, orderId, buyerMemberId, status, reason: "CHANGE_OF_MIND", ...(status === "REJECTED" ? { rejectReason: "사용 흔적" } : {}), ...(status === "APPROVED" ? { refundId: randomUUID() } : {}) },
      });
    for (const st of ["APPROVED", "REJECTED", "CANCELLED", "REQUESTED"] as const) await req(a.seller.id, transit.id, a.buyer.id, st);
    await req(a.seller.id, delivered.id, a.buyer.id, "REQUESTED");
    const other = await b.order({ status: "PAID" });
    await req(b.seller.id, other.id, b.buyer.id, "REQUESTED");

    const rows = Object.fromEntries((await list(a.cookie)).body.orders.map((o: { id: string }) => [o.id, o]));
    expect(rows[bank.id]).toMatchObject({ status: "PENDING_PAYMENT", paymentMethod: "BANK_TRANSFER", paymentDueAt: due.toISOString(), shipped: false });
    expect(rows[card.id]).toMatchObject({ paymentMethod: "CARD", paymentDueAt: null });
    const none = { state: "none", courier: null, trackingNumber: null, deliveredAt: null };
    expect(rows[bank.id].shipment).toEqual(none);
    expect(rows[card.id].shipment).toEqual(none);
    expect(rows[ready.id].shipment).toEqual(none);
    expect(rows[transit.id].shipment).toEqual({ state: "in_transit", courier: "CJ대한통운", trackingNumber: "111", deliveredAt: null });
    expect(rows[delivered.id].shipment).toEqual({ state: "delivered", courier: "한진택배", trackingNumber: "222", deliveredAt: done.toISOString() });
    expect(rows[transit.id].refundRequest).toEqual({ pendingCount: 1 });
    expect(rows[delivered.id].refundRequest).toEqual({ pendingCount: 1 });
    for (const id of [bank.id, card.id, ready.id]) expect(rows[id].refundRequest).toEqual({ pendingCount: 0 });
    // 처리가 끝난 요청만 있는 주문은 0
    await db.refundRequest.updateMany({ where: { orderId: transit.id, status: "REQUESTED" }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    expect((await list(a.cookie)).body.orders.find((o: { id: string }) => o.id === transit.id).refundRequest).toEqual({ pendingCount: 0 });
    // 다른 판매자 목록에는 자기 환불 요청만 보인다
    const bRows = (await list(b.cookie)).body.orders;
    expect(bRows).toHaveLength(1);
    expect(bRows[0].refundRequest).toEqual({ pendingCount: 1 });
    // 필터·커서를 써도 같은 값이 나온다
    // 발송 전 준비(READY)는 발송 전이다: shipped=false, shipment.state=none, shipped=false 필터에 들어간다
    expect(rows[ready.id].shipped).toBe(false);
    expect(rows[transit.id].shipped).toBe(true);
    expect((await list(a.cookie, "?status=PAID&shipped=true")).body.orders.map((o: { id: string; shipment: { state: string } }) => [o.id, o.shipment.state]).sort()).toEqual(
      [[delivered.id, "delivered"], [transit.id, "in_transit"]].sort(),
    );
    expect((await list(a.cookie, "?status=PAID&shipped=false")).body.orders.map((o: { id: string }) => o.id)).toContain(ready.id);
  });

  it("행에 환불 현황(refundedAmount·refundedQuantity·remainingAmount)을 담는다: 환불 없음·부분 환불·전액 환불·옛 전액 환불, 다른 판매자 주문은 섞이지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    const none = await a.order({ status: "PAID", createdAt: new Date("2026-10-01T00:00:00Z") });
    const partial = await a.order({ status: "PAID", createdAt: new Date("2026-10-02T00:00:00Z") });
    const full = await a.order({ status: "REFUNDED", createdAt: new Date("2026-10-03T00:00:00Z") });
    const legacy = await a.order({ status: "REFUNDED", createdAt: new Date("2026-10-04T00:00:00Z") });
    const cancelled = await a.order({ status: "CANCELLED", createdAt: new Date("2026-10-05T00:00:00Z") });
    const other = await b.order({ status: "PAID" });
    const product = await db.product.create({ data: { sellerId: a.seller.id, name: "부스터 팩", price: 1000, status: "ON_SALE" } });
    const option = await db.productOption.create({ data: { sellerId: a.seller.id, productId: product.id, name: "1팩", stock: 10 } });
    const item = (orderId: string, quantity: number, refundedQuantity: number) =>
      db.orderItem.create({ data: { sellerId: a.seller.id, orderId, productId: product.id, optionId: option.id, productNameSnapshot: "부스터 팩", optionNameSnapshot: "1팩", unitPrice: 1000, quantity, refundedQuantity } });
    // 시험 주문 4: 23,000원 중 5,000원 부분 환불(5개)
    await db.order.update({ where: { id: partial.id }, data: { totalAmount: 23000, refundAmount: 5000 } });
    await item(partial.id, 23, 5);
    // 부분 환불 5,000원(현금)과 함께 적립금 2,000원을 돌려줌(환불 2건 합산): 남은 금액은 현금·적립금 반환을 모두 뺀다
    const refundRow = (seq: number, refundAmount: number, rewardReturn: number) =>
      db.orderRefund.create({
        data: { sellerId: a.seller.id, orderId: partial.id, seq, reason: "시험", items: [], itemsAmount: refundAmount + rewardReturn, shippingRefunded: 0, refundAmount, returnFeeDeducted: 0, rewardReturn, rewardRevoke: 0, isFinal: false, actorType: "SELLER_USER", createdAt: new Date() },
      });
    await refundRow(1, 3000, 1500);
    await refundRow(2, 2000, 500);
    await db.order.update({ where: { id: full.id }, data: { totalAmount: 10000, refundAmount: 9000 } }); // 반품 배송비 1,000원을 뺀 환불
    await item(full.id, 10, 10);
    await db.order.update({ where: { id: legacy.id }, data: { totalAmount: 7000, refundAmount: null } });
    await item(legacy.id, 7, 7);
    await item(none.id, 3, 0);
    await db.order.update({ where: { id: other.id }, data: { refundAmount: 100 } });

    const rows = Object.fromEntries((await list(a.cookie)).body.orders.map((o: { id: string }) => [o.id, o]));
    expect(rows[none.id]).toMatchObject({ refundedAmount: 0, rewardReturned: 0, refundedQuantity: 0, remainingAmount: 10000 });
    expect(rows[partial.id]).toMatchObject({ status: "PAID", totalAmount: 23000, refundedAmount: 5000, rewardReturned: 2000, refundedQuantity: 5, remainingAmount: 16000 });
    expect(rows[full.id]).toMatchObject({ status: "REFUNDED", refundedAmount: 9000, refundedQuantity: 10, remainingAmount: 1000 });
    expect(rows[legacy.id]).toMatchObject({ status: "REFUNDED", refundedAmount: 7000, refundedQuantity: 7, remainingAmount: 0 });
    expect(rows[cancelled.id]).toMatchObject({ refundedAmount: 0, refundedQuantity: 0, remainingAmount: 10000 });
    // itemSummary.refundedQuantity와 같은 값
    expect(rows[partial.id].itemSummary.refundedQuantity).toBe(5);
    // 다른 판매자 목록에는 자기 주문 값만
    const bRows = (await list(b.cookie)).body.orders;
    expect(bRows).toHaveLength(1);
    expect(bRows[0]).toMatchObject({ refundedAmount: 100, remainingAmount: 9900 });
  });
});
