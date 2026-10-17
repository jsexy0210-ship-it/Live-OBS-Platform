import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as getRoute, PUT as putRoute } from "../../app/api/seller/shipping-automation/route";
import { createSellerSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };

async function shop(opts: { staff?: "MANAGER" | "BROADCASTER" | null; plan?: "INTEGRATED" | "OVERLAY_ONLY" } = {}) {
  const { seller } = await createSeller();
  if (opts.plan === "OVERLAY_ONLY") {
    const overlay = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "OVERLAY_ONLY" } });
    await db.seller.update({ where: { id: seller.id }, data: { planId: overlay.id } });
  }
  const user = await createSellerUser(seller.id, opts.staff ?? "OWNER");
  const cookie = `lo_seller=${(await createSellerSession(db, seller.id, user.id, {}, user.credentialVersion)).token}`;
  const get = () => getRoute(new Request("http://localhost:3000/api/seller/shipping-automation", { headers: { cookie } }));
  const put = (body: unknown) => putRoute(new Request("http://localhost:3000/api/seller/shipping-automation", { method: "PUT", headers: { ...H, cookie }, body: JSON.stringify(body) }));
  return { seller, get, put };
}

const priceAll = async () => {
  for (const [channel, unitPrice] of [["INVOICE_ISSUE", 50], ["INVOICE_LABEL", 20], ["DELIVERY_TRACKING", 30]] as const) {
    await db.messageChannelPrice.upsert({ where: { channel }, create: { channel, unitPrice }, update: { unitPrice } });
  }
};

describe("배송 자동화(SA-082)", () => {
  it("처음에는 기능 4개 모두 꺼짐이고, 단가는 마스터 관리자 값, 사용 0건. 순서는 발급·출력·조회·반품", async () => {
    await priceAll();
    const s = await shop();
    const body = await (await s.get()).json();
    expect(body.features).toEqual([
      { feature: "invoiceIssue", enabled: false, unitPrice: 50, monthCount: 0, monthAmount: 0 },
      { feature: "invoiceLabel", enabled: false, unitPrice: 20, monthCount: 0, monthAmount: 0 },
      { feature: "deliveryTracking", enabled: false, unitPrice: 30, monthCount: 0, monthAmount: 0 },
      { feature: "returnInvoice", enabled: false, unitPrice: 50, monthCount: 0, monthAmount: 0 },
    ]);
    expect(body).toMatchObject({ enabledCount: 0, monthCount: 0, monthAmount: 0, balance: 0, shortage: [] });
  });

  it("켜고 끄면 반영되고 빼면 유지된다. 배송 자동 조회는 주문 정책 값과 같다. 같은 값이면 로그 추적을 남기지 않는다", async () => {
    const s = await shop();
    const on = await s.put({ invoiceIssue: true, deliveryTracking: true });
    expect(on.status).toBe(200);
    const body = await on.json();
    expect(body.features.map((f: { enabled: boolean }) => f.enabled)).toEqual([true, false, true, false]);
    expect(body.enabledCount).toBe(2);
    expect((await db.sellerOrderPolicy.findUniqueOrThrow({ where: { sellerId: s.seller.id } })).autoTrackingEnabled).toBe(true);
    // 주문 정책 화면에서 저장한 적 없는 기본 행이면 savedAt을 만들지 않는다
    expect((await db.sellerOrderPolicy.findUniqueOrThrow({ where: { sellerId: s.seller.id } })).savedAt).toBeNull();
    const off = await (await s.put({ invoiceIssue: false })).json();
    expect(off.features.map((f: { enabled: boolean }) => f.enabled)).toEqual([false, false, true, false]);
    expect(await db.auditLog.count({ where: { sellerId: s.seller.id, action: "seller.shipping_automation.update" } })).toBe(2);
    await s.put({ invoiceIssue: false, deliveryTracking: true });
    expect(await db.auditLog.count({ where: { sellerId: s.seller.id, action: "seller.shipping_automation.update" } })).toBe(2);
    // 주문 정책에서 끄면 여기서도 꺼진 것으로 보인다
    await db.sellerOrderPolicy.update({ where: { sellerId: s.seller.id }, data: { autoTrackingEnabled: false } });
    expect((await (await s.get()).json()).features[2].enabled).toBe(false);
  });

  it("틀린 본문은 400 invalid_automation(바꾸지 않음)", async () => {
    const s = await shop();
    for (const bad of [{}, { invoiceIssue: "true" }, { returnInvoice: 1 }, null, [], { unknown: true }]) {
      const r = await s.put(bad);
      expect([r.status, (await r.json()).error]).toEqual([400, "invalid_automation"]);
    }
    expect(await db.sellerShippingAutomation.count()).toBe(0);
  });

  it("이번 달 사용 건수·금액은 성공한 차감만(되돌린 것·지난달 제외), 합계와 잔액·충전 기능이 함께 나온다", async () => {
    await priceAll();
    await db.platformMessageSetting.upsert({ where: { id: 1 }, create: { id: 1, chargingEnabled: true }, update: { chargingEnabled: true } });
    const s = await shop();
    await db.sellerMessageBalance.create({ data: { sellerId: s.seller.id, paidBalance: 700, freeBalance: 300 } });
    const base = { sellerId: s.seller.id, type: "DEBIT" as const, actorType: "SYSTEM" as const };
    const now = new Date();
    const lastMonth = new Date(now.getTime() - 40 * 86_400_000);
    await db.sellerMessageLedger.createMany({
      data: [
        { ...base, status: "SUCCEEDED", channel: "DELIVERY_TRACKING", quantity: 3, unitPrice: 30, paidAmount: -60, freeAmount: -30, idempotencyKey: "a", createdAt: now },
        { ...base, status: "SUCCEEDED", channel: "INVOICE_ISSUE", quantity: 2, unitPrice: 50, paidAmount: -100, freeAmount: 0, idempotencyKey: "b", createdAt: now },
        { ...base, status: "REVERSED", channel: "INVOICE_ISSUE", quantity: 5, unitPrice: 50, paidAmount: -250, freeAmount: 0, idempotencyKey: "c", createdAt: now },
        { ...base, status: "SUCCEEDED", channel: "INVOICE_LABEL", quantity: 9, unitPrice: 20, paidAmount: -180, freeAmount: 0, idempotencyKey: "d", createdAt: lastMonth },
      ],
    });
    const body = await (await s.get()).json();
    expect(body.features.map((f: { monthCount: number; monthAmount: number }) => [f.monthCount, f.monthAmount])).toEqual([[2, 100], [0, 0], [3, 90], [0, 0]]);
    expect(body).toMatchObject({ monthCount: 5, monthAmount: 190, balance: 1000, chargingEnabled: true });
  });

  it("충전금이 모자라 멈춘 기능은 shortage에 나온다(해결되면 사라짐)", async () => {
    const s = await shop();
    const at = new Date();
    await db.messageShortage.create({ data: { sellerId: s.seller.id, channel: "DELIVERY_TRACKING", reason: "INSUFFICIENT_BALANCE", count: 1, firstAt: at, lastAt: at } });
    await db.messageShortage.create({ data: { sellerId: s.seller.id, channel: "INVOICE_LABEL", reason: "CHARGING_DISABLED", count: 1, firstAt: at, lastAt: at, resolvedAt: at } });
    expect((await (await s.get()).json()).shortage).toEqual(["deliveryTracking"]);
  });

  it("쇼핑몰 설정 권한이 없는 직원은 보기·바꾸기 403, 오버레이 전용 요금제는 403 plan_feature_required(바꾸지 않음)", async () => {
    const staff = await shop({ staff: "BROADCASTER" });
    expect((await staff.get()).status).toBe(403);
    expect((await staff.put({ invoiceIssue: true })).status).toBe(403);
    const overlay = await shop({ plan: "OVERLAY_ONLY" });
    const noPlan = await overlay.get();
    expect([noPlan.status, (await noPlan.json()).error]).toEqual([403, "plan_feature_required"]);
    expect((await overlay.put({ invoiceIssue: true })).status).toBe(403);
    expect(await db.sellerShippingAutomation.count()).toBe(0);
  });
});
