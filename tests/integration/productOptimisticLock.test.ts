import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as audit from "../../lib/server/audit/log";
import { PATCH as patchRoute } from "../../app/api/seller/products/[productId]/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { ORDER_ERROR_MESSAGES_FORMAL } from "../../lib/server/orders/messages";
import { createProduct, updateProduct } from "../../lib/server/products/manage";
import { setProductEvent } from "../../lib/server/products/event";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 상품 PATCH 낙관적 잠금: expectedPrice·expectedStatus(선택)가 지금 값과 다르면 바꾸지 않고 409
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

async function shop() {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const r = await createProduct(db, ctx, { name: "부스터 팩", price: 1000, status: "ON_SALE", options: [{ name: "기본", stock: 5 }] });
  if (!r.ok) throw new Error(r.reason);
  return { seller, owner, ctx, productId: r.value.id };
}
const row = (id: string) => db.product.findUniqueOrThrow({ where: { id }, select: { price: true, status: true, name: true } });
const updates = (sellerId: string) => db.auditLog.count({ where: { sellerId, action: "product.update" } });

describe("가격과 이벤트의 원자적 수정", () => {
  const event = (value = 20) => ({ type: "RATE", value, startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 3600_000).toISOString() });
  const snapshot = (id: string) => db.product.findUniqueOrThrow({ where: { id }, select: { price: true, eventDiscountType: true, eventDiscountValue: true, eventStartsAt: true, eventEndsAt: true } });
  const audits = (id: string) => db.auditLog.count({ where: { targetId: id } });

  it("활성 할인 변경·해제 요청이 가격 충돌이면 기존 가격·이벤트 4필드·audit를 유지한다", async () => {
    const s = await shop();
    expect((await setProductEvent(db, s.ctx, s.productId, event(10))).ok).toBe(true);
    await updateProduct(db, s.ctx, s.productId, { price: 2000, expectedPrice: 1000 });
    const before = await snapshot(s.productId), count = await audits(s.productId);
    for (const next of [event(), null]) {
      expect(await updateProduct(db, s.ctx, s.productId, { price: 1500, expectedPrice: 1000, event: next })).toMatchObject({ reason: "price_conflict", currentPrice: 2000 });
      expect(await snapshot(s.productId)).toEqual(before);
      expect(await audits(s.productId)).toBe(count);
    }
  });

  it("이벤트 형식·기간·최종 단가가 잘못되면 가격·할인·audit를 바꾸지 않는다", async () => {
    const s = await shop();
    await setProductEvent(db, s.ctx, s.productId, event(10));
    const before = await snapshot(s.productId), count = await audits(s.productId);
    const invalid = [[], "20", event(91), { ...event(), value: "20" }, { ...event(), endsAt: new Date(Date.now() - 1000).toISOString() }, { ...event(), type: "AMOUNT", value: 1900 }];
    for (const next of invalid) {
      expect((await updateProduct(db, s.ctx, s.productId, { price: 1500, expectedPrice: 1000, event: next })).ok).toBe(false);
      expect(await snapshot(s.productId)).toEqual(before);
      expect(await audits(s.productId)).toBe(count);
    }
    expect(await updateProduct(db, s.ctx, s.productId, { name: "x", event: event() })).toMatchObject({ reason: "invalid_product" });
    expect(await updateProduct(db, s.ctx, s.productId, { price: 1500, event: event() })).toMatchObject({ reason: "invalid_product" });
  });

  it("낮춘 가격과 새 할인을 최종값으로 함께 검증해 저장하고, 해제도 함께 저장한다", async () => {
    const s = await shop();
    await setProductEvent(db, s.ctx, s.productId, { ...event(), type: "AMOUNT", value: 800 });
    expect(await updateProduct(db, s.ctx, s.productId, { price: 500, expectedPrice: 1000, event: { ...event(), type: "AMOUNT", value: 200 } })).toMatchObject({ ok: true, value: { price: 500, event: { value: 200, discountedPrice: 300 } } });
    expect(await updates(s.seller.id)).toBe(1);
    expect(await db.auditLog.count({ where: { targetId: s.productId, action: "product.event_set" } })).toBe(2);
    expect(await updateProduct(db, s.ctx, s.productId, { price: 100, expectedPrice: 500, event: null })).toMatchObject({ ok: true, value: { price: 100, event: null } });
    expect(await db.auditLog.count({ where: { targetId: s.productId, action: "product.event_clear" } })).toBe(1);
  });

  it("같은 기대값의 병렬 가격+할인 요청은 하나만 저장하고 audit도 그 한 쌍만 남긴다", async () => {
    const s = await shop();
    await setProductEvent(db, s.ctx, s.productId, event(10));
    const rs = await Promise.all([20, 30, 40, 50].map(value => updateProduct(db, s.ctx, s.productId, { price: value * 100, expectedPrice: 1000, event: event(value) })));
    expect(rs.filter(r => r.ok)).toHaveLength(1);
    expect(rs.filter(r => !r.ok && r.reason === "price_conflict")).toHaveLength(3);
    const after = await snapshot(s.productId);
    expect(after.price).toBe(after.eventDiscountValue! * 100);
    expect(await updates(s.seller.id)).toBe(1);
    expect(await db.auditLog.count({ where: { targetId: s.productId, action: "product.event_set" } })).toBe(2);
  });

  it("이벤트 audit 저장이 실패하면 앞선 가격·이벤트 update와 상품 audit도 롤백한다", async () => {
    const s = await shop();
    await setProductEvent(db, s.ctx, s.productId, event(10));
    const before = await snapshot(s.productId), count = await audits(s.productId);
    const original = audit.writeAudit;
    const spy = vi.spyOn(audit, "writeAudit").mockImplementation(async (tx, entry) => {
      if (entry.action === "product.event_set") throw new Error("event audit test failure");
      return original(tx, entry);
    });
    try { await expect(updateProduct(db, s.ctx, s.productId, { price: 1500, expectedPrice: 1000, event: event() })).rejects.toThrow("event audit test failure"); }
    finally { spy.mockRestore(); }
    expect(await snapshot(s.productId)).toEqual(before);
    expect(await audits(s.productId)).toBe(count);
  });

  it("새 혼합 payload도 상품 권한·조회 전용·다른 tenant를 우회하지 못한다", async () => {
    const s = await shop(), other = await shop();
    const before = await snapshot(s.productId), count = await audits(s.productId);
    for (const [ctx, status] of [[{ ...s.ctx, isOwner: false, permissions: [] }, 403], [{ ...s.ctx, readOnly: true }, 403], [other.ctx, 404]] as [TenantContext, number][]) {
      await expect(updateProduct(db, ctx, s.productId, { price: 1500, expectedPrice: 1000, event: event() })).rejects.toMatchObject({ status });
    }
    expect(await snapshot(s.productId)).toEqual(before);
    expect(await audits(s.productId)).toBe(count);
  });
});

describe("expectedPrice", () => {
  it("지금 판매가와 같으면 바꾸고, 다르면 바꾸지 않고 지금 판매가를 돌려준다", async () => {
    const s = await shop();
    expect((await updateProduct(db, s.ctx, s.productId, { price: 2000, expectedPrice: 1000 })).ok).toBe(true);
    expect((await row(s.productId)).price).toBe(2000);
    const stale = await updateProduct(db, s.ctx, s.productId, { price: 3000, name: "바뀌면 안 됨", expectedPrice: 1000 });
    expect(stale).toEqual({ ok: false, reason: "price_conflict", currentPrice: 2000 });
    expect(await row(s.productId)).toMatchObject({ price: 2000, name: "부스터 팩" });
    expect(await updates(s.seller.id)).toBe(1);
  });

  it("판매가를 안 바꾸는 요청(이름만)에도 화면이 본 판매가와 다르면 거절한다", async () => {
    const s = await shop();
    expect(await updateProduct(db, s.ctx, s.productId, { name: "새 이름", expectedPrice: 999 })).toEqual({ ok: false, reason: "price_conflict", currentPrice: 1000 });
    expect((await row(s.productId)).name).toBe("부스터 팩");
  });

  it("형식이 틀리면(정수 아님·0 이하·범위 밖) 400 계열로 거절하고 바꾸지 않는다", async () => {
    const s = await shop();
    for (const bad of ["1000", 0, -5, 1.5, null, 2147483648, {}]) {
      expect(await updateProduct(db, s.ctx, s.productId, { price: 2000, expectedPrice: bad })).toEqual({ ok: false, reason: "invalid_price" });
    }
    expect((await row(s.productId)).price).toBe(1000);
  });
});

describe("expectedStatus", () => {
  it("지금 판매 상태와 같으면 바꾸고, 다르면 바꾸지 않고 지금 상태를 돌려준다", async () => {
    const s = await shop();
    expect((await updateProduct(db, s.ctx, s.productId, { status: "HIDDEN", expectedStatus: "ON_SALE" })).ok).toBe(true);
    const stale = await updateProduct(db, s.ctx, s.productId, { status: "SOLD_OUT", expectedStatus: "ON_SALE" });
    expect(stale).toEqual({ ok: false, reason: "status_conflict", currentStatus: "HIDDEN" });
    expect((await row(s.productId)).status).toBe("HIDDEN");
  });

  it("형식이 틀리면 거절하고 바꾸지 않는다", async () => {
    const s = await shop();
    for (const bad of ["on_sale", "판매중", 1, null, ""]) {
      expect(await updateProduct(db, s.ctx, s.productId, { status: "HIDDEN", expectedStatus: bad })).toEqual({ ok: false, reason: "invalid_product" });
    }
    expect((await row(s.productId)).status).toBe("ON_SALE");
  });
});

describe("함께·없을 때·동시에", () => {
  it("둘 다 보내면 판매가를 먼저 비교하고, 판매가가 맞으면 상태를 비교한다. 둘 다 맞아야 바뀐다", async () => {
    const s = await shop();
    expect(await updateProduct(db, s.ctx, s.productId, { name: "x", expectedPrice: 1, expectedStatus: "HIDDEN" })).toMatchObject({ reason: "price_conflict", currentPrice: 1000 });
    expect(await updateProduct(db, s.ctx, s.productId, { name: "x", expectedPrice: 1000, expectedStatus: "HIDDEN" })).toMatchObject({ reason: "status_conflict", currentStatus: "ON_SALE" });
    expect((await row(s.productId)).name).toBe("부스터 팩");
    expect((await updateProduct(db, s.ctx, s.productId, { name: "새 이름", expectedPrice: 1000, expectedStatus: "ON_SALE" })).ok).toBe(true);
    expect((await row(s.productId)).name).toBe("새 이름");
  });

  it("둘 다 없으면 지금 동작 그대로(이전 값과 상관없이 바뀐다), 바꿀 항목 없이 expected만 보내면 400", async () => {
    const s = await shop();
    expect((await updateProduct(db, s.ctx, s.productId, { price: 1500 })).ok).toBe(true);
    expect((await updateProduct(db, s.ctx, s.productId, { price: 1700 })).ok).toBe(true);
    expect(await updateProduct(db, s.ctx, s.productId, { expectedPrice: 1700 })).toEqual({ ok: false, reason: "invalid_product" });
    expect((await row(s.productId)).price).toBe(1700);
  });

  it("같은 판매가를 보고 동시에 바꾸면 한쪽만 반영되고 다른 쪽은 충돌(마지막 쓴 값이 조용히 덮어쓰지 않는다)", async () => {
    const s = await shop();
    const rs = await Promise.all([2000, 3000, 4000, 5000].map((price) => updateProduct(db, s.ctx, s.productId, { price, expectedPrice: 1000 })));
    const won = rs.filter((r) => r.ok);
    expect(won).toHaveLength(1);
    expect(rs.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "price_conflict")).toBe(true);
    const finalPrice = (await row(s.productId)).price;
    expect([2000, 3000, 4000, 5000]).toContain(finalPrice);
    expect(rs.filter((r) => !r.ok).every((r) => !r.ok && r.currentPrice === finalPrice)).toBe(true);
    expect(await updates(s.seller.id)).toBe(1);
  });

  it("충돌 검사가 다른 검증보다 먼저라, 낡은 화면이 보낸 잘못된 값 때문에 엉뚱한 오류를 받지 않는다", async () => {
    const s = await shop();
    await updateProduct(db, s.ctx, s.productId, { price: 2000 });
    expect(await updateProduct(db, s.ctx, s.productId, { status: "ON_SALE", price: 5, expectedPrice: 1000 })).toMatchObject({ reason: "price_conflict" });
  });
});

describe("권한·격리·API", () => {
  it("다른 파트너스 상품은 expected 값이 틀려도 충돌이 아니라 없는 상품으로 거절하고 지금 값을 알려 주지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    await expect(updateProduct(db, b.ctx, a.productId, { price: 5, expectedPrice: 1 })).rejects.toBeDefined();
    expect((await row(a.productId)).price).toBe(1000);
  });

  it("상품 관리 권한이 없는 직원·조회 전용은 거절", async () => {
    const s = await shop();
    for (const c of [{ ...s.ctx, isOwner: false, permissions: [] }, { ...s.ctx, readOnly: true }] as TenantContext[]) {
      await expect(updateProduct(db, c, s.productId, { price: 5, expectedPrice: 1000 })).rejects.toBeDefined();
    }
    expect((await row(s.productId)).price).toBe(1000);
  });

  it("PATCH 라우트: 맞으면 200, 판매가 충돌 409 { error, message, currentPrice }, 상태 충돌 409 { …, currentStatus }, 형식 오류 400, 없으면 지금 동작", async () => {
    const s = await shop();
    const login = await loginSeller(db, { email: s.owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    const patch = (body: unknown) =>
      patchRoute(
        new Request("http://localhost:3000/x", { method: "PATCH", headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json", cookie: `lo_seller=${login.token}` }, body: JSON.stringify(body) }),
        { params: Promise.resolve({ productId: s.productId }) },
      );
    expect((await patch({ price: 2000, expectedPrice: 1000 })).status).toBe(200);
    const pc = await patch({ price: 3000, expectedPrice: 1000 });
    expect([pc.status, await pc.json()]).toEqual([409, { error: "price_conflict", message: ORDER_ERROR_MESSAGES_FORMAL.price_conflict, currentPrice: 2000 }]);
    const sc = await patch({ status: "HIDDEN", expectedStatus: "SOLD_OUT" });
    expect([sc.status, await sc.json()]).toEqual([409, { error: "status_conflict", message: ORDER_ERROR_MESSAGES_FORMAL.status_conflict, currentStatus: "ON_SALE" }]);
    expect((await patch({ price: 2500, expectedPrice: "abc" })).status).toBe(400);
    expect((await patch({ expectedStatus: "nope", status: "HIDDEN" })).status).toBe(400);
    expect((await patch({ price: 2600 })).status).toBe(200);
    expect((await row(s.productId)).price).toBe(2600);
    const event = { type: "RATE", value: 20, startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 3600_000).toISOString() };
    expect((await patch({ price: 2800, expectedPrice: 2600, event })).status).toBe(200);
    expect((await patch({ price: 3000, expectedPrice: 2800, event: { ...event, value: 91 } })).status).toBe(400);
    expect((await patch({ price: 3000, expectedPrice: 2600, event: null })).status).toBe(409);
    expect(await db.product.findUniqueOrThrow({ where: { id: s.productId } })).toMatchObject({ price: 2800, eventDiscountType: "RATE", eventDiscountValue: 20 });
    expect((await patch({ price: 3000, expectedPrice: 2800, event: null })).status).toBe(200);
    expect(await db.product.findUniqueOrThrow({ where: { id: s.productId } })).toMatchObject({ price: 3000, eventDiscountType: null, eventDiscountValue: null });
  });
});
