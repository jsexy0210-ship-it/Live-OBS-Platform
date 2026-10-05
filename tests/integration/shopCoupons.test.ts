import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DELETE as couponDelete, PATCH as couponPatch, PUT as couponPut } from "../../app/api/seller/coupons/[couponId]/route";
import { POST as grantPost } from "../../app/api/seller/coupons/[couponId]/grant/route";
import { GET as productsGet } from "../../app/api/seller/coupons/products/route";
import { GET as couponsGet, POST as couponsPost } from "../../app/api/seller/coupons/route";
import { POST as downloadPost } from "../../app/api/shop/[slug]/coupons/[couponId]/download/route";
import { POST as codePost } from "../../app/api/shop/[slug]/coupons/code/route";
import { GET as boxGet } from "../../app/api/shop/[slug]/coupons/route";
import ShopCouponsPage from "../../app/(shop)/shop/[slug]/coupons/page";
import CouponBox from "../../components/shop/CouponBox";
import { GET as buyerOrderGet } from "../../app/api/shop/[slug]/orders/[orderId]/route";
import { POST as orderPost } from "../../app/api/shop/[slug]/orders/route";
import { loginBuyer, loginSeller } from "../../lib/server/auth/login";
import { withdrawBuyer } from "../../lib/server/buyers/withdraw";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { cancelOverdueOrders } from "../../lib/server/orders/overdue";
import { getOrder } from "../../lib/server/orders/read";
import { cancelPendingOrder, markOrderPaid, previewRefund, refundOrder } from "../../lib/server/queue/service";
import { parseStatsRange } from "../../lib/server/stats/range";
import { salesStats } from "../../lib/server/stats/sales";
import { CODE_ATTEMPT_LIMIT, buyerCouponBox } from "../../lib/server/shop-coupons/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// SA-035 쿠폰 관리 · SH-028 내 쿠폰함(2026-10-04 대표님 지시, 규칙 MASTER 2026-10-04):
// 권한·테넌트 격리·1인 1장·발급 한도(동시)·코드 입력·주문 할인(서버 계산, 같은 트랜잭션)·동시 사용 반례·전체 취소 복구·부분 환불 미복구·탈퇴·로그 추적.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const json = (path: string, method: string, cookie: string, body?: unknown) =>
  new Request(BASE + path, { method, headers: { ...H, "content-type": "application/json", cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const get = (path: string, cookie: string) => new Request(BASE + path, { headers: { ...H, cookie } });
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const shippingAddress = { recipientName: "김구매", phone: "010-1234-5678", zipCode: "06236", address1: "서울 강남구 테헤란로 1" };
const DAY = 86_400_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

async function sellerCookie(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}
async function buyerCookie(sellerId: string, loginId: string) {
  const r = await loginBuyer(db, { sellerId, loginId, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_buyer=${r.token}`;
}

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const pointsStaff = await createSellerUser(seller.id, { permissions: ["MEMBER_POINTS"] });
  const otherStaff = await createSellerUser(seller.id, { permissions: ["PRODUCT_MANAGE", "SHOP_SETTINGS"] });
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const buyer2 = await createLoginBuyer(seller.id, grade.id);
  const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 박스", price: 30000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1박스", stock: 50 } });
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return {
    seller,
    grade,
    buyer,
    buyer2,
    product,
    option,
    ctx,
    owner: await sellerCookie(owner.email),
    points: await sellerCookie(pointsStaff.email),
    noPerm: await sellerCookie(otherStaff.email),
    b1: await buyerCookie(seller.id, buyer.loginId!),
    b2: await buyerCookie(seller.id, buyer2.loginId!),
  };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const couponBody = (extra: Record<string, unknown> = {}) => ({
  name: "오픈 기념",
  issueMethod: "DOWNLOAD",
  benefit: "AMOUNT",
  value: 5000,
  startsAt: iso(-DAY),
  endsAt: iso(10 * DAY),
  ...extra,
});
async function makeCoupon(s: Shop, extra: Record<string, unknown> = {}, cookie = s.owner) {
  const res = await couponsPost(json("/api/seller/coupons", "POST", cookie, couponBody(extra)));
  const body = (await res.json()) as { coupon?: { id: string; status: string }; error?: string };
  return { res, body, id: body.coupon?.id ?? "" };
}
const download = (s: Shop, couponId: string, cookie = s.b1) => downloadPost(json(`/api/shop/${s.seller.slug}/coupons/${couponId}/download`, "POST", cookie, {}), p({ slug: s.seller.slug, couponId }));
const redeem = (s: Shop, code: string, cookie = s.b1) => codePost(json(`/api/shop/${s.seller.slug}/coupons/code`, "POST", cookie, { code }), p({ slug: s.seller.slug }));
const order = (s: Shop, couponId: string | undefined, quantity = 1, buyer = s.buyer) =>
  createOrder(db, { sellerId: s.seller.id, buyerMemberId: buyer.id, items: [{ optionId: s.option.id, quantity }], consent, shippingAddress, couponId });
const lv = async (sellerId: string) => (await db.seller.findUniqueOrThrow({ where: { id: sellerId } })).liveVersion;
const held = (s: Shop, couponId: string, buyerMemberId = s.buyer.id) => db.buyerCoupon.findFirstOrThrow({ where: { couponId, buyerMemberId } });


// 다른 트랜잭션이 행 잠금을 기다리기 시작할 때까지(최대 5초)
async function waitForLockWaiter() {
  for (let i = 0; i < 100; i++) {
    const [w] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (w.n > 0n) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("권한·테넌트 격리", () => {
  it("대표자·적립금 직원만 만들고, 다른 직원은 집계만 본다(canEdit=false, 403)", async () => {
    const s = await shop();
    expect((await makeCoupon(s)).res.status).toBe(201);
    expect((await makeCoupon(s, { name: "적립금 직원" }, s.points)).res.status).toBe(201);
    expect((await makeCoupon(s, { name: "막힘" }, s.noPerm)).res.status).toBe(403);
    const view = await couponsGet(get("/api/seller/coupons", s.noPerm));
    expect(view.status).toBe(200);
    const body = (await view.json()) as { coupons: unknown[]; canEdit: boolean };
    expect(body.coupons).toHaveLength(2);
    expect(body.canEdit).toBe(false);
    const id = (await db.coupon.findFirstOrThrow()).id;
    expect((await couponPatch(json("/x", "PATCH", s.noPerm, { isActive: false }), p({ couponId: id }))).status).toBe(403);
    expect((await grantPost(json("/x", "POST", s.noPerm, { gradeIds: [s.grade.id] }), p({ couponId: id }))).status).toBe(403);
  });

  it("다른 쇼핑몰의 쿠폰은 수정·중지·삭제·받기 모두 404이고 바뀌지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    const c = await makeCoupon(a);
    expect((await couponPut(json("/x", "PUT", b.owner, couponBody({ name: "탈취" })), p({ couponId: c.id }))).status).toBe(404);
    expect((await couponPatch(json("/x", "PATCH", b.owner, { isActive: false }), p({ couponId: c.id }))).status).toBe(404);
    expect((await couponDelete(json("/x", "DELETE", b.owner), p({ couponId: c.id }))).status).toBe(404);
    expect((await download(b, c.id)).status).toBe(404);
    const row = await db.coupon.findUniqueOrThrow({ where: { id: c.id } });
    expect([row.name, row.isActive, row.issuedCount]).toEqual(["오픈 기념", true, 0]);
    // 다른 쇼핑몰 상품은 적용 상품으로 고를 수 없다
    expect((await makeCoupon(a, { productIds: [b.product.id] })).body.error).toBe("invalid_products");
  });

  it("오버레이 전용 요금제는 관리 API 403, 잠긴 쇼핑몰은 쿠폰 받기 402", async () => {
    const s = await shop();
    const c = await makeCoupon(s);
    const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "OVERLAY_ONLY" } });
    await db.sellerSubscription.create({ data: { sellerId: s.seller.id, planId: plan.id, status: "ACTIVE" } });
    const list = await couponsGet(get("/api/seller/coupons", s.owner));
    expect(list.status).toBe(403);
    const dl = await download(s, c.id);
    expect(dl.status).toBe(402);
    expect(await db.buyerCoupon.count()).toBe(0);
  });
});

describe("적용 상품 고르기", () => {
  it("상품이 많아도 이름으로 찾고(지운 상품·다른 쇼핑몰 제외), 쿠폰 목록은 들어 있는 상품 이름을 준다(Codex 4176403245)", async () => {
    const s = await shop();
    const other = await shop();
    await db.product.createMany({ data: Array.from({ length: 600 }, (_, i) => ({ sellerId: s.seller.id, name: `일반 상품 ${i}`, price: 1000 })) });
    const old = await db.product.create({ data: { sellerId: s.seller.id, name: "오래된 한정판", price: 1000, createdAt: new Date("2020-01-01") } });
    await db.product.create({ data: { sellerId: s.seller.id, name: "지운 한정판", price: 1000, deletedAt: new Date() } });
    await db.product.create({ data: { sellerId: other.seller.id, name: "남의 한정판", price: 1000 } });
    const res = await productsGet(get("/api/seller/coupons/products?q=" + encodeURIComponent("한정판"), s.noPerm));
    expect(((await res.json()) as { products: { name: string }[] }).products.map((x) => x.name)).toEqual(["오래된 한정판"]);
    await makeCoupon(s, { productIds: [old.id] });
    const list = (await (await couponsGet(get("/api/seller/coupons", s.owner))).json()) as { products: { id: string; name: string }[] };
    expect(list.products).toEqual([{ id: old.id, name: "오래된 한정판", deleted: false }]);
  });
});

describe("만들기·수정·중지·삭제", () => {
  it("코드는 쇼핑몰 안에서 겹치지 않는다(대소문자 무시, DB 부분 유니크 인덱스도 막음)", async () => {
    const s = await shop();
    const other = await shop();
    expect((await makeCoupon(s, { issueMethod: "CODE", code: "STARNIGHT" })).res.status).toBe(201);
    const dup = await makeCoupon(s, { issueMethod: "CODE", code: "starnight" });
    expect(dup.res.status).toBe(409);
    expect(dup.body.error).toBe("code_taken");
    expect((await makeCoupon(other, { issueMethod: "CODE", code: "STARNIGHT" })).res.status).toBe(201);
    const first = await db.coupon.findFirstOrThrow({ where: { sellerId: s.seller.id } });
    const { id: _id, createdAt: _c, updatedAt: _u, ...copy } = first;
    await expect(db.coupon.create({ data: copy })).rejects.toThrow();
  });

  it("발급한 쿠폰은 혜택을 못 바꾸고, 한도를 발급 수 아래로 못 줄이며, 종료를 앞당기면 받은 쿠폰 만료도 맞춘다", async () => {
    const s = await shop();
    const c = await makeCoupon(s, { issueLimit: 10 });
    expect((await download(s, c.id)).status).toBe(201);
    expect((await download(s, c.id, s.b2)).status).toBe(201);
    const locked = await couponPut(json("/x", "PUT", s.owner, couponBody({ value: 9000, issueLimit: 10 })), p({ couponId: c.id }));
    expect(locked.status).toBe(409);
    const low = await couponPut(json("/x", "PUT", s.owner, couponBody({ issueLimit: 1 })), p({ couponId: c.id }));
    expect(((await low.json()) as { error: string }).error).toBe("issue_limit_below_issued");
    const sooner = iso(2 * DAY);
    const ok = await couponPut(json("/x", "PUT", s.owner, couponBody({ name: "이름만 바꿈", endsAt: sooner, issueLimit: 10 })), p({ couponId: c.id }));
    expect(ok.status).toBe(200);
    expect((await held(s, c.id)).expiresAt.getTime()).toBe(new Date(sooner).getTime());
  });

  it("쓰지 않은 받은 쿠폰의 받은 시각보다 이른 종료는 409로 거절하고 아무것도 바꾸지 않는다(Codex 4176358407)", async () => {
    const s = await shop();
    const c = await makeCoupon(s);
    expect((await download(s, c.id)).status).toBe(201);
    const before = await held(s, c.id);
    const res = await couponPut(json("/x", "PUT", s.owner, couponBody({ name: "바뀌면 안 됨", startsAt: iso(-3 * DAY), endsAt: iso(-2 * DAY) })), p({ couponId: c.id }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "ends_before_issued", message: expect.stringContaining("해 주십시오") });
    expect((await db.coupon.findUniqueOrThrow({ where: { id: c.id } })).name).toBe("오픈 기념");
    expect((await held(s, c.id)).expiresAt).toEqual(before.expiresAt);
    // 받은 시각 뒤로 앞당기는 것은 된다
    expect((await couponPut(json("/x", "PUT", s.owner, couponBody({ endsAt: iso(DAY) })), p({ couponId: c.id }))).status).toBe(200);
  });

  it("발급이 진행 중이면 혜택 변경은 쿠폰 행 잠금을 기다렸다가 거절된다(Codex 4176380506)", async () => {
    const s = await shop();
    const c = await makeCoupon(s);
    let put: Promise<Response> | null = null;
    // 받기 트랜잭션처럼 쿠폰 행을 먼저 잠그고, 혜택 변경 요청이 기다리기 시작한 뒤에 발급을 쓴다
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Coupon" WHERE "id" = ${c.id}::uuid FOR UPDATE`;
      put = couponPut(json("/x", "PUT", s.owner, couponBody({ value: 9000 })), p({ couponId: c.id }));
      // 혜택 변경 요청이 이 잠금을 기다리기 시작할 때까지(최대 5초) 커밋하지 않는다
      for (let i = 0; i < 100; i++) {
        const [w] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (w.n > 0n) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await tx.coupon.update({ where: { id: c.id }, data: { issuedCount: { increment: 1 } } });
      await tx.buyerCoupon.create({ data: { sellerId: s.seller.id, couponId: c.id, buyerMemberId: s.buyer.id, issuedAt: new Date(), expiresAt: new Date(Date.now() + DAY) } });
    });
    const res = await put!;
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("method_locked");
    expect((await db.coupon.findUniqueOrThrow({ where: { id: c.id } })).value).toBe(5000);
  });

  it("종료를 앞당기면 쓴 쿠폰 만료도 줄어, 주문 취소로 되돌아와도 새 종료 뒤에는 쓸 수 없다(Codex 4176380507)", async () => {
    const s = await shop();
    const c = await makeCoupon(s);
    await download(s, c.id);
    const o = await order(s, c.id);
    if (!o.ok) throw new Error(o.reason);
    const soon = iso(1500);
    expect((await couponPut(json("/x", "PUT", s.owner, couponBody({ endsAt: soon })), p({ couponId: c.id }))).status).toBe(200);
    expect((await held(s, c.id)).expiresAt.getTime()).toBe(new Date(soon).getTime());
    expect((await cancelPendingOrder(db, s.ctx, o.orderId, { reason: "요청", expectedLiveVersion: await lv(s.seller.id) })).ok).toBe(true);
    expect((await held(s, c.id)).status).toBe("ISSUED");
    await new Promise((r) => setTimeout(r, 1700));
    expect(await order(s, c.id)).toEqual({ ok: false, reason: "coupon_unavailable" });
  });

  it("발급 중지하면 더는 받을 수 없지만 받은 쿠폰은 쓸 수 있다. 발급한 쿠폰은 지울 수 없다", async () => {
    const s = await shop();
    const c = await makeCoupon(s);
    expect((await download(s, c.id)).status).toBe(201);
    expect((await couponPatch(json("/x", "PATCH", s.owner, { isActive: false }), p({ couponId: c.id }))).status).toBe(200);
    expect((await download(s, c.id, s.b2)).status).toBe(404);
    expect((await order(s, c.id)).ok).toBe(true);
    expect((await couponDelete(json("/x", "DELETE", s.owner), p({ couponId: c.id }))).status).toBe(409);
    const unused = await makeCoupon(s, { name: "안 쓴 쿠폰" });
    expect((await couponDelete(json("/x", "DELETE", s.owner), p({ couponId: unused.id }))).status).toBe(200);
    const actions = (await db.auditLog.findMany({ where: { sellerId: s.seller.id, action: { startsWith: "coupon." } }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(["coupon.create", "coupon.stop", "coupon.create", "coupon.delete"]);
  });
});

describe("경쟁(쿠폰 행·회원 행 잠금)", () => {
  it("발급이 진행 중일 때 삭제는 잠금을 기다렸다가 has_history(409)로 거절된다(Codex 4176403244)", async () => {
    const s = await shop();
    const c = await makeCoupon(s);
    let del: Promise<Response> | null = null;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Coupon" WHERE "id" = ${c.id}::uuid FOR UPDATE`;
      del = couponDelete(json("/x", "DELETE", s.owner), p({ couponId: c.id }));
      await waitForLockWaiter();
      await tx.coupon.update({ where: { id: c.id }, data: { issuedCount: { increment: 1 } } });
      await tx.buyerCoupon.create({ data: { sellerId: s.seller.id, couponId: c.id, buyerMemberId: s.buyer.id, issuedAt: new Date(), expiresAt: new Date(Date.now() + DAY) } });
    });
    const res = await del!;
    expect(res.status).toBe(409);
    expect(await db.coupon.count({ where: { id: c.id } })).toBe(1);
  });

  it("받기 대기 중 발급 방식이 직접 지급으로 바뀌거나 코드가 바뀌면 잠긴 쿠폰 기준으로 거절한다(Codex 4176525927)", async () => {
    const s = await shop();
    const dl = await makeCoupon(s);
    let res: Promise<Response> | null = null;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Coupon" WHERE "id" = ${dl.id}::uuid FOR UPDATE`;
      res = download(s, dl.id);
      await waitForLockWaiter();
      await tx.coupon.update({ where: { id: dl.id }, data: { issueMethod: "MANUAL" } });
    });
    expect((await res!).status).toBe(404);
    const code = await makeCoupon(s, { issueMethod: "CODE", code: "OLDCODE1" });
    let r2: Promise<Response> | null = null;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Coupon" WHERE "id" = ${code.id}::uuid FOR UPDATE`;
      r2 = redeem(s, "OLDCODE1");
      await waitForLockWaiter();
      await tx.coupon.update({ where: { id: code.id }, data: { code: "NEWCODE1" } });
    });
    expect((await r2!).status).toBe(404);
    expect(await db.buyerCoupon.count()).toBe(0);
    expect(await db.coupon.count({ where: { issuedCount: { gt: 0 } } })).toBe(0);
  });

  it("종료 직전에 받기를 시작해 잠금을 기다리는 사이 종료가 지나면 잠금 뒤 시각으로 보고 거절한다(Codex 4176525932)", async () => {
    const s = await shop();
    const c = await makeCoupon(s);
    let res: Promise<Response> | null = null;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Coupon" WHERE "id" = ${c.id}::uuid FOR UPDATE`;
      await tx.coupon.update({ where: { id: c.id }, data: { endsAt: new Date(Date.now() + 1500) } });
      res = download(s, c.id);
      await waitForLockWaiter();
      // 받기 요청이 잠금을 기다리는 동안 종료 시각이 지나게 한다
      await new Promise((r) => setTimeout(r, 1800));
    });
    expect((await res!).status).toBe(404);
    expect(await db.buyerCoupon.count()).toBe(0);
  });

  it("직접 지급과 탈퇴가 겹치면 탈퇴한 회원에게는 지급하지 않는다(Codex 4176403243)", async () => {
    const s = await shop();
    const c = await makeCoupon(s, { issueMethod: "MANUAL" });
    let grant: Promise<Response> | null = null;
    await db.$transaction(async (tx) => {
      // 탈퇴처럼 회원 행을 FOR UPDATE로 잠그고 상태를 바꾼다
      await tx.$queryRaw`SELECT 1 FROM "BuyerMember" WHERE "id" = ${s.buyer.id}::uuid FOR UPDATE`;
      grant = grantPost(json("/x", "POST", s.owner, { gradeIds: [s.grade.id] }), p({ couponId: c.id }));
      await waitForLockWaiter();
      await tx.buyerMember.update({ where: { id: s.buyer.id }, data: { status: "WITHDRAWN", deletedAt: new Date() } });
    });
    expect(await (await grant!).json()).toEqual({ ok: true, granted: 1, skipped: 0 });
    expect(await db.buyerCoupon.count({ where: { couponId: c.id, buyerMemberId: s.buyer.id } })).toBe(0);
    expect((await db.coupon.findUniqueOrThrow({ where: { id: c.id } })).issuedCount).toBe(1);
  });
});

describe("받기(내려받기·코드)", () => {
  it("1인 1장: 같은 회원이 동시에 두 번 받아도 한 장만, 발급 수도 1", async () => {
    const s = await shop();
    const c = await makeCoupon(s);
    const rs = await Promise.all([download(s, c.id), download(s, c.id)]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await db.buyerCoupon.count({ where: { couponId: c.id } })).toBe(1);
    expect((await db.coupon.findUniqueOrThrow({ where: { id: c.id } })).issuedCount).toBe(1);
  });

  it("발급 한도: 두 회원이 동시에 마지막 1장을 받으면 한 명만 받는다(준비한 수량이 끝났어요)", async () => {
    const s = await shop();
    const c = await makeCoupon(s, { issueLimit: 1 });
    const rs = await Promise.all([download(s, c.id), download(s, c.id, s.b2)]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    const lost = rs.find((r) => r.status === 409)!;
    expect(((await lost.json()) as { message: string }).message).toBe("준비한 수량이 끝났어요");
    expect((await db.coupon.findUniqueOrThrow({ where: { id: c.id } })).issuedCount).toBe(1);
    expect(await db.buyerCoupon.count()).toBe(1);
  });

  it("예약(시작 전)·직접 지급·코드 쿠폰은 내려받을 수 없다", async () => {
    const s = await shop();
    const later = await makeCoupon(s, { startsAt: iso(DAY), endsAt: iso(2 * DAY) });
    expect(later.body.coupon!.status).toBe("scheduled");
    const manual = await makeCoupon(s, { issueMethod: "MANUAL" });
    const code = await makeCoupon(s, { issueMethod: "CODE", code: "LIVE2026" });
    for (const id of [later.id, manual.id, code.id]) expect((await download(s, id)).status).toBe(404);
  });

  it("코드는 대소문자 없이 받고, 틀린 코드는 로그 추적에 남기며 10분에 10번 넘게 틀리면 막는다", async () => {
    const s = await shop();
    await makeCoupon(s, { issueMethod: "CODE", code: "LIVE2026" });
    const ok = await redeem(s, " live2026 ");
    expect(ok.status).toBe(201);
    const again = await redeem(s, "LIVE2026");
    expect(((await again.json()) as { message: string }).message).toBe("이미 등록한 코드예요. 쿠폰함에서 확인해 보세요");
    for (let i = 0; i < CODE_ATTEMPT_LIMIT; i++) expect((await redeem(s, `WRONG${i}`, s.b2)).status).toBe(404);
    expect((await redeem(s, "LIVE2026", s.b2)).status).toBe(429);
    expect(await db.auditLog.count({ where: { action: "buyer_coupon.code_failed", actorId: s.buyer2.id } })).toBe(CODE_ATTEMPT_LIMIT);
    // 거래 무관 행동이라 3개월 보관 기한이 붙는다
    const row = await db.auditLog.findFirstOrThrow({ where: { action: "buyer_coupon.code", actorId: s.buyer.id } });
    expect(row.retainUntil).not.toBeNull();
  });

  it("틀린 코드를 동시에 많이 넣어도 10분 10회 한도를 넘지 않고, 한도에 걸린 뒤에는 맞는 코드도 막힌다(Codex 4176358406)", async () => {
    const s = await shop();
    await makeCoupon(s, { issueMethod: "CODE", code: "LIVE2026" });
    const rs = await Promise.all(Array.from({ length: CODE_ATTEMPT_LIMIT + 10 }, (_, i) => redeem(s, `WRONG${i}`)));
    expect(rs.filter((r) => r.status === 404)).toHaveLength(CODE_ATTEMPT_LIMIT);
    expect(rs.filter((r) => r.status === 429)).toHaveLength(10);
    expect(await db.auditLog.count({ where: { action: "buyer_coupon.code_failed", actorId: s.buyer.id } })).toBe(CODE_ATTEMPT_LIMIT);
    expect((await redeem(s, "LIVE2026")).status).toBe(429);
    expect(await db.buyerCoupon.count()).toBe(0);
    // 다른 회원은 영향 없음
    expect((await redeem(s, "LIVE2026", s.b2)).status).toBe(201);
  });

  it("받을 수 있는 쿠폰은 소진·이미 받음을 DB에서 먼저 거른 뒤 개수를 자르고, 더 있으면 알려 준다(Codex 4176380511)", async () => {
    const s = await shop();
    // 곧 끝나는(목록 앞자리) 소진 쿠폰 3개 + 받을 수 있는 쿠폰 3개
    for (let i = 0; i < 3; i++) {
      const sold = await makeCoupon(s, { name: `소진 ${i}`, issueLimit: 1, endsAt: iso((i + 1) * 3600_000) });
      expect((await download(s, sold.id, s.b2)).status).toBe(201);
    }
    for (let i = 0; i < 3; i++) await makeCoupon(s, { name: `받을 ${i}`, endsAt: iso((i + 2) * DAY) });
    const two = await buyerCouponBox(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id }, 2);
    expect(two.claimable.map((c) => c.name)).toEqual(["받을 0", "받을 1"]);
    expect(two.claimableMore).toBe(true);
    const all = await buyerCouponBox(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id }, 50);
    expect(all.claimable.map((c) => c.name)).toEqual(["받을 0", "받을 1", "받을 2"]);
    expect(all.claimableMore).toBe(false);
  });

  it("이용이 막힌 쇼핑몰에서도 내 쿠폰함은 받은 쿠폰을 읽기 전용으로 보여 주고, 화면도 쿠폰함을 그린다(Codex 4176525935)", async () => {
    const s = await shop();
    const c = await makeCoupon(s);
    await makeCoupon(s, { name: "받을 쿠폰" });
    await download(s, c.id);
    await db.seller.update({ where: { id: s.seller.id }, data: { trialEndsAt: new Date(Date.now() - DAY) } });
    const res = await boxGet(get(`/api/shop/${s.seller.slug}/coupons`, s.b1), p({ slug: s.seller.slug }));
    const box = (await res.json()) as { usable: { name: string }[]; claimable: unknown[]; shopOpen: boolean };
    expect(box.shopOpen).toBe(false);
    expect(box.usable.map((x) => x.name)).toEqual(["오픈 기념"]);
    expect(box.claimable).toEqual([]);
    const page = (await ShopCouponsPage({ params: Promise.resolve({ slug: s.seller.slug }) })) as unknown as { props: { children: { type: unknown } } };
    expect(page.props.children.type).toBe(CouponBox);
  });

  it("내 쿠폰함: 쓸 수 있어요 · 받을 수 있어요 · 지난 쿠폰", async () => {
    const s = await shop();
    const a = await makeCoupon(s, { name: "받은 쿠폰" });
    await makeCoupon(s, { name: "받을 쿠폰" });
    const sold = await makeCoupon(s, { name: "소진 쿠폰", issueLimit: 1 });
    expect((await download(s, a.id)).status).toBe(201);
    expect((await download(s, sold.id, s.b2)).status).toBe(201);
    await db.buyerCoupon.updateMany({ where: { couponId: a.id }, data: { expiresAt: new Date(Date.now() - 1000), issuedAt: new Date(Date.now() - 2000) } });
    const res = await boxGet(get(`/api/shop/${s.seller.slug}/coupons`, s.b1), p({ slug: s.seller.slug }));
    const box = (await res.json()) as { usable: { name: string }[]; claimable: { name: string }[]; past: { name: string; state: string }[] };
    expect(box.usable).toEqual([]);
    expect(box.claimable.map((c) => c.name)).toEqual(["받을 쿠폰"]);
    expect(box.past.map((c) => [c.name, c.state])).toEqual([["받은 쿠폰", "expired"]]);
  });
});

describe("주문 할인(서버 계산, 주문 생성과 같은 트랜잭션)", () => {
  it("할인 금액만큼 결제 금액이 줄고 쿠폰은 사용됨으로 바뀐다. 화면이 보낸 금액은 쓰지 않는다", async () => {
    const s = await shop();
    const c = await makeCoupon(s, { benefit: "RATE", value: 10, maxDiscount: 4000, minOrderAmount: 30000 });
    await download(s, c.id);
    const res = await orderPost(
      json(`/api/shop/${s.seller.slug}/orders`, "POST", s.b1, { items: [{ optionId: s.option.id, quantity: 2 }], consent, shippingAddress, couponId: c.id, discountAmount: 60000, totalAmount: 1 }),
      p({ slug: s.seller.slug }),
    );
    expect(res.status).toBe(200);
    const r = (await res.json()) as { orderId: string; totalAmount: number; shippingFee: number };
    // 30,000 × 2 = 60,000의 10% = 6,000 → 최대 4,000
    expect(r.totalAmount).toBe(60000 + r.shippingFee - 4000);
    const red = await db.couponRedemption.findUniqueOrThrow({ where: { orderId: r.orderId } });
    expect([red.discountAmount, red.benefit, red.restoredAt]).toEqual([4000, "RATE", null]);
    const bc = await held(s, c.id);
    expect([bc.status, bc.usedAt]).toEqual(["USED", expect.any(Date)]);
    // 구매자·판매자 주문 상세에 쿠폰 할인이 보인다
    const detail = (await (await buyerOrderGet(get(`/x`, s.b1), p({ slug: s.seller.slug, orderId: r.orderId }))).json()) as { couponRedemption: { discountAmount: number; coupon: { name: string } } };
    expect(detail.couponRedemption).toMatchObject({ discountAmount: 4000, coupon: { name: "오픈 기념" } });
    expect((await getOrder(db, s.ctx, r.orderId)).couponRedemption).toMatchObject({ discountAmount: 4000, coupon: { name: "오픈 기념" } });
    // 같은 쿠폰은 두 번 쓸 수 없다(409)
    const again = await orderPost(json(`/api/shop/${s.seller.slug}/orders`, "POST", s.b1, { items: [{ optionId: s.option.id, quantity: 1 }], consent, shippingAddress, couponId: c.id }), p({ slug: s.seller.slug }));
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe("coupon_unavailable");
    expect(await db.auditLog.count({ where: { action: "order.coupon.use", targetId: r.orderId } })).toBe(1);
  });

  it("동시 사용 반례: 같은 쿠폰으로 주문 두 개를 동시에 만들면 하나만 생기고 할인도 한 번만", async () => {
    const s = await shop();
    const c = await makeCoupon(s);
    await download(s, c.id);
    const rs = await Promise.all([order(s, c.id), order(s, c.id), order(s, c.id)]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.filter((r) => !r.ok).map((r) => !r.ok && r.reason)).toEqual(["coupon_unavailable", "coupon_unavailable"]);
    expect(await db.order.count({ where: { sellerId: s.seller.id } })).toBe(1);
    expect(await db.couponRedemption.count()).toBe(1);
    // 진 주문은 재고도 그대로(트랜잭션 전체가 되돌아감)
    expect(await db.orderItem.count()).toBe(1);
  });

  it("남의 쿠폰·받지 않은 쿠폰·시작 전·만료·최소 주문 미달·적용 상품 없음은 주문을 만들지 않고 쿠폰도 그대로", async () => {
    const s = await shop();
    const c = await makeCoupon(s, { minOrderAmount: 50000 });
    await download(s, c.id, s.b2);
    expect(await order(s, c.id)).toEqual({ ok: false, reason: "coupon_unavailable" });
    expect(await order(s, "not-a-uuid")).toEqual({ ok: false, reason: "coupon_unavailable" });
    await download(s, c.id);
    expect(await order(s, c.id, 1)).toEqual({ ok: false, reason: "coupon_min_order" });
    const other = await db.product.create({ data: { sellerId: s.seller.id, name: "다른 상품", price: 1000, status: "ON_SALE" } });
    const scoped = await makeCoupon(s, { name: "다른 상품만", productIds: [other.id] });
    await download(s, scoped.id);
    expect(await order(s, scoped.id)).toEqual({ ok: false, reason: "coupon_not_applicable" });
    await db.buyerCoupon.updateMany({ where: { couponId: c.id, buyerMemberId: s.buyer.id }, data: { expiresAt: new Date(Date.now() - 1000), issuedAt: new Date(Date.now() - 2000) } });
    expect(await order(s, c.id, 2)).toEqual({ ok: false, reason: "coupon_unavailable" });
    expect(await db.order.count()).toBe(0);
    expect(await db.buyerCoupon.count({ where: { status: "USED" } })).toBe(0);
  });

  it("배송비 무료 쿠폰 주문을 발송 뒤 구매자 사정으로 환불하면 반품 배송비를 왕복으로 뺀다(Codex 4176403242)", async () => {
    const s = await shop();
    const c = await makeCoupon(s, { benefit: "FREE_SHIPPING", value: null });
    await download(s, c.id);
    const o = await order(s, c.id);
    if (!o.ok) throw new Error(o.reason);
    expect((await markOrderPaid(db, { sellerId: s.seller.id, orderId: o.orderId, paymentMethod: "CARD" })).ok).toBe(true);
    await db.shipment.create({ data: { sellerId: s.seller.id, orderId: o.orderId, courier: "CJ", trackingNumber: "123456789012", shippedAt: new Date() } });
    // 환불 미리보기도 실제로 낸 배송비(0원)를 준다(화면 공제 항목, Codex 4176463862)
    expect((await previewRefund(db, s.ctx, o.orderId))?.chargedShippingFee).toBe(0);
    const r = await refundOrder(db, s.ctx, o.orderId, { reason: "단순 변심", expectedLiveVersion: await lv(s.seller.id), fault: "BUYER" });
    // 기본 반품 배송비 3,000원 × 2(왕복), 상품 30,000원
    expect(r.ok && [r.value.returnFeeDeducted, r.value.refundAmount]).toEqual([6000, 24000]);
  });

  it("배송비 무료 쿠폰은 배송비(shippingFee)를 남기고 그만큼 할인한다", async () => {
    const s = await shop();
    await db.sellerShippingPolicy.create({ data: { sellerId: s.seller.id, baseFee: 3500 } });
    const c = await makeCoupon(s, { benefit: "FREE_SHIPPING", value: null });
    await download(s, c.id);
    const r = await order(s, c.id);
    expect(r.ok && [r.totalAmount, r.shippingFee]).toEqual([30000, 3500]);
  });
});

describe("품목별 할인 배분·적립 기준·0원 거절(MASTER 2026-10-04 보수적 기본값)", () => {
  async function twoItems(s: Shop) {
    const make = async (name: string) => {
      const product = await db.product.create({ data: { sellerId: s.seller.id, name, price: 10000, status: "ON_SALE" } });
      return db.productOption.create({ data: { sellerId: s.seller.id, productId: product.id, name: "1개", stock: 10 } });
    };
    return [await make("상품 A"), await make("상품 B")];
  }

  it("1만원 × 2, 쿠폰 1만원, 1개 개봉 뒤 구매자 사정 환불 → 5천원만 돌려주고 쿠폰은 복원하지 않는다(Codex 4176403238)", async () => {
    const s = await shop();
    // 배송비·반품 배송비 0원(배분만 보이게)
    await db.sellerShippingPolicy.create({ data: { sellerId: s.seller.id, baseFee: 0, returnFee: 0 } });
    const [a, b] = await twoItems(s);
    const c = await makeCoupon(s, { value: 10000 });
    await download(s, c.id);
    const o = await createOrder(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id, items: [{ optionId: a.id, quantity: 1 }, { optionId: b.id, quantity: 1 }], consent, shippingAddress, couponId: c.id });
    if (!o.ok) throw new Error(o.reason);
    expect(o.totalAmount).toBe(10000);
    const red = await db.couponRedemption.findUniqueOrThrow({ where: { orderId: o.orderId } });
    expect(red.itemDiscounts).toEqual({ [a.id]: 5000, [b.id]: 5000 });
    expect((await markOrderPaid(db, { sellerId: s.seller.id, orderId: o.orderId, paymentMethod: "CARD" })).ok).toBe(true);
    const itemA = await db.orderItem.findFirstOrThrow({ where: { orderId: o.orderId, optionId: a.id } });
    await db.queueItem.updateMany({ where: { orderItemId: itemA.id }, data: { openingStartedAt: new Date(), status: "DONE" } });
    await db.shipment.create({ data: { sellerId: s.seller.id, orderId: o.orderId, courier: "CJ", trackingNumber: "123456789012", shippedAt: new Date() } });
    const preview = await previewRefund(db, s.ctx, o.orderId);
    expect(preview?.byFault.BUYER.refundAmount).toBe(5000);
    expect(preview?.openedItems.map((x) => x.amount)).toEqual([5000]);
    const r = await refundOrder(db, s.ctx, o.orderId, { reason: "단순 변심", expectedLiveVersion: await lv(s.seller.id), fault: "BUYER", confirmOpened: true });
    expect(r.ok && r.value.refundAmount).toBe(5000);
    expect((await held(s, c.id)).status).toBe("USED");
  });

  it("원 단위 끝수는 마지막 품목에 몰고, 배분 합계는 할인 금액과 같다", async () => {
    const s = await shop();
    const [a, b] = await twoItems(s);
    await db.productOption.update({ where: { id: b.id }, data: { priceDelta: 3333 } });
    const c = await makeCoupon(s, { benefit: "RATE", value: 7 });
    await download(s, c.id);
    const o = await createOrder(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id, items: [{ optionId: a.id, quantity: 1 }, { optionId: b.id, quantity: 1 }], consent, shippingAddress, couponId: c.id });
    if (!o.ok) throw new Error(o.reason);
    const red = await db.couponRedemption.findUniqueOrThrow({ where: { orderId: o.orderId } });
    // 23,333원 × 7% = 1,633원 → A 10,000원 몫 floor(1633 × 10000 / 23333) = 699원, 나머지 934원은 B
    expect(red.discountAmount).toBe(1633);
    expect(red.itemDiscounts).toEqual({ [a.id]: 699, [b.id]: 934 });
  });

  it("적립 기준은 쿠폰 할인 뒤 상품 금액이다", async () => {
    const s = await shop();
    await db.rewardPolicy.create({ data: { sellerId: s.seller.id, rates: { [s.grade.id]: { card: 10 } }, earnTiming: "ON_PAYMENT" } });
    const c = await makeCoupon(s);
    await download(s, c.id);
    const o = await order(s, c.id);
    if (!o.ok) throw new Error(o.reason);
    expect((await markOrderPaid(db, { sellerId: s.seller.id, orderId: o.orderId, paymentMethod: "CARD" })).ok).toBe(true);
    // (30,000 − 5,000) × 10%
    expect((await db.order.findUniqueOrThrow({ where: { id: o.orderId } })).rewardEarnAmount).toBe(2500);
  });

  it("결제 금액이 0원이 되는 쿠폰은 409로 거절하고(해요체) 주문을 만들지 않는다", async () => {
    const s = await shop();
    await db.sellerShippingPolicy.create({ data: { sellerId: s.seller.id, baseFee: 0 } });
    const c = await makeCoupon(s, { value: 30000 });
    await download(s, c.id);
    const res = await orderPost(json(`/api/shop/${s.seller.slug}/orders`, "POST", s.b1, { items: [{ optionId: s.option.id, quantity: 1 }], consent, shippingAddress, couponId: c.id }), p({ slug: s.seller.slug }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "coupon_zero_total", message: "이 주문에는 쿠폰을 쓸 수 없어요. 결제 금액이 0원이 돼요" });
    expect(await db.order.count()).toBe(0);
    expect((await held(s, c.id)).status).toBe("ISSUED");
  });

  it("주문 견적도 쿠폰 행 잠금을 기다렸다가 바뀐 종료로 검사한다(Codex 4176463858)", async () => {
    const s = await shop();
    const c = await makeCoupon(s);
    await download(s, c.id);
    let pending: ReturnType<typeof order> | null = null;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Coupon" WHERE "id" = ${c.id}::uuid FOR UPDATE`;
      pending = order(s, c.id);
      await waitForLockWaiter();
      await tx.coupon.update({ where: { id: c.id }, data: { endsAt: new Date(Date.now() - 1000) } });
    });
    expect(await pending!).toEqual({ ok: false, reason: "coupon_unavailable" });
    expect(await db.order.count()).toBe(0);
  });

  it("매출 통계에 쿠폰 할인 줄이 있고 판매액 − 할인 − 쿠폰 할인 − 적립금 + 배송비 = 결제액(Codex 4176463853)", async () => {
    const s = await shop();
    const c = await makeCoupon(s);
    await download(s, c.id);
    const o = await order(s, c.id);
    if (!o.ok) throw new Error(o.reason);
    expect((await markOrderPaid(db, { sellerId: s.seller.id, orderId: o.orderId, paymentMethod: "CARD" })).ok).toBe(true);
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date());
    const st = await salesStats(db, s.ctx, parseStatsRange({ from: today, to: today })!);
    expect(st.current.couponDiscount).toBe(5000);
    expect(st.current.gross - st.current.discount - st.current.couponDiscount - st.current.rewardUsed + st.current.shippingFee).toBe(st.current.paid);
  });
});

describe("취소·환불·탈퇴", () => {
  it("결제 대기 취소(판매자)·입금 기한 자동 취소는 쿠폰을 되돌리고, 되돌린 쿠폰은 다시 쓸 수 있다", async () => {
    const s = await shop();
    const c = await makeCoupon(s);
    await download(s, c.id);
    const first = await order(s, c.id);
    if (!first.ok) throw new Error(first.reason);
    expect((await cancelPendingOrder(db, s.ctx, first.orderId, { reason: "구매자 요청", expectedLiveVersion: await lv(s.seller.id) })).ok).toBe(true);
    expect((await held(s, c.id)).status).toBe("ISSUED");
    expect((await db.couponRedemption.findUniqueOrThrow({ where: { orderId: first.orderId } })).restoredAt).not.toBeNull();
    const second = await order(s, c.id);
    if (!second.ok) throw new Error(second.reason);
    await db.order.update({ where: { id: second.orderId }, data: { paymentDueAt: new Date(Date.now() - 60_000) } });
    expect((await cancelOverdueOrders(db)).cancelled).toContain(second.orderId);
    expect((await held(s, c.id)).status).toBe("ISSUED");
    expect(await db.auditLog.count({ where: { action: "order.coupon.restore" } })).toBe(2);
  });

  it("전액 환불이면 쿠폰을 되돌리고, 일부만 돌려주는 환불이면 되돌리지 않는다", async () => {
    const s = await shop();
    const full = await makeCoupon(s, { name: "전액" });
    const part = await makeCoupon(s, { name: "부분" });
    await download(s, full.id);
    await download(s, part.id);
    const a = await order(s, full.id);
    const b = await order(s, part.id);
    if (!a.ok || !b.ok) throw new Error("order");
    for (const id of [a.orderId, b.orderId]) expect((await markOrderPaid(db, { sellerId: s.seller.id, orderId: id, paymentMethod: "CARD" })).ok).toBe(true);
    const ra = await refundOrder(db, s.ctx, a.orderId, { reason: "요청", expectedLiveVersion: await lv(s.seller.id) });
    expect(ra.ok && ra.value.refundAmount).toBe(a.totalAmount);
    expect((await held(s, full.id)).status).toBe("ISSUED");
    // 발송 뒤 구매자 사정 환불: 처음 배송비·반품 배송비를 빼고 돌려주므로 일부 환불
    await db.shipment.create({ data: { sellerId: s.seller.id, orderId: b.orderId, courier: "CJ", trackingNumber: "123456789012", shippedAt: new Date() } });
    const rb = await refundOrder(db, s.ctx, b.orderId, { reason: "단순 변심", expectedLiveVersion: await lv(s.seller.id), fault: "BUYER" });
    expect(rb.ok && rb.value.refundAmount).toBeLessThan(b.totalAmount);
    expect((await held(s, part.id)).status).toBe("USED");
  });

  it("탈퇴: 쓰지 않은 쿠폰은 지우고, 결제 대기 주문을 취소해 되돌린 쿠폰은 주문 기록과 함께 남긴다", async () => {
    const s = await shop();
    const unused = await makeCoupon(s, { name: "안 씀" });
    const used = await makeCoupon(s, { name: "씀" });
    await download(s, unused.id);
    await download(s, used.id);
    const o = await order(s, used.id);
    if (!o.ok) throw new Error(o.reason);
    expect(await withdrawBuyer(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id }, { password: PASSWORD })).toEqual({ ok: true });
    const left = await db.buyerCoupon.findMany({ where: { buyerMemberId: s.buyer.id } });
    expect(left.map((x) => [x.couponId, x.status])).toEqual([[used.id, "ISSUED"]]);
    expect((await db.couponRedemption.findUniqueOrThrow({ where: { orderId: o.orderId } })).restoredAt).not.toBeNull();
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "buyer.withdraw", actorId: s.buyer.id } });
    expect((audit.after as { deletedCoupons: number }).deletedCoupons).toBe(1);
  });
});

describe("직접 지급", () => {
  it("고른 등급 회원에게 한 번씩 지급하고, 한도를 넘으면 아무도 받지 않는다", async () => {
    const s = await shop();
    const c = await makeCoupon(s, { issueMethod: "MANUAL", issueLimit: 3 });
    const r1 = await grantPost(json("/x", "POST", s.points, { gradeIds: [s.grade.id] }), p({ couponId: c.id }));
    expect(await r1.json()).toEqual({ ok: true, granted: 2, skipped: 0 });
    const r2 = await grantPost(json("/x", "POST", s.owner, { gradeIds: [s.grade.id] }), p({ couponId: c.id }));
    expect(await r2.json()).toEqual({ ok: true, granted: 0, skipped: 2 });
    await createLoginBuyer(s.seller.id, s.grade.id);
    await createLoginBuyer(s.seller.id, s.grade.id);
    const over = await grantPost(json("/x", "POST", s.owner, { gradeIds: [s.grade.id] }), p({ couponId: c.id }));
    expect(over.status).toBe(409);
    expect((await db.coupon.findUniqueOrThrow({ where: { id: c.id } })).issuedCount).toBe(2);
    expect(await db.buyerCoupon.count({ where: { couponId: c.id } })).toBe(2);
    // 사용 시작 전 쿠폰은 지급하지 않는다(받기·코드와 같은 기준, Codex 4176380508)
    const later = await makeCoupon(s, { issueMethod: "MANUAL", startsAt: iso(DAY), endsAt: iso(2 * DAY) });
    const early = await grantPost(json("/x", "POST", s.owner, { gradeIds: [s.grade.id] }), p({ couponId: later.id }));
    expect(early.status).toBe(400);
    expect(await early.json()).toMatchObject({ error: "not_started", message: expect.stringContaining("해 주십시오") });
    expect(await db.buyerCoupon.count({ where: { couponId: later.id } })).toBe(0);
    // 내려받기 쿠폰·다른 쇼핑몰 등급은 지급할 수 없다
    const dl = await makeCoupon(s);
    expect((await grantPost(json("/x", "POST", s.owner, { gradeIds: [s.grade.id] }), p({ couponId: dl.id }))).status).toBe(400);
    const other = await shop();
    expect((await grantPost(json("/x", "POST", s.owner, { gradeIds: [other.grade.id] }), p({ couponId: c.id }))).status).toBe(400);
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "coupon.grant", targetId: c.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    expect(audit.after).toMatchObject({ granted: 2, skipped: 0 });
  });
});
