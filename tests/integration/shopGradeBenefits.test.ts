import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as changesGet } from "../../app/api/seller/member-grades/changes/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { quoteOrder } from "../../lib/server/orders/quote";
import { applyGradeShipping, buyerGradeStatus } from "../../lib/server/shop-member-grades/benefits";
import { addMemberGrade, listGradeChanges, recalcNow, recalcSellerGrades, saveMemberGrades, setMemberGrade } from "../../lib/server/shop-member-grades/service";
import { deleteCoupon } from "../../lib/server/shop-coupons/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 회원 등급 혜택(SA-044): 배송비 혜택(견적 금액 = 결제 금액), 승급 쿠폰 자동 지급(중복·동시·한도·중지), 승급·강등 알림 발송 기록, 남은 금액, 변동 회원, 권한·판매자 격리.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const addr = { recipientName: "김구매", phone: "010-1234-5678", zipCode: "06236", address1: "서울 강남구 테헤란로 1" };
const DAY = 86_400_000;
const NOW = new Date("2026-11-01T00:30:00+09:00");

// 등급: 일반(0) · 새싹(100,000) · 실버(500,000). 상품 10,000원(배송비 기본 3,000원)
async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const staff = await createSellerUser(seller.id, { permissions: ["PRODUCT_MANAGE"] });
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const ids = [grade.id];
  for (const [name, amount] of [["새싹", 100_000], ["실버", 500_000]] as const) {
    const r = await addMemberGrade(db, ctx, { displayName: name, minAmount: amount });
    if (!r.ok) throw new Error(r.reason);
    ids.push(r.id);
  }
  await db.memberGrade.update({ where: { id: grade.id }, data: { systemKey: "BASIC" } });
  await db.memberGradePolicy.update({ where: { sellerId: seller.id }, data: { autoEnabled: true } });
  const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 10_000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1팩", stock: 100 } });
  const member = async (gradeIndex = 0) => createLoginBuyer(seller.id, ids[gradeIndex]);
  const setBenefit = async (i: number, benefit: Record<string, unknown>) => {
    const g = await db.memberGrade.findUniqueOrThrow({ where: { id: ids[i] } });
    return saveMemberGrades(db, ctx, { grades: [{ id: g.id, displayName: g.displayName, minAmount: g.minAmount, ...benefit }] });
  };
  const coupon = (extra: Record<string, unknown> = {}) =>
    db.coupon.create({ data: { sellerId: seller.id, name: "승급 쿠폰", issueMethod: "MANUAL", benefit: "AMOUNT", value: 3000, startsAt: new Date(Date.now() - DAY), endsAt: new Date(Date.now() + 30 * DAY), ...extra } });
  const paid = (memberId: string, amount: number) =>
    db.order.create({ data: { sellerId: seller.id, orderNo: Math.floor(Math.random() * 1e9), buyerMemberId: memberId, status: "PAID", broadcastNicknameSnapshot: "닉", totalAmount: amount, paidAt: new Date(NOW.getTime() - DAY) } });
  return { seller, owner, staff, ctx, ids, product, option, member, setBenefit, coupon, paid };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const quote = async (s: Shop, memberId: string, couponId?: string) => {
  const r = await quoteOrder(db, { sellerId: s.seller.id, buyerMemberId: memberId, items: [{ optionId: s.option.id, quantity: 1 }], zipCode: addr.zipCode, address1: addr.address1, couponId });
  if (!r.ok) throw new Error(r.reason);
  return r.value;
};
const order = async (s: Shop, memberId: string, couponId?: string) => {
  const r = await createOrder(db, { sellerId: s.seller.id, buyerMemberId: memberId, items: [{ optionId: s.option.id, quantity: 1 }], consent, shippingAddress: addr, couponId });
  if (!r.ok) throw new Error(r.reason);
  return r;
};

describe("배송비 혜택: 견적 금액 = 결제 금액", () => {
  it("순수 계산: 무료·정액 할인(0원 아래로 내려가지 않음)·없음", () => {
    expect(applyGradeShipping(3000, { benefit: "FREE", discount: 0 })).toBe(0);
    expect(applyGradeShipping(3000, { benefit: "DISCOUNT", discount: 1000 })).toBe(2000);
    expect(applyGradeShipping(3000, { benefit: "DISCOUNT", discount: 5000 })).toBe(0);
    expect(applyGradeShipping(3000, { benefit: "NONE", discount: 0 })).toBe(3000);
    expect(applyGradeShipping(0, { benefit: "DISCOUNT", discount: 1000 })).toBe(0);
    expect(applyGradeShipping(3000, null)).toBe(3000);
  });

  it("등급별로 견적과 주문 생성의 배송비·합계가 같다(무료·정액·없음, 쿠폰 병용 포함)", async () => {
    const s = await shop();
    expect(await s.setBenefit(1, { shippingBenefit: "DISCOUNT", shippingDiscount: 1000 })).toEqual({ ok: true });
    expect(await s.setBenefit(2, { shippingBenefit: "FREE" })).toEqual({ ok: true });
    const none = await s.member(0);
    const disc = await s.member(1);
    const free = await s.member(2);
    for (const [m, ship, off] of [[none, 3000, 0], [disc, 2000, 1000], [free, 0, 3000]] as const) {
      const q = await quote(s, m.id);
      expect(q).toMatchObject({ shippingFee: ship, gradeShippingDiscount: off, totalAmount: 10_000 + ship });
      const o = await order(s, m.id);
      expect(o).toMatchObject({ shippingFee: q.shippingFee, totalAmount: q.totalAmount });
    }
    // 배송비 무료 쿠폰과 같이 쓰면 등급 혜택으로 줄어든 배송비에서 쿠폰이 할인한다
    const fs = await s.coupon({ name: "무료배송", benefit: "FREE_SHIPPING", value: null, issueMethod: "DOWNLOAD" });
    const d2 = await s.member(1);
    await db.buyerCoupon.create({ data: { sellerId: s.seller.id, couponId: fs.id, buyerMemberId: d2.id, issuedAt: new Date(), expiresAt: new Date(Date.now() + DAY) } });
    const q = await quote(s, d2.id, fs.id);
    expect(q).toMatchObject({ shippingFee: 2000, couponDiscount: 2000, totalAmount: 10_000 });
    expect(await order(s, d2.id, fs.id)).toMatchObject({ shippingFee: 2000, totalAmount: q.totalAmount });
  });

  it("승급하면 다음 견적부터 새 등급 혜택이 적용된다", async () => {
    const s = await shop();
    await s.setBenefit(1, { shippingBenefit: "FREE" });
    const m = await s.member(0);
    expect((await quote(s, m.id)).shippingFee).toBe(3000);
    expect(await setMemberGrade(db, s.ctx, m.id, { gradeId: s.ids[1], lock: false })).toMatchObject({ ok: true });
    expect((await quote(s, m.id)).shippingFee).toBe(0);
  });
});

describe("혜택 저장 검사", () => {
  it("배송비 혜택·승급 쿠폰 입력 검사와 아무것도 바꾸지 않는 실패", async () => {
    const s = await shop();
    const manual = await s.coupon();
    const dl = await s.coupon({ name: "내려받기", issueMethod: "DOWNLOAD" });
    const bad = async (benefit: Record<string, unknown>) => ((await s.setBenefit(1, benefit)) as { reason?: string }).reason;
    expect(await bad({ shippingBenefit: "HALF" })).toBe("invalid_benefit");
    expect(await bad({ shippingBenefit: "DISCOUNT" })).toBe("invalid_benefit");
    expect(await bad({ shippingBenefit: "DISCOUNT", shippingDiscount: 0 })).toBe("invalid_benefit");
    expect(await bad({ shippingBenefit: "DISCOUNT", shippingDiscount: 100_001 })).toBe("invalid_benefit");
    expect(await bad({ shippingBenefit: "DISCOUNT", shippingDiscount: 1.5 })).toBe("invalid_benefit");
    expect(await bad({ shippingBenefit: "FREE", shippingDiscount: 500 })).toBe("invalid_benefit");
    expect(await bad({ shippingDiscount: 500 })).toBe("invalid_benefit");
    expect(await bad({ promotionCouponId: "x" })).toBe("invalid_coupon");
    expect(await bad({ promotionCouponId: dl.id })).toBe("invalid_coupon"); // 직접 지급 방식이 아님
    const other = await shop();
    const foreign = await other.coupon();
    expect(await bad({ promotionCouponId: foreign.id })).toBe("invalid_coupon"); // 다른 쇼핑몰 쿠폰
    expect(await db.memberGrade.findUniqueOrThrow({ where: { id: s.ids[1] } })).toMatchObject({ shippingBenefit: "NONE", shippingDiscount: 0, promotionCouponId: null });
    expect(await s.setBenefit(1, { shippingBenefit: "DISCOUNT", shippingDiscount: 1500, promotionCouponId: manual.id })).toEqual({ ok: true });
    expect(await db.memberGrade.findUniqueOrThrow({ where: { id: s.ids[1] } })).toMatchObject({ shippingBenefit: "DISCOUNT", shippingDiscount: 1500, promotionCouponId: manual.id });
    // 혜택을 빼면 금액도 0으로, 쿠폰 연결은 null로 풀 수 있다
    expect(await s.setBenefit(1, { shippingBenefit: "NONE", promotionCouponId: null })).toEqual({ ok: true });
    expect(await db.memberGrade.findUniqueOrThrow({ where: { id: s.ids[1] } })).toMatchObject({ shippingBenefit: "NONE", shippingDiscount: 0, promotionCouponId: null });
  });

  it("승급 쿠폰으로 연결된 쿠폰은 지울 수 없고, 연결을 풀면 지울 수 있다", async () => {
    const s = await shop();
    const c = await s.coupon();
    await s.setBenefit(1, { promotionCouponId: c.id });
    expect(await deleteCoupon(db, s.ctx, c.id)).toEqual({ ok: false, reason: "grade_benefit" });
    await s.setBenefit(1, { promotionCouponId: null });
    expect(await deleteCoupon(db, s.ctx, c.id)).toEqual({ ok: true });
  });

  it("권한 없는 직원은 혜택을 저장하지 못한다", async () => {
    const s = await shop();
    const sctx: TenantContext = { ...s.ctx, actorId: s.staff.id, isOwner: false, permissions: ["PRODUCT_MANAGE"] };
    await expect(saveMemberGrades(db, sctx, { grades: [{ id: s.ids[1], displayName: "새싹", minAmount: 100_000, shippingBenefit: "FREE" }] })).rejects.toThrow();
    expect((await db.memberGrade.findUniqueOrThrow({ where: { id: s.ids[1] } })).shippingBenefit).toBe("NONE");
  });
});

describe("승급 쿠폰 자동 지급", () => {
  const held = (couponId: string, memberId: string) => db.buyerCoupon.count({ where: { couponId, buyerMemberId: memberId } });

  it("자동 승급하면 그 등급 쿠폰을 한 장 주고, 강등·다시 승급해도 같은 쿠폰은 다시 주지 않는다", async () => {
    const s = await shop();
    const c = await s.coupon();
    await s.setBenefit(1, { promotionCouponId: c.id });
    const m = await s.member(0);
    await s.paid(m.id, 150_000);
    expect(await recalcSellerGrades(db, s.seller.id, NOW, { manual: true })).toMatchObject({ promoted: 1 });
    expect(await held(c.id, m.id)).toBe(1);
    expect(await db.coupon.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ issuedCount: 1 });
    // 강등(결제액이 줄어듦) 뒤 다시 승급해도 두 번째 쿠폰은 없다
    await db.order.deleteMany({ where: { buyerMemberId: m.id } });
    expect(await recalcSellerGrades(db, s.seller.id, NOW, { manual: true })).toMatchObject({ demoted: 1 });
    await s.paid(m.id, 150_000);
    expect(await recalcSellerGrades(db, s.seller.id, NOW, { manual: true })).toMatchObject({ promoted: 1 });
    expect(await held(c.id, m.id)).toBe(1);
    expect(await db.coupon.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ issuedCount: 1 });
  });

  it("동시 재산정·직접 승급이 겹쳐도 한 회원에게 한 장만 가고 발급 수도 한 번만 늘어난다", async () => {
    const s = await shop();
    const c = await s.coupon();
    await s.setBenefit(1, { promotionCouponId: c.id });
    const m = await s.member(0);
    await s.paid(m.id, 150_000);
    await Promise.all([recalcSellerGrades(db, s.seller.id, NOW, { manual: true }), recalcSellerGrades(db, s.seller.id, NOW, { manual: true }), recalcSellerGrades(db, s.seller.id, NOW, { manual: true })]);
    expect(await held(c.id, m.id)).toBe(1);
    expect(await db.coupon.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ issuedCount: 1 });
    // 이미 받은 뒤 직접 한 단계 내렸다가 올려도 늘지 않는다
    await setMemberGrade(db, s.ctx, m.id, { gradeId: s.ids[0], lock: false });
    await setMemberGrade(db, s.ctx, m.id, { gradeId: s.ids[1], lock: false });
    expect(await held(c.id, m.id)).toBe(1);
  });

  it("발급 수량이 남은 만큼만 주고, 모자라면 승급은 그대로 두고 쿠폰만 건너뛴다. 중지·기간 지난 쿠폰도 건너뛴다", async () => {
    const s = await shop();
    const limited = await s.coupon({ issueLimit: 1 });
    await s.setBenefit(1, { promotionCouponId: limited.id });
    const a = await s.member(0);
    const b = await s.member(0);
    await s.paid(a.id, 150_000);
    await s.paid(b.id, 150_000);
    expect(await recalcSellerGrades(db, s.seller.id, NOW, { manual: true })).toMatchObject({ promoted: 2 });
    expect((await held(limited.id, a.id)) + (await held(limited.id, b.id))).toBe(1);
    expect(await db.coupon.findUniqueOrThrow({ where: { id: limited.id } })).toMatchObject({ issuedCount: 1 });
    // 중지된 쿠폰·종료된 쿠폰
    const off = await s.coupon({ isActive: false });
    const ended = await s.coupon({ startsAt: new Date(Date.now() - 3 * DAY), endsAt: new Date(Date.now() - DAY) });
    await s.setBenefit(2, { promotionCouponId: off.id });
    const c = await s.member(1);
    await s.paid(c.id, 700_000);
    expect(await recalcSellerGrades(db, s.seller.id, NOW, { manual: true })).toMatchObject({ promoted: 1 });
    expect(await held(off.id, c.id)).toBe(0);
    await db.memberGrade.update({ where: { id: s.ids[2] }, data: { promotionCouponId: ended.id } });
    const d = await s.member(1);
    await s.paid(d.id, 700_000);
    expect(await recalcSellerGrades(db, s.seller.id, NOW, { manual: true })).toMatchObject({ promoted: 1 });
    expect(await held(ended.id, d.id)).toBe(0);
  });

  it("직접 올리면 쿠폰을 주고, 강등과 고정·내림은 주지 않는다", async () => {
    const s = await shop();
    const c = await s.coupon();
    await s.setBenefit(2, { promotionCouponId: c.id });
    const m = await s.member(0);
    await setMemberGrade(db, s.ctx, m.id, { gradeId: s.ids[2], lock: true });
    expect(await held(c.id, m.id)).toBe(1);
    const lower = await s.member(2);
    await setMemberGrade(db, s.ctx, lower.id, { gradeId: s.ids[0], lock: false });
    expect(await held(c.id, lower.id)).toBe(0);
  });

  it("승급·강등마다 알림 발송 기록(발송 안 함)이 로그 추적에 남는다", async () => {
    const s = await shop();
    const c = await s.coupon();
    await s.setBenefit(1, { promotionCouponId: c.id });
    const up = await s.member(0);
    const down = await s.member(2);
    await s.paid(up.id, 150_000);
    expect(await recalcSellerGrades(db, s.seller.id, NOW, { manual: true })).toMatchObject({ promoted: 1, demoted: 1 });
    const notices = await db.auditLog.findMany({ where: { sellerId: s.seller.id, action: "member_grade.notice" } });
    expect(notices).toHaveLength(2);
    expect(notices.find((n) => n.targetId === up.id)?.after).toMatchObject({ kind: "UP", to: "새싹", coupon: "issued", delivered: false });
    expect(notices.find((n) => n.targetId === down.id)?.after).toMatchObject({ kind: "DOWN", delivered: false });
  });
});

describe("다음 등급까지 남은 금액 · 변동 회원", () => {
  it("현재 등급·혜택·다음 등급까지 남은 금액을 주고, 자동 등급이 꺼져 있거나 최고 등급이면 다음 등급이 없다", async () => {
    const s = await shop();
    await s.setBenefit(0, { shippingBenefit: "DISCOUNT", shippingDiscount: 500 });
    const m = await s.member(0);
    await db.order.create({ data: { sellerId: s.seller.id, orderNo: 7, buyerMemberId: m.id, status: "PAID", broadcastNicknameSnapshot: "닉", totalAmount: 60_000, refundAmount: 10_000, paidAt: new Date(NOW.getTime() - DAY) } });
    const scope = { sellerId: s.seller.id, buyerMemberId: m.id };
    expect(await buyerGradeStatus(db, scope, NOW)).toMatchObject({ gradeName: "일반", benefits: ["배송비 500원 할인"], nextGrade: { name: "새싹", remaining: 50_000 }, amount: 50_000 });
    await db.memberGradePolicy.update({ where: { sellerId: s.seller.id }, data: { autoEnabled: false } });
    expect((await buyerGradeStatus(db, scope, NOW))?.nextGrade).toBeNull();
    await db.memberGradePolicy.update({ where: { sellerId: s.seller.id }, data: { autoEnabled: true } });
    await db.buyerMember.update({ where: { id: m.id }, data: { gradeId: s.ids[2] } });
    expect((await buyerGradeStatus(db, scope, NOW))?.nextGrade).toBeNull();
    // 남의 쇼핑몰 회원 id로는 안 나온다
    const other = await shop();
    expect(await buyerGradeStatus(db, { sellerId: other.seller.id, buyerMemberId: m.id }, NOW)).toBeNull();
  });

  it("변동 회원: 승급·강등만 골라 보고, 권한 없는 직원·다른 쇼핑몰은 보지 못한다", async () => {
    const s = await shop();
    const up = await s.member(0);
    const down = await s.member(2);
    await s.paid(up.id, 150_000);
    await recalcNow(db, s.ctx, NOW);
    const upList = await listGradeChanges(db, s.ctx, { kind: "up" });
    expect(upList.changes.map((c) => c.memberId)).toEqual([up.id]);
    expect((await listGradeChanges(db, s.ctx, { kind: "down" })).changes.map((c) => c.memberId)).toEqual([down.id]);
    expect((await listGradeChanges(db, s.ctx)).changes).toHaveLength(2);
    expect((await listGradeChanges(db, (await shop()).ctx)).changes).toHaveLength(0);
    const sctx: TenantContext = { ...s.ctx, actorId: s.staff.id, isOwner: false, permissions: ["PRODUCT_MANAGE"] };
    await expect(listGradeChanges(db, sctx)).rejects.toThrow();
    // 라우트: 로그인하지 않으면 401, 대표자는 200
    expect((await changesGet(new Request("http://localhost:3000/api/seller/member-grades/changes", { headers: { host: "localhost:3000" } }))).status).toBe(401);
    const login = await loginSeller(db, { email: (await db.sellerUser.findFirstOrThrow({ where: { sellerId: s.seller.id, id: s.owner.id } })).email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    const res = await changesGet(new Request("http://localhost:3000/api/seller/member-grades/changes?kind=up", { headers: { host: "localhost:3000", cookie: `lo_seller=${login.token}` } }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { changes: unknown[] }).changes).toHaveLength(1);
  });
});
