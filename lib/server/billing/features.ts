import type { Prisma, PrismaClient } from "@prisma/client";
import { DEFAULT_PLAN_CODE } from "./subscription";

// 플랜이 주는 기능 권한(docs/ARCHITECTURE.md 4.8.0, ONQ 1-B). 서버가 매 요청 검사한다(화면 숨김만으로 막지 않음).
// 잠금(access.ts sellerAccess)과는 따로 판정하고, 잠금 규칙이 먼저다. 직원은 이 기능 권한과 직원 권한(3.3)을 둘 다 가져야 한다.
export const FEATURES = ["OVERLAY", "EXTERNAL_INTEGRATION", "STORE_OPERATIONS"] as const;
export type Feature = (typeof FEATURES)[number];

// 플랜 코드 → 기능 권한. STANDARD는 지금 판매자의 플랜(1-C에서 INTEGRATED로 옮김)이라 지금 동작대로 모든 기능을 연다.
// 표에 없는 플랜 코드는 아무 기능도 주지 않는다(닫힌 쪽으로 판단).
export const PLAN_FEATURES = {
  STANDARD: FEATURES,
  OVERLAY_ONLY: ["OVERLAY", "EXTERNAL_INTEGRATION"],
  INTEGRATED: FEATURES,
} as const satisfies Record<string, readonly Feature[]>;

export type PlanCode = keyof typeof PLAN_FEATURES;

// 첫 결제가 확정되기 전에는 기능 권한을 열지 않는 플랜(쇼핑몰 통합은 체험 없이 결제 후 사용, MASTER 결정 2026-10-04).
// 그 전에는 구독·결제 화면과 내 정보·로그아웃만 열린다.
const AFTER_FIRST_PAYMENT: readonly string[] = ["INTEGRATED"];

// hadTrial: 체험을 받은 적 있는 판매자(trialEndsAt 있음). 새 통합 가입은 체험이 없어(trialEndsAt null) 첫 결제 확정 전까지 닫히고,
// 1-C에서 통합으로 옮긴 기존 판매자(체험 중이거나 체험이 끝나 잠김)는 이 대신 잠금 규칙(access.ts)을 따른다. 잠긴 동안에도
// 체험 중 받은 주문의 처리는 지금처럼 열려야 하기 때문이다(잠금 중 허용 범위).
export function planFeatures(planCode: string, state: { firstPaymentConfirmed: boolean; hadTrial: boolean }): readonly Feature[] {
  const features: readonly Feature[] | undefined = (PLAN_FEATURES as Record<string, readonly Feature[]>)[planCode];
  if (!features) return [];
  if (AFTER_FIRST_PAYMENT.includes(planCode) && !state.firstPaymentConfirmed && !state.hadTrial) return [];
  return features;
}

type Db = PrismaClient | Prisma.TransactionClient;

// 판매자의 기능 권한. 구독 행이 없으면(승인 뒤 카드 미등록) 판매자 플랜(Seller.planId, 없으면 DEFAULT_PLAN_CODE)으로 본다.
// 판정에 시각은 쓰지 않는다(_now는 가드가 넘기는 시험 시각, 잠금 판정은 access.ts).
export async function sellerFeatures(db: Db, sellerId: string, _now?: Date): Promise<readonly Feature[]> {
  const seller = await db.seller.findUnique({
    where: { id: sellerId },
    select: { trialEndsAt: true, plan: { select: { code: true } }, subscription: { select: { plan: { select: { code: true } } } } },
  });
  if (!seller) return [];
  const planCode = seller.subscription?.plan.code ?? seller.plan?.code ?? DEFAULT_PLAN_CODE;
  if (!AFTER_FIRST_PAYMENT.includes(planCode) || seller.trialEndsAt) return planFeatures(planCode, { firstPaymentConfirmed: false, hadTrial: !!seller.trialEndsAt });
  const paid = await db.subscriptionPayment.findFirst({ where: { sellerId, status: "PAID" }, select: { id: true } });
  return planFeatures(planCode, { firstPaymentConfirmed: !!paid, hadTrial: false });
}

export async function sellerHasFeature(db: Db, sellerId: string, feature: Feature, now?: Date): Promise<boolean> {
  return (await sellerFeatures(db, sellerId, now)).includes(feature);
}
