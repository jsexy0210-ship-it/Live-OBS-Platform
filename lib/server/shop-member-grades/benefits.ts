import type { GradeShippingBenefit, Prisma, PrismaClient } from "@prisma/client";
import { issueCouponToMember } from "../shop-coupons/service";
import { windowStart } from "./rules";

// 회원 등급 혜택(SA-044, 2026-10-05): ① 배송비 혜택(없음·정액 할인·무료) ② 승급 쿠폰 자동 지급 ③ 마이페이지 「다음 등급까지 남은 금액」.
// 배송비 혜택은 주문 견적(quote.ts)과 주문 생성(create.ts)이 함께 쓰는 orders/pricing.ts에서 부르므로 견적 금액 = 결제 금액이다.
type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;

export const SHIPPING_DISCOUNT_MAX = 100_000;
export type GradeShipping = { benefit: GradeShippingBenefit; discount: number };

// 배송비에 등급 혜택을 적용한다(0원 아래로 내려가지 않는다). 쿠폰은 이 금액에 다시 적용된다.
export function applyGradeShipping(fee: number, g: GradeShipping | null): number {
  if (!g || fee <= 0) return fee;
  if (g.benefit === "FREE") return 0;
  if (g.benefit === "DISCOUNT") return Math.max(0, fee - g.discount);
  return fee;
}

export async function loadGradeShipping(db: Db, sellerId: string, buyerMemberId: string): Promise<GradeShipping | null> {
  const m = await db.buyerMember.findFirst({ where: { id: buyerMemberId, sellerId }, select: { grade: { select: { shippingBenefit: true, shippingDiscount: true } } } });
  return m ? { benefit: m.grade.shippingBenefit, discount: m.grade.shippingDiscount } : null;
}

// 승급할 때 그 등급의 승급 쿠폰을 한 장 준다. 같은 회원에게 같은 쿠폰은 다시 주지 않는다(BuyerCoupon 유니크 + 지급 여부 확인).
// 줄 수 없는 경우(쿠폰 종료·중지·수량 소진)는 조용히 건너뛰고 로그 추적에 남기지 않는다(승급 자체는 그대로).
export async function grantPromotionCoupon(tx: Tx, o: { sellerId: string; buyerMemberId: string; gradeId: string }): Promise<"issued" | "already" | "unavailable" | "sold_out" | "none"> {
  const g = await tx.memberGrade.findFirst({ where: { id: o.gradeId, sellerId: o.sellerId }, select: { promotionCouponId: true } });
  if (!g?.promotionCouponId) return "none";
  return issueCouponToMember(tx, { sellerId: o.sellerId, couponId: g.promotionCouponId, buyerMemberId: o.buyerMemberId });
}

// 구매자 마이페이지: 지금 등급·혜택·다음 등급까지 남은 금액(재산정과 같은 기준: 기간 안 결제 완료 주문 결제액 − 부분 환불액)
export async function buyerGradeStatus(db: PrismaClient, scope: { sellerId: string; buyerMemberId: string }, now = new Date()) {
  const member = await db.buyerMember.findFirst({ where: { id: scope.buyerMemberId, sellerId: scope.sellerId, status: "ACTIVE", deletedAt: null }, select: { gradeId: true } });
  if (!member) return null;
  const [grades, policy] = await Promise.all([
    db.memberGrade.findMany({ where: { sellerId: scope.sellerId }, orderBy: { sortOrder: "asc" }, select: { id: true, displayName: true, minAmount: true, shippingBenefit: true, shippingDiscount: true, promotionCouponId: true } }),
    db.memberGradePolicy.findUnique({ where: { sellerId: scope.sellerId }, select: { autoEnabled: true, windowMonths: true } }),
  ]);
  const idx = grades.findIndex((g) => g.id === member.gradeId);
  if (idx < 0) return null;
  const current = grades[idx];
  const next = grades[idx + 1] ?? null;
  const windowMonths = policy?.windowMonths ?? 6;
  const sum = await db.order.aggregate({
    where: { sellerId: scope.sellerId, buyerMemberId: scope.buyerMemberId, status: "PAID", paidAt: { gte: windowStart(now, windowMonths), lt: now } },
    _sum: { totalAmount: true, refundAmount: true },
  });
  const amount = Math.max(0, (sum._sum.totalAmount ?? 0) - (sum._sum.refundAmount ?? 0));
  const benefits: string[] = [];
  if (current.shippingBenefit === "FREE") benefits.push("배송비 무료");
  if (current.shippingBenefit === "DISCOUNT") benefits.push(`배송비 ${current.shippingDiscount.toLocaleString("ko-KR")}원 할인`);
  return {
    gradeName: current.displayName,
    benefits,
    // 자동 등급이 꺼져 있으면 금액으로 올라가지 않으므로 남은 금액을 보여 주지 않는다
    nextGrade: policy?.autoEnabled && next ? { name: next.displayName, remaining: Math.max(0, next.minAmount - amount), minAmount: next.minAmount } : null,
    windowMonths,
    amount,
  };
}
