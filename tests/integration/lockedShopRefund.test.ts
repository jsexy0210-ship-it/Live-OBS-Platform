import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as refundRoute } from "../../app/api/seller/orders/[orderId]/refund/route";
import { GET as versionRoute } from "../../app/api/seller/queue/version/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { markOrderPaid } from "../../lib/server/queue/service";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 잠긴 쇼핑몰(체험·구독 끝)도 이미 받은 주문은 환불할 수 있다(PRODUCT_SCOPE 「잠금 중 허용 범위」).
// 판매자 환불 화면은 보내기 직전에 주문대기 버전을 읽으므로, 버전 조회도 잠금 중에 열려 있어야 한다.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const addr = { recipientName: "김구매", phone: "010-1234-5678", zipCode: "06236", address1: "주소 1" };

describe("잠긴 쇼핑몰의 환불", () => {
  it("주문대기 버전을 읽고 그 버전으로 결제 완료 주문을 환불할 수 있다", async () => {
    const { seller, grade } = await createSeller();
    const buyer = await createLoginBuyer(seller.id, grade.id);
    const owner = await createSellerUser(seller.id, "OWNER");
    const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
    const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1박스", stock: 50 } });
    const o = await createOrder(db, { sellerId: seller.id, buyerMemberId: buyer.id, items: [{ optionId: option.id, quantity: 1 }], consent, shippingAddress: addr });
    if (!o.ok) throw new Error(o.reason);
    await markOrderPaid(db, { sellerId: seller.id, orderId: o.orderId, paymentMethod: "CARD" });
    const login = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    const cookie = `lo_seller=${login.token}`;
    // 체험이 끝나 잠김
    await db.seller.update({ where: { id: seller.id }, data: { trialEndsAt: new Date(Date.now() - 1000) } });

    const v = await versionRoute(new Request("http://localhost:3000/api/seller/queue/version", { headers: { ...H, cookie } }));
    expect(v.status).toBe(200);
    const { version } = (await v.json()) as { version: number };
    expect(Number.isInteger(version)).toBe(true);

    const r = await refundRoute(
      new Request(`http://localhost:3000/api/seller/orders/${o.orderId}/refund`, {
        method: "POST",
        headers: { ...H, cookie },
        body: JSON.stringify({ reason: "품절 · 재고 없음", expectedVersion: version, fault: "SELLER" }),
      }),
      { params: Promise.resolve({ orderId: o.orderId }) },
    );
    expect(r.status).toBe(200);
    expect((await db.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe("REFUNDED");
  });
});
