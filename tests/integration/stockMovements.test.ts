import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as adjustRoute } from "../../app/api/seller/products/[productId]/options/[optionId]/stock-adjust/route";
import { GET as movementsRoute } from "../../app/api/seller/products/stock-movements/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { ORDER_ERROR_MESSAGES } from "../../lib/server/orders/messages";
import { createProduct } from "../../lib/server/products/manage";
import { adjustStock } from "../../lib/server/products/stock";
import { cancelPendingOrder } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const addr = { recipientName: "김구매", phone: "01012345678", zipCode: "06236", address1: "서울 강남구 테헤란로 1" };

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  await db.sellerUser.update({ where: { id: owner.id }, data: { name: "김대표" } });
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const product = async (name: string, stock: number, mode: "ORDER" | "PAYMENT" = "ORDER") => {
    const r = await createProduct(db, ctx, { name, price: 1000, status: "ON_SALE", stockDeductMode: mode, options: [{ name: "기본", stock }] });
    if (!r.ok) throw new Error(r.reason);
    return { productId: r.value.id, optionId: r.value.options[0].id };
  };
  return { seller, owner, ctx, buyer, product, cookie: await cookieOf(owner.email) };
}

async function cookieOf(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}

const list = (cookie: string | undefined, q: Record<string, string> = {}) =>
  movementsRoute(new Request(`http://localhost:3000/api/seller/products/stock-movements?${new URLSearchParams(q)}`, { headers: { ...H, ...(cookie ? { cookie } : {}) } }));
const adjust = (cookie: string, productId: string, optionId: string, body: unknown) =>
  adjustRoute(new Request(`http://localhost:3000/api/seller/products/${productId}/options/${optionId}/stock-adjust`, { method: "POST", headers: { ...H, cookie }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ productId, optionId }),
  });

describe("재고 이력 조회", () => {
  it("최근순으로 증감·결과 재고·유형·사유·처리자(직원 이름·「구매자 주문」)·연결 주문을 주고 캐시하지 않는다", async () => {
    const s = await shop();
    const p = await s.product("부스터 팩", 5);
    const order = await createOrder(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id, items: [{ optionId: p.optionId, quantity: 2 }], consent, shippingAddress: addr });
    if (!order.ok) throw new Error(order.reason);
    const lv = (await db.seller.findUniqueOrThrow({ where: { id: s.seller.id } })).liveVersion;
    expect(await cancelPendingOrder(db, s.ctx, order.orderId, { reason: "구매자 요청", expectedLiveVersion: lv })).toMatchObject({ ok: true });
    expect((await adjust(s.cookie, p.productId, p.optionId, { delta: -1, reason: "이벤트 증정" })).status).toBe(200);

    const res = await list(s.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { movements, nextCursor } = await res.json();
    expect(nextCursor).toBeNull();
    expect(
      movements.map((m: { delta: number; stockAfter: number; typeLabel: string; note: string | null; actor: { name: string }; orderId: string | null }) => [
        m.delta,
        m.stockAfter,
        m.typeLabel,
        m.note,
        m.actor.name,
        m.orderId,
      ]),
    ).toEqual([
      [-1, 4, "직접 변경", "이벤트 증정", "김대표", null],
      [2, 5, "취소", null, "김대표", order.orderId],
      [-2, 3, "주문", null, "구매자 주문", order.orderId],
      [5, 5, "직접 변경", null, "김대표", null],
    ]);
    expect(movements[0]).toMatchObject({ productId: p.productId, productName: "부스터 팩", optionId: p.optionId, optionName: "기본", type: "MANUAL" });
  });

  it("상품·옵션으로 거르고, 다른 쇼핑몰·다른 상품의 옵션·잘못된 id는 404, 권한 없는 직원 403, 로그인 안 함 401", async () => {
    const s = await shop();
    const a = await s.product("A", 1);
    const b = await s.product("B", 2);
    const byProduct = await (await list(s.cookie, { productId: b.productId })).json();
    expect(byProduct.movements.map((m: { productName: string }) => m.productName)).toEqual(["B"]);
    const byOption = await (await list(s.cookie, { productId: a.productId, optionId: a.optionId })).json();
    expect(byOption.movements.map((m: { optionId: string }) => m.optionId)).toEqual([a.optionId]);

    const other = await shop();
    const theirs = await other.product("남의 상품", 3);
    const bad: Record<string, string>[] = [{ productId: theirs.productId }, { optionId: theirs.optionId }, { productId: a.productId, optionId: b.optionId }, { productId: "not-a-uuid" }];
    for (const q of bad) {
      expect((await list(s.cookie, q)).status).toBe(404);
    }
    // 다른 쇼핑몰 이력은 섞이지 않는다
    expect(JSON.stringify(await (await list(s.cookie)).json())).not.toContain(theirs.optionId);

    const noPerm = await createSellerUser(s.seller.id, { permissions: [] });
    expect((await list(await cookieOf(noPerm.email))).status).toBe(403);
    const productStaff = await createSellerUser(s.seller.id, { permissions: ["PRODUCT_MANAGE"] });
    expect((await list(await cookieOf(productStaff.email))).status).toBe(200);
    expect((await list(undefined)).status).toBe(401);
  });

  it("커서로 끝까지 넘기면 같은 시각의 이력도 빠짐·겹침 없이 모두 나오고, 잘못된 커서·한도 밖 limit은 400", async () => {
    const s = await shop();
    const p = await s.product("A", 0);
    const at = new Date("2026-10-01T00:00:00Z");
    await db.stockMovement.createMany({
      data: Array.from({ length: 7 }, (_, i) => ({ sellerId: s.seller.id, optionId: p.optionId, delta: i + 1, reason: "MANUAL" as const, actorType: "SYSTEM" as const, createdAt: i < 5 ? at : new Date(at.getTime() + i) })),
    });
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await list(s.cookie, { limit: "3", ...(cursor ? { cursor } : {}) });
      expect(r.status).toBe(200);
      const body: { movements: { delta: number; actor: { name: string } }[]; nextCursor: string | null } = await r.json();
      seen.push(...body.movements.map((m) => m.delta));
      cursor = body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen.slice(0, 2)).toEqual([7, 6]);
    expect([...seen].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const bad: Record<string, string>[] = [{ cursor: "garbage" }, { cursor: Buffer.from("2026-10-01T00:00:00.000Z|nope").toString("base64url") }, { limit: "0" }, { limit: "201" }, { limit: "abc" }];
    for (const q of bad) {
      const r = await list(s.cookie, q);
      expect(r.status).toBe(400);
    }
    expect(await (await list(s.cookie, { limit: "0" })).json()).toEqual({ error: "invalid_limit", message: ORDER_ERROR_MESSAGES.invalid_limit });
  });
});

describe("수동 증감 expectedStock(화면이 본 재고)", () => {
  it("화면이 본 재고와 같으면 사유와 함께 반영하고, 다르면 409 stock_conflict와 지금 재고를 주며 바꾸지 않는다. 형식이 틀리면 400", async () => {
    const s = await shop();
    const p = await s.product("A", 10);
    // 목표 재고 7로 맞추기 = delta(7 − 10)
    const ok = await adjust(s.cookie, p.productId, p.optionId, { delta: -3, reason: "실사 맞춤", expectedStock: 10 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ optionId: p.optionId, stock: 7 });
    const stale = await adjust(s.cookie, p.productId, p.optionId, { delta: 5, reason: "입고", expectedStock: 10 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "stock_conflict", message: ORDER_ERROR_MESSAGES.stock_conflict, currentStock: 7 });
    expect((await adjust(s.cookie, p.productId, p.optionId, { delta: 1, reason: "입고", expectedStock: "7" })).status).toBe(400);
    expect((await adjust(s.cookie, p.productId, p.optionId, { delta: 1, reason: "입고", expectedStock: -1 })).status).toBe(400);
    // 맞는 값이어도 모자라면 기존처럼 insufficient_stock
    expect((await (await adjust(s.cookie, p.productId, p.optionId, { delta: -8, reason: "폐기", expectedStock: 7 })).json()).error).toBe("insufficient_stock");
    expect((await db.productOption.findUniqueOrThrow({ where: { id: p.optionId } })).stock).toBe(7);
    const [latest] = (await (await list(s.cookie, { optionId: p.optionId })).json()).movements;
    expect(latest).toMatchObject({ delta: -3, stockAfter: 7, note: "실사 맞춤" });
  });

  it("[경합] 같은 화면 값으로 동시에 5번 보내면 한 번만 반영되고 나머지는 409(지금 재고 포함), 결제 차감과 겹쳐도 덮어쓰지 않는다", async () => {
    const s = await shop();
    const p = await s.product("A", 10);
    const rs = await Promise.all(Array.from({ length: 5 }, () => adjustStock(db, s.ctx, p.productId, p.optionId, { delta: 2, reason: "입고", expectedStock: 10 })));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.filter((r) => !r.ok)).toEqual(Array.from({ length: 4 }, () => ({ ok: false, reason: "stock_conflict", currentStock: 12 })));
    // 주문(ORDER 차감)으로 재고가 바뀐 뒤 옛 화면 값으로 보내면 거부
    const order = await createOrder(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id, items: [{ optionId: p.optionId, quantity: 1 }], consent, shippingAddress: addr });
    expect(order.ok).toBe(true);
    expect(await adjustStock(db, s.ctx, p.productId, p.optionId, { delta: -12, reason: "폐기", expectedStock: 12 })).toEqual({ ok: false, reason: "stock_conflict", currentStock: 11 });
    expect((await db.productOption.findUniqueOrThrow({ where: { id: p.optionId } })).stock).toBe(11);
    expect(await db.stockMovement.count({ where: { optionId: p.optionId } })).toBe(3);
  });
});
