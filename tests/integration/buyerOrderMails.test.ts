import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../lib/server/db";
import { FakeMailSender } from "../../lib/server/mail/registry";
import { LOOKBACK_MS, sendBuyerOrderMails } from "../../lib/server/orders/buyerMails";
import { createBuyer, createSeller, db, resetDb } from "./helpers";

// 구매자 거래 메일(EM-001~004) 정기 발송: 읽기 전용으로 결제·발송·배송 완료·환불 기록을 보고 한 번씩 보낸다
beforeEach(async () => {
  await resetDb();
  process.env.APP_ORIGIN = "https://onq.example";
  await db.platformMessageSetting.create({ data: { id: 1, chargingEnabled: true } });
});
afterEach(() => {
  delete process.env.APP_ORIGIN;
});
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const NOW = new Date("2026-10-06T03:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const H = 3600_000;
let seq = 100;

async function shop(quota = 100) {
  const { seller, grade } = await createSeller();
  const plan = await db.subscriptionPlan.update({ where: { code: "INTEGRATED" }, data: { mailMonthlyQuota: quota } });
  await db.seller.update({ where: { id: seller.id }, data: { planId: plan.id, shopName: "카드숍 별빛", businessInfo: { companyName: "별빛상사", representativeName: "김대표", businessNumber: "123-45-67890", mailOrderNumber: "2026-서울강남-0001" } } });
  await db.shopLegalNotice.create({ data: { sellerId: seller.id, address: "서울 강남구 테헤란로 1", csPhone: "02-000-0000", csEmail: "cs@example.com" } });
  await db.sellerBrandColor.create({ data: { sellerId: seller.id, color: "#E11D48" } });
  const buyer = await createBuyer(seller.id, grade.id);
  await db.buyerMember.update({ where: { id: buyer.id }, data: { loginId: "buyer@example.com" } });
  return { seller: await db.seller.findUniqueOrThrow({ where: { id: seller.id } }), buyer: { ...buyer, loginId: "buyer@example.com" } };
}

type S = Awaited<ReturnType<typeof shop>>;
async function order(s: S, over: Record<string, unknown> = {}, shipment?: Record<string, unknown>) {
  const product = await db.product.create({ data: { sellerId: s.seller.id, name: "스타라이트 부스터 박스", price: 89_100, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId: s.seller.id, productId: product.id, name: "1박스", stock: 10 } });
  const o = await db.order.create({
    data: { sellerId: s.seller.id, orderNo: ++seq, buyerMemberId: s.buyer.id, status: "PAID", paymentMethod: "CARD", broadcastNicknameSnapshot: "별구름", totalAmount: 178_200, rewardUsedAmount: 0, createdAt: ago(2 * H), paidAt: ago(H), ...over },
  });
  const item = await db.orderItem.create({ data: { sellerId: s.seller.id, orderId: o.id, productId: product.id, optionId: option.id, productNameSnapshot: product.name, optionNameSnapshot: option.name, unitPrice: 89_100, quantity: 2 } });
  await db.orderShippingAddress.create({ data: { sellerId: s.seller.id, orderId: o.id, recipientName: "김구매", phone: "010-0000-0000", zipCode: "04000", address1: "서울 마포구 월드컵로 1", address2: "101호", memo: "문 앞에 두세요" } });
  if (shipment) await db.shipment.create({ data: { sellerId: s.seller.id, orderId: o.id, courier: "CJ대한통운", trackingNumber: "1234567890", shippedAt: ago(H), ...shipment } });
  return { o, item };
}
const run = (sender: FakeMailSender | null) => sendBuyerOrderMails(prisma, NOW, { sender });

describe("결제 확인(EM-001)", () => {
  it("결제된 주문에 대해 구매자 이메일로 한 번만 보낸다(쇼핑몰 이름·품목·받는 분·바닥글), 다시 돌려도 중복 없음", async () => {
    const s = await shop();
    const { o } = await order(s);
    const sender = new FakeMailSender();
    expect(await run(sender)).toBe(1);
    const m = sender.sent[0];
    expect(m.to).toBe("buyer@example.com");
    expect(m.subject).toBe("[카드숍 별빛] 주문이 접수됐어요");
    for (const t of ["별구름님, 주문해 주셔서 고마워요", "스타라이트 부스터 박스 · 1박스", "x 2", "178,200원", "김구매 · 010-0000-0000", "서울 마포구 월드컵로 1 101호", "문 앞에 두세요", `https://onq.example/shop/${s.seller.slug}/orders/${o.id}`, "상호 별빛상사 · 대표 김대표 · 사업자등록번호 123-45-67890 · 통신판매업 신고 2026-서울강남-0001", "고객센터 02-000-0000 · cs@example.com"]) expect(m.text).toContain(t);
    expect(m.html).toContain("#e11d48");
    expect(await run(sender)).toBe(0);
    expect(sender.sent).toHaveLength(1);
    expect(await db.mailDelivery.findFirstOrThrow({ where: { kind: "order.paid", refId: o.id } })).toMatchObject({ status: "SENT", sellerId: s.seller.id, charged: false });
  });

  it("무통장 주문은 접수 때 입금 계좌 안내, 입금이 확인되면 결제 확인 메일. 계좌가 없거나 기한이 지난 주문은 안내하지 않는다", async () => {
    const s = await shop();
    await db.sellerBankAccount.create({ data: { sellerId: s.seller.id, bankName: "신한은행", accountNumber: "110-000-000000", accountHolder: "별빛상사" } });
    const pending = await order(s, { status: "PENDING_PAYMENT", paymentMethod: "BANK_TRANSFER", paidAt: null, paymentDueAt: new Date(NOW.getTime() + 20 * H) });
    await order(s, { status: "PENDING_PAYMENT", paymentMethod: "BANK_TRANSFER", paidAt: null, paymentDueAt: ago(H) }); // 기한 지남
    const sender = new FakeMailSender();
    expect(await run(sender)).toBe(1);
    expect(sender.sent[0].subject).toBe("[카드숍 별빛] 주문이 접수됐어요 · 입금을 기다려요");
    for (const t of ["신한은행", "110-000-000000", "예금주: 별빛상사", "입금해 주세요"]) expect(sender.sent[0].text).toContain(t);
    // 입금 확인
    await db.order.update({ where: { id: pending.o.id }, data: { status: "PAID", paidAt: NOW } });
    expect(await run(sender)).toBe(1);
    expect(sender.sent[1].text).toContain("무통장 입금");
    expect(await db.mailDelivery.count({ where: { refId: pending.o.id } })).toBe(2);
    // 계좌가 없는 쇼핑몰은 접수 안내를 보내지 않는다
    const s2 = await shop();
    await order(s2, { status: "PENDING_PAYMENT", paymentMethod: "BANK_TRANSFER", paidAt: null, paymentDueAt: new Date(NOW.getTime() + 20 * H) });
    expect(await run(sender)).toBe(0);
  });
});

describe("발송(EM-002)·배송 완료(EM-003)", () => {
  it("발송은 택배사·송장, 배송 완료는 완료 안내(적립금은 배송 완료 시 적립 주문만)를 한 번씩", async () => {
    const s = await shop();
    const { o } = await order(s, { paidAt: ago(30 * H), rewardEarnTiming: "ON_DELIVERY", rewardEarnAmount: 9306 }, { shippedAt: ago(2 * H), deliveredAt: ago(H), status: "DELIVERED" });
    const sender = new FakeMailSender();
    // 결제는 24시간보다 오래전이라 결제 메일은 없고 발송·배송 완료만
    expect(await run(sender)).toBe(2);
    const kinds = (await db.mailDelivery.findMany({ where: { refId: o.id }, orderBy: { kind: "asc" } })).map((d) => d.kind);
    expect(kinds).toEqual(["order.delivered", "order.shipped"]);
    const shipped = sender.sent.find((m) => m.subject.includes("상품을 보냈어요"))!;
    for (const t of ["CJ대한통운", "1234567890", "보낸 날: 2026.10.06 (화)"]) expect(shipped.text).toContain(t);
    const delivered = sender.sent.find((m) => m.subject.includes("상품이 도착했어요"))!;
    expect(delivered.text).toContain("적립금 9,306원이 쌓였어요");
    expect(await run(sender)).toBe(0);
  });
});

describe("환불(EM-004)", () => {
  it("마지막 환불은 주문 취소, 일부 환불은 부분 취소 안내(남은 품목·환불 금액), 환불마다 한 통", async () => {
    const s = await shop();
    const { o, item } = await order(s, { status: "REFUNDED", refundAmount: 178_200 });
    await db.orderItem.update({ where: { id: item.id }, data: { refundedQuantity: 1 } });
    const base = { sellerId: s.seller.id, orderId: o.id, reason: "구매자 요청", itemsAmount: 89_100, shippingRefunded: 0, returnFeeDeducted: 0, rewardRevoke: 0, isFinal: false, actorType: "SELLER_USER" as const, createdAt: ago(H) };
    await db.orderRefund.create({ data: { ...base, seq: 1, items: [{ orderItemId: item.id, quantity: 1, amount: 89_100 }], refundAmount: 89_100, rewardReturn: 0 } });
    await db.orderRefund.create({ data: { ...base, seq: 2, isFinal: true, items: [{ orderItemId: item.id, quantity: 1, amount: 89_100 }], refundAmount: 89_100, rewardReturn: 5_000, createdAt: ago(H / 2) } });
    const sender = new FakeMailSender();
    expect(await run(sender)).toBe(2);
    const part = sender.sent.find((m) => m.subject.includes("일부를 취소"))!;
    for (const t of ["스타라이트 부스터 박스 ×1 · 89,100원 취소", "환불 금액: 89,100원", "나머지 상품은 그대로 진행돼요"]) expect(part.text).toContain(t);
    const full = sender.sent.find((m) => m.subject.includes("주문을 취소했어요"))!;
    for (const t of ["취소 사유: 구매자 요청", "환불 금액: 89,100원", "적립금 사용한 5,000원을 돌려드렸어요", "3~5영업일 안에 카드사 기준으로 반영"]) expect(full.text).toContain(t);
    expect((await db.mailDelivery.findMany({ where: { kind: "order.refund" } })).map((d) => d.refId).sort()).toEqual([`${o.id}:1`, `${o.id}:2`]);
    expect(await run(sender)).toBe(0);
  });

  it("무통장 주문 환불은 입력한 계좌로 돌려준다는 안내(계좌를 모르면 번호 없이)", async () => {
    const s = await shop();
    const { o } = await order(s, { paymentMethod: "BANK_TRANSFER", status: "REFUNDED" });
    await db.orderRefund.create({ data: { sellerId: s.seller.id, orderId: o.id, seq: 1, reason: "단순 변심", items: [], itemsAmount: 178_200, shippingRefunded: 0, refundAmount: 178_200, returnFeeDeducted: 0, rewardReturn: 0, rewardRevoke: 0, isFinal: true, actorType: "SELLER_USER", createdAt: ago(H) } });
    const sender = new FakeMailSender();
    expect(await run(sender)).toBe(1);
    expect(sender.sent[0].text).toContain("무통장 환불 · 입력한 계좌로 돌려 드려요");
    expect(sender.sent[0].text).not.toContain("카드사");
  });
});

describe("보내지 않는 경우·비용", () => {
  it("판매자가 끈 종류·이메일이 아닌 아이디·24시간 지난 일·공급자 또는 APP_ORIGIN 없음은 보내지 않는다", async () => {
    const s = await shop();
    await db.sellerOrderNotificationPolicy.create({ data: { sellerId: s.seller.id, orderCompleteEnabled: false } });
    await order(s); // 결제 확인 메일 꺼짐
    const s2 = await shop();
    await db.buyerMember.update({ where: { id: s2.buyer.id }, data: { loginId: "phone-only-user" } });
    await order(s2); // 이메일 아님
    const s3 = await shop();
    await order(s3, { paidAt: ago(LOOKBACK_MS + H) }); // 24시간 지남
    const s4 = await shop();
    await order(s4);
    const sender = new FakeMailSender();
    expect(await run(null)).toBe(0);
    delete process.env.APP_ORIGIN;
    expect(await run(sender)).toBe(0);
    process.env.APP_ORIGIN = "https://onq.example";
    expect(await run(sender)).toBe(1); // s4만
    expect(sender.sent[0].to).toBe("buyer@example.com");
    expect(await db.mailDelivery.count({ where: { sellerId: s.seller.id } })).toBe(0);
    expect(await db.mailDelivery.count({ where: { sellerId: s2.seller.id } })).toBe(0);
  });

  it("제공량(월 1통)을 넘으면 충전 잔액에서 차감하고, 잔액이 없으면 그 메일만 건너뛴다(주문은 그대로, 다시 보내지 않음)", async () => {
    const s = await shop(1);
    await db.messageChannelPrice.upsert({ where: { channel: "MAIL_TRANSACTIONAL" }, create: { channel: "MAIL_TRANSACTIONAL", unitPrice: 10 }, update: { unitPrice: 10 } });
    const a = await order(s, { paidAt: ago(3 * H) });
    const b = await order(s, { paidAt: ago(2 * H) });
    const c = await order(s, { paidAt: ago(H) });
    const sender = new FakeMailSender();
    expect(await run(sender)).toBe(1); // 첫 통만 무료, 나머지는 잔액 없음
    const rows = await db.mailDelivery.findMany({ where: { sellerId: s.seller.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.status)).toEqual(["SENT", "SKIPPED_BALANCE", "SKIPPED_BALANCE"]);
    expect((await db.order.findMany({ where: { id: { in: [a.o.id, b.o.id, c.o.id] } } })).every((x) => x.status === "PAID")).toBe(true);
    expect(await run(sender)).toBe(0); // 건너뛴 건은 다시 보내지 않음
    // 잔액을 채워도 이미 건너뛴 건은 그대로, 새 주문부터 차감
    await db.sellerMessageBalance.upsert({ where: { sellerId: s.seller.id }, create: { sellerId: s.seller.id, paidBalance: 25, freeBalance: 0 }, update: { paidBalance: 25 } });
    await order(s, { paidAt: ago(H / 2) });
    expect(await run(sender)).toBe(1);
    const d = await db.mailDelivery.findFirstOrThrow({ where: { sellerId: s.seller.id, status: "SENT", charged: true } });
    expect(d.charged).toBe(true);
    expect((await db.sellerMessageBalance.findUniqueOrThrow({ where: { sellerId: s.seller.id } })).paidBalance).toBe(15);
  });

  it("동시에 두 번 돌려도 주문당 한 통만 보낸다", async () => {
    const s = await shop();
    await order(s);
    await order(s);
    const sender = new FakeMailSender();
    const [x, y] = await Promise.all([run(sender), run(sender)]);
    expect(x + y).toBe(2);
    expect(sender.sent).toHaveLength(2);
  });
});
