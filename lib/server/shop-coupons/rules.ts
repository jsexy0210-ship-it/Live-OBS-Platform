import type { CouponBenefit, CouponIssueMethod } from "@prisma/client";
import { cleanText } from "../text/clean";

// 쿠폰 입력 검사·할인 계산(DB 없음). 값 범위는 마이그레이션 20261004190000_shop_coupons의 CHECK와 같다.
// 할인 금액은 주문 생성 때 서버가 이 함수로만 계산한다(화면이 보낸 금액은 받지 않음).

export const COUPON_NAME_MAX = 30;
export const COUPON_AMOUNT_MAX = 10_000_000;
export const COUPON_RATE_MAX = 90;
export const COUPON_MIN_ORDER_MAX = 100_000_000;
export const COUPON_VALID_DAYS_MAX = 365;
export const COUPON_ISSUE_LIMIT_MAX = 1_000_000;
export const COUPON_PRODUCTS_MAX = 100;
// 쇼핑몰마다 만들 수 있는 쿠폰 수(종료된 쿠폰 포함)
export const COUPON_LIMIT = 200;
export const COUPON_CODE = /^[A-Z0-9]{4,16}$/;

export const ISSUE_METHODS: readonly CouponIssueMethod[] = ["DOWNLOAD", "CODE", "MANUAL"];
export const BENEFITS: readonly CouponBenefit[] = ["AMOUNT", "RATE", "FREE_SHIPPING"];

export type CouponRejection =
  | "invalid_name"
  | "invalid_issue_method"
  | "invalid_code"
  | "code_taken"
  | "invalid_benefit"
  | "invalid_value"
  | "invalid_max_discount"
  | "invalid_min_order"
  | "invalid_period"
  | "invalid_valid_days"
  | "invalid_issue_limit"
  | "issue_limit_below_issued"
  | "invalid_products"
  | "method_locked"
  | "ends_before_issued"
  | "too_many";

// 파트너스 관리자 화면 문구(합니다체)
export const COUPON_MESSAGES: Record<CouponRejection, string> = {
  invalid_name: `쿠폰 이름을 1~${COUPON_NAME_MAX}자로 입력해 주십시오.`,
  invalid_issue_method: "발급 방식을 골라 주십시오.",
  invalid_code: "쿠폰 코드는 영문·숫자 4~16자로 입력해 주십시오.",
  code_taken: "이미 쓰는 코드입니다. 다른 코드를 입력해 주십시오.",
  invalid_benefit: "혜택을 골라 주십시오.",
  invalid_value: `할인 금액은 1~${COUPON_AMOUNT_MAX.toLocaleString("ko-KR")}원, 할인율은 1~${COUPON_RATE_MAX}%로 입력해 주십시오.`,
  invalid_max_discount: "최대 할인 금액을 다시 확인해 주십시오.",
  invalid_min_order: "최소 주문 금액을 다시 확인해 주십시오.",
  invalid_period: "사용 기간을 다시 확인해 주십시오. 종료는 시작보다 뒤여야 합니다.",
  invalid_valid_days: `받은 뒤 쓸 수 있는 기간은 1~${COUPON_VALID_DAYS_MAX}일로 입력해 주십시오.`,
  invalid_issue_limit: "발급 수량 한도를 다시 확인해 주십시오.",
  issue_limit_below_issued: "이미 발급한 수보다 적게 줄일 수 없습니다.",
  invalid_products: `적용 상품은 ${COUPON_PRODUCTS_MAX}개까지 이 쇼핑몰 상품에서 골라 주십시오.`,
  method_locked: "발급한 쿠폰은 발급 방식·혜택을 바꿀 수 없습니다. 새 쿠폰을 만들어 주십시오.",
  ends_before_issued: "이미 받은 쿠폰의 받은 시각보다 이른 종료로 바꿀 수 없습니다. 종료를 늦추거나 발급을 중지해 주십시오.",
  too_many: `쿠폰은 ${COUPON_LIMIT}개까지 만들 수 있습니다.`,
};

export type CouponInput = {
  name: string;
  issueMethod: CouponIssueMethod;
  code: string | null;
  benefit: CouponBenefit;
  value: number | null;
  maxDiscount: number | null;
  minOrderAmount: number;
  startsAt: Date;
  endsAt: Date;
  validDays: number | null;
  issueLimit: number | null;
  productIds: string[];
  excludeDiscounted: boolean;
  allowWithReward: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
// 시각은 시간대가 붙은 ISO 문자열만 받는다(화면은 KST +09:00으로 보낸다)
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
function parseTime(v: unknown): Date | null {
  if (typeof v !== "string" || !ISO.test(v)) return null;
  const d = new Date(v);
  const y = d.getUTCFullYear();
  return Number.isNaN(d.getTime()) || y < 2000 || y > 2100 ? null : d;
}
const int = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null);
const optInt = (v: unknown, min: number, max: number): number | null | undefined => (v === null || v === undefined || v === "" ? null : (int(v, min, max) ?? undefined));

// 코드는 대소문자를 가리지 않는다(대문자로 맞춤)
export const normalizeCode = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const c = v.trim().toUpperCase();
  return COUPON_CODE.test(c) ? c : null;
};

export function parseCoupon(raw: unknown): { ok: true; v: CouponInput } | { ok: false; reason: CouponRejection } {
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const name = cleanText(b.name, COUPON_NAME_MAX);
  if (!name) return { ok: false, reason: "invalid_name" };
  const issueMethod = ISSUE_METHODS.find((m) => m === b.issueMethod);
  if (!issueMethod) return { ok: false, reason: "invalid_issue_method" };
  let code: string | null = null;
  if (issueMethod === "CODE") {
    code = normalizeCode(b.code);
    if (!code) return { ok: false, reason: "invalid_code" };
  }
  const benefit = BENEFITS.find((x) => x === b.benefit);
  if (!benefit) return { ok: false, reason: "invalid_benefit" };
  let value: number | null = null;
  let maxDiscount: number | null = null;
  if (benefit === "AMOUNT") {
    value = int(b.value, 1, COUPON_AMOUNT_MAX);
    if (value === null) return { ok: false, reason: "invalid_value" };
  } else if (benefit === "RATE") {
    value = int(b.value, 1, COUPON_RATE_MAX);
    if (value === null) return { ok: false, reason: "invalid_value" };
    const m = optInt(b.maxDiscount, 1, COUPON_AMOUNT_MAX);
    if (m === undefined) return { ok: false, reason: "invalid_max_discount" };
    maxDiscount = m;
  }
  const minOrderAmount = optInt(b.minOrderAmount, 0, COUPON_MIN_ORDER_MAX);
  if (minOrderAmount === undefined) return { ok: false, reason: "invalid_min_order" };
  const startsAt = parseTime(b.startsAt);
  const endsAt = parseTime(b.endsAt);
  if (!startsAt || !endsAt || startsAt >= endsAt) return { ok: false, reason: "invalid_period" };
  const validDays = optInt(b.validDays, 1, COUPON_VALID_DAYS_MAX);
  if (validDays === undefined) return { ok: false, reason: "invalid_valid_days" };
  const issueLimit = optInt(b.issueLimit, 1, COUPON_ISSUE_LIMIT_MAX);
  if (issueLimit === undefined) return { ok: false, reason: "invalid_issue_limit" };
  const ids = b.productIds === undefined || b.productIds === null ? [] : b.productIds;
  if (!Array.isArray(ids) || ids.length > COUPON_PRODUCTS_MAX || !ids.every(isUuid)) return { ok: false, reason: "invalid_products" };
  const productIds = [...new Set(ids.map((x) => x.toLowerCase()))];
  const excludeDiscounted = typeof b.excludeDiscounted === "boolean" ? b.excludeDiscounted : true;
  const allowWithReward = typeof b.allowWithReward === "boolean" ? b.allowWithReward : true;
  return {
    ok: true,
    v: { name, issueMethod, code, benefit, value, maxDiscount, minOrderAmount: minOrderAmount ?? 0, startsAt, endsAt, validDays, issueLimit, productIds, excludeDiscounted, allowWithReward },
  };
}

// 받은 쿠폰의 만료: 받은 뒤 N일이면 받은 때 + N일(사용 종료를 넘지 않음), 아니면 사용 종료
export function couponExpiry(c: { endsAt: Date; validDays: number | null }, issuedAt: Date): Date {
  if (!c.validDays) return c.endsAt;
  const t = issuedAt.getTime() + c.validDays * 86_400_000;
  return t < c.endsAt.getTime() ? new Date(t) : c.endsAt;
}

// key: 품목을 가리키는 값(주문에서는 옵션 id, 주문당 옵션은 한 줄). 품목별 할인 배분의 키다.
export type CouponLine = { key?: string; productId: string; unitPrice: number; listUnitPrice: number; quantity: number };
export type CouponQuoteFailure = "coupon_not_applicable" | "coupon_min_order";

// 할인 계산. 적용 상품(비어 있으면 전체)에서 「할인 중인 상품 제외」면 이벤트 할인 단가(단가 < 정가) 품목을 뺀 금액이 기준이다.
// - 기준 금액이 0원이면 쓸 수 없음, 최소 주문 금액(기준 금액, 배송비 제외)보다 적으면 쓸 수 없음
// - 금액 할인: 할인 금액(기준 금액을 넘지 않음). 비율 할인: 기준 금액 × 할인율, 원 단위 버림, 최대 할인 금액까지
// - 배송비 무료: 이 주문의 배송비(배송비가 없으면 쓸 수 없음)
export function quoteCoupon(
  c: { benefit: CouponBenefit; value: number | null; maxDiscount: number | null; minOrderAmount: number; productIds: string[]; excludeDiscounted: boolean },
  lines: CouponLine[],
  shippingFee: number,
): { ok: true; discountAmount: number; baseAmount: number; itemDiscounts: Record<string, number> } | { ok: false; reason: CouponQuoteFailure } {
  const scope = new Set(c.productIds.map((x) => x.toLowerCase()));
  const eligible = lines.filter((l) => (scope.size === 0 || scope.has(l.productId.toLowerCase())) && !(c.excludeDiscounted && l.unitPrice < l.listUnitPrice));
  const base = eligible.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  if (base <= 0) return { ok: false, reason: "coupon_not_applicable" };
  if (base < c.minOrderAmount) return { ok: false, reason: "coupon_min_order" };
  if (c.benefit === "FREE_SHIPPING") {
    return shippingFee > 0 ? { ok: true, discountAmount: shippingFee, baseAmount: base, itemDiscounts: {} } : { ok: false, reason: "coupon_not_applicable" };
  }
  const raw = c.benefit === "AMOUNT" ? (c.value ?? 0) : Math.floor((base * (c.value ?? 0)) / 100);
  const capped = c.benefit === "RATE" && c.maxDiscount !== null ? Math.min(raw, c.maxDiscount) : raw;
  const discountAmount = Math.min(capped, base);
  return discountAmount > 0 ? { ok: true, discountAmount, baseAmount: base, itemDiscounts: allocateDiscount(eligible, discountAmount) } : { ok: false, reason: "coupon_not_applicable" };
}

// 상품 할인을 적용 품목 금액 비율로 나눈다(원 단위 버림, 끝수는 마지막 품목). 각 품목 배분액은 그 품목 금액을 넘지 않는다(할인 ≤ 적용 금액).
export function allocateDiscount(eligible: CouponLine[], discount: number): Record<string, number> {
  const base = eligible.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  const out: Record<string, number> = {};
  let left = discount;
  eligible.forEach((l, i) => {
    const amount = l.unitPrice * l.quantity;
    const share = i === eligible.length - 1 ? left : Math.floor((discount * amount) / base);
    out[l.key ?? l.productId] = (out[l.key ?? l.productId] ?? 0) + share;
    left -= share;
  });
  return out;
}

// 화면 표시용 혜택 문구. 예) 5,000원 할인 · 10% 할인 · 최대 20,000원 · 배송비 무료
export function benefitLabel(c: { benefit: CouponBenefit; value: number | null; maxDiscount: number | null }): string {
  if (c.benefit === "FREE_SHIPPING") return "배송비 무료";
  if (c.benefit === "AMOUNT") return `${(c.value ?? 0).toLocaleString("ko-KR")}원 할인`;
  return `${c.value}% 할인${c.maxDiscount ? ` · 최대 ${c.maxDiscount.toLocaleString("ko-KR")}원` : ""}`;
}
