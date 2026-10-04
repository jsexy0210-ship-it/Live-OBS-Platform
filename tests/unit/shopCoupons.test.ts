import { describe, expect, it } from "vitest";
import { benefitLabel, couponExpiry, normalizeCode, parseCoupon, quoteCoupon } from "../../lib/server/shop-coupons/rules";

// SA-035 쿠폰: 입력 검사·할인 계산(서버만 계산, 화면 값은 쓰지 않음)
const base = {
  name: "10월 오픈 기념",
  issueMethod: "DOWNLOAD",
  benefit: "AMOUNT",
  value: 5000,
  startsAt: "2026-10-01T00:00+09:00",
  endsAt: "2026-10-31T23:59+09:00",
};
const coupon = { benefit: "AMOUNT" as const, value: 5000, maxDiscount: null, minOrderAmount: 0, productIds: [] as string[], excludeDiscounted: true };
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const line = (productId: string, unitPrice: number, quantity = 1, listUnitPrice = unitPrice) => ({ productId, unitPrice, listUnitPrice, quantity });

describe("쿠폰 입력 검사", () => {
  it("정상 값은 받고 기본값(최소 주문 0, 할인 중 상품 제외, 적립금 병용 허용, 전체 상품)을 채운다", () => {
    const r = parseCoupon(base);
    expect(r.ok && r.v).toMatchObject({ name: "10월 오픈 기념", minOrderAmount: 0, excludeDiscounted: true, allowWithReward: true, productIds: [], code: null, validDays: null, issueLimit: null });
  });

  it("이름 30자 초과·빈 이름은 거부", () => {
    expect(parseCoupon({ ...base, name: "가".repeat(31) })).toEqual({ ok: false, reason: "invalid_name" });
    expect(parseCoupon({ ...base, name: "  " })).toEqual({ ok: false, reason: "invalid_name" });
  });

  it("코드 입력 방식은 영문·숫자 4~16자 코드가 있어야 하고 대문자로 맞춘다. 다른 방식의 코드는 버린다", () => {
    expect(parseCoupon({ ...base, issueMethod: "CODE" })).toEqual({ ok: false, reason: "invalid_code" });
    expect(parseCoupon({ ...base, issueMethod: "CODE", code: "ab-12" })).toEqual({ ok: false, reason: "invalid_code" });
    const r = parseCoupon({ ...base, issueMethod: "CODE", code: " starnight " });
    expect(r.ok && r.v.code).toBe("STARNIGHT");
    const d = parseCoupon({ ...base, code: "STARNIGHT" });
    expect(d.ok && d.v.code).toBeNull();
  });

  it("혜택별 값 범위: 금액 1원~1천만 원, 비율 1~90 %, 배송비 무료는 값 없음", () => {
    expect(parseCoupon({ ...base, value: 0 })).toEqual({ ok: false, reason: "invalid_value" });
    expect(parseCoupon({ ...base, value: 1.5 })).toEqual({ ok: false, reason: "invalid_value" });
    expect(parseCoupon({ ...base, benefit: "RATE", value: 91 })).toEqual({ ok: false, reason: "invalid_value" });
    expect(parseCoupon({ ...base, benefit: "RATE", value: 10, maxDiscount: 0 })).toEqual({ ok: false, reason: "invalid_max_discount" });
    const free = parseCoupon({ ...base, benefit: "FREE_SHIPPING", value: 5000, maxDiscount: 100 });
    expect(free.ok && [free.v.value, free.v.maxDiscount]).toEqual([null, null]);
    const amount = parseCoupon({ ...base, maxDiscount: 100 });
    expect(amount.ok && amount.v.maxDiscount).toBeNull();
  });

  it("기간: 시간대 없는 시각·시작 ≥ 종료는 거부. 받은 뒤 N일은 1~365", () => {
    expect(parseCoupon({ ...base, startsAt: "2026-10-01T00:00" })).toEqual({ ok: false, reason: "invalid_period" });
    expect(parseCoupon({ ...base, endsAt: base.startsAt })).toEqual({ ok: false, reason: "invalid_period" });
    expect(parseCoupon({ ...base, validDays: 0 })).toEqual({ ok: false, reason: "invalid_valid_days" });
    expect(parseCoupon({ ...base, validDays: 366 })).toEqual({ ok: false, reason: "invalid_valid_days" });
  });

  it("적용 상품은 uuid 100개까지, 중복은 하나로", () => {
    expect(parseCoupon({ ...base, productIds: ["x"] })).toEqual({ ok: false, reason: "invalid_products" });
    expect(parseCoupon({ ...base, productIds: Array.from({ length: 101 }, () => P1) })).toEqual({ ok: false, reason: "invalid_products" });
    const r = parseCoupon({ ...base, productIds: [P1, P1.toUpperCase(), P2] });
    expect(r.ok && r.v.productIds).toEqual([P1, P2]);
  });

  it("코드 정규화는 대소문자·앞뒤 공백을 무시한다", () => {
    expect(normalizeCode(" Live2026 ")).toBe("LIVE2026");
    expect(normalizeCode("abc")).toBeNull();
    expect(normalizeCode(1234)).toBeNull();
  });
});

describe("할인 계산", () => {
  it("금액 할인은 적용 금액을 넘지 않는다", () => {
    expect(quoteCoupon(coupon, [line(P1, 3000)], 3000)).toEqual({ ok: true, discountAmount: 3000, baseAmount: 3000 });
    expect(quoteCoupon(coupon, [line(P1, 30000, 2)], 3000)).toEqual({ ok: true, discountAmount: 5000, baseAmount: 60000 });
  });

  it("비율 할인은 원 단위 버림, 최대 할인 금액까지", () => {
    const rate = { ...coupon, benefit: "RATE" as const, value: 15 };
    expect(quoteCoupon(rate, [line(P1, 9999)], 0)).toEqual({ ok: true, discountAmount: 1499, baseAmount: 9999 });
    expect(quoteCoupon({ ...rate, maxDiscount: 1000 }, [line(P1, 9999)], 0)).toEqual({ ok: true, discountAmount: 1000, baseAmount: 9999 });
  });

  it("최소 주문 금액은 적용 상품 금액 기준(배송비 제외)", () => {
    const min = { ...coupon, minOrderAmount: 50000 };
    expect(quoteCoupon(min, [line(P1, 49000)], 3000)).toEqual({ ok: false, reason: "coupon_min_order" });
    expect(quoteCoupon(min, [line(P1, 50000)], 3000)).toMatchObject({ ok: true, discountAmount: 5000 });
  });

  it("적용 상품만, 할인 중인 상품(단가 < 정가)은 옵션에 따라 뺀다", () => {
    const scoped = { ...coupon, productIds: [P2], minOrderAmount: 10000 };
    expect(quoteCoupon(scoped, [line(P1, 50000)], 0)).toEqual({ ok: false, reason: "coupon_not_applicable" });
    expect(quoteCoupon(scoped, [line(P1, 50000), line(P2, 8000)], 0)).toEqual({ ok: false, reason: "coupon_min_order" });
    expect(quoteCoupon(coupon, [line(P1, 9000, 1, 10000)], 0)).toEqual({ ok: false, reason: "coupon_not_applicable" });
    expect(quoteCoupon({ ...coupon, excludeDiscounted: false }, [line(P1, 9000, 1, 10000)], 0)).toMatchObject({ ok: true, discountAmount: 5000 });
  });

  it("배송비 무료는 그 주문의 배송비만큼, 배송비가 없으면 쓸 수 없음", () => {
    const free = { ...coupon, benefit: "FREE_SHIPPING" as const, value: null };
    expect(quoteCoupon(free, [line(P1, 10000)], 3500)).toEqual({ ok: true, discountAmount: 3500, baseAmount: 10000 });
    expect(quoteCoupon(free, [line(P1, 10000)], 0)).toEqual({ ok: false, reason: "coupon_not_applicable" });
  });

  it("받은 뒤 N일 만료는 사용 종료를 넘지 않는다", () => {
    const endsAt = new Date("2026-10-31T15:00:00Z");
    const issued = new Date("2026-10-20T00:00:00Z");
    expect(couponExpiry({ endsAt, validDays: null }, issued)).toEqual(endsAt);
    expect(couponExpiry({ endsAt, validDays: 3 }, issued)).toEqual(new Date("2026-10-23T00:00:00Z"));
    expect(couponExpiry({ endsAt, validDays: 30 }, issued)).toEqual(endsAt);
  });

  it("혜택 문구", () => {
    expect(benefitLabel({ benefit: "AMOUNT", value: 5000, maxDiscount: null })).toBe("5,000원 할인");
    expect(benefitLabel({ benefit: "RATE", value: 10, maxDiscount: 20000 })).toBe("10% 할인 · 최대 20,000원");
    expect(benefitLabel({ benefit: "FREE_SHIPPING", value: null, maxDiscount: null })).toBe("배송비 무료");
  });
});
