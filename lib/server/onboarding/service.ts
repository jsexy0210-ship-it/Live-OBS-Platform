import type { PrismaClient } from "@prisma/client";
import { sellerPlanOf } from "../billing/subscription";
import { forbidden } from "../authz/errors";
import { sellerCan } from "../authz/permissions";
import type { TenantContext } from "../tenant/context";

// 시작하기(SA-003)·온보딩(SA-004) 체크리스트. 플랜은 가입 신청 때 정해져 있고(오버레이 전용 = 지금 운영 중인 쇼핑몰이 있음, 쇼핑몰 통합 = 없음)
// 로그인 뒤 그 갈래의 단계를 이어 간다. 단계 완료는 기존 데이터에서 그때그때 계산한다(나갔다 돌아와도 currentStep이 첫 미완료 단계로 이어진다).
// - 쇼핑몰 통합: subscription(첫 구독 결제 확정) → shop_info(쇼핑몰 공유 문구) → products(상품 1개 이상) → order_policy(주문 정책 저장) → overlay(오버레이 배치 저장) → overlay_url(주소 복사)
// - 오버레이 전용: external_shop(외부 쇼핑몰 연결 중) → overlay → overlay_url
// - PG 연결 단계는 두지 않는다(결제대행사 키는 플랫폼이 하나로 받는다, 2026-10-05 대표님 결정).
// 저장하는 것은 SellerOnboarding의 overlayUrlCopiedAt(주소 복사 눌렀음)과 dismissedAt(닫음)뿐. 조회는 파트너스 계정 누구나, 바꾸기는 대표자·쇼핑몰 설정 직원.
export const TRACKS = ["INTEGRATED", "OVERLAY_ONLY"] as const;
export type Track = (typeof TRACKS)[number];
export type StepKey = "subscription" | "shop_info" | "products" | "order_policy" | "overlay" | "overlay_url" | "external_shop";
export const STEP_HREF: Record<StepKey, string> = {
  subscription: "/seller/subscription",
  shop_info: "/seller/settings/share",
  products: "/seller/products",
  order_policy: "/seller/settings/order",
  overlay: "/seller/overlay",
  overlay_url: "/seller/overlay",
  external_shop: "/seller/external-shops",
};
const STEPS: Record<Track, readonly StepKey[]> = {
  INTEGRATED: ["subscription", "shop_info", "products", "order_policy", "overlay", "overlay_url"],
  OVERLAY_ONLY: ["external_shop", "overlay", "overlay_url"],
};
export const ACTIONS = ["overlay_url_copied", "dismiss", "reopen"] as const;
export type OnboardingAction = (typeof ACTIONS)[number];

export async function getOnboarding(db: PrismaClient, ctx: TenantContext) {
  const sid = ctx.sellerId;
  const plan = await sellerPlanOf(db, sid);
  const track = TRACKS.find((t) => t === plan?.code) ?? null;
  const [state, seller, paid, products, orderPolicy, layout, shops] = await Promise.all([
    db.sellerOnboarding.findUnique({ where: { sellerId: sid } }),
    db.seller.findUniqueOrThrow({ where: { id: sid }, select: { shareTitle: true, trialEndsAt: true } }),
    db.subscriptionPayment.count({ where: { sellerId: sid, status: "PAID" } }),
    db.product.count({ where: { sellerId: sid, deletedAt: null } }),
    db.sellerOrderPolicy.count({ where: { sellerId: sid } }),
    db.overlayLayout.count({ where: { sellerId: sid } }),
    db.externalShopConnection.count({ where: { sellerId: sid, status: "CONNECTED" } }),
  ]);
  const done: Record<StepKey, boolean> = {
    subscription: paid > 0,
    shop_info: !!seller.shareTitle?.trim(),
    products: products > 0,
    order_policy: orderPolicy > 0,
    overlay: layout > 0,
    overlay_url: !!state?.overlayUrlCopiedAt,
    external_shop: shops > 0,
  };
  const steps = (track ? STEPS[track] : []).map((key) => ({ key, done: done[key], href: STEP_HREF[key] }));
  const next = steps.find((s) => !s.done);
  const completed = steps.length > 0 && !next;
  return {
    track,
    planCode: plan?.code ?? null,
    trialEndsAt: track === "OVERLAY_ONLY" ? seller.trialEndsAt : null,
    steps,
    doneCount: steps.filter((s) => s.done).length,
    total: steps.length,
    currentStep: next?.key ?? null,
    completed,
    // 닫았어도 새 단계가 생기지 않는 한 닫힌 채로 둔다. 모두 끝내면 따로 닫지 않아도 화면이 접는다(completed)
    dismissed: !!state?.dismissedAt,
  };
}

export async function updateOnboarding(db: PrismaClient, ctx: TenantContext, action: unknown, now = new Date()) {
  if (ctx.readOnly || !sellerCan(ctx, "SHOP_SETTINGS")) throw forbidden();
  if (!(ACTIONS as readonly unknown[]).includes(action)) return { ok: false as const, reason: "invalid_action" as const };
  const a = action as OnboardingAction;
  const data = a === "overlay_url_copied" ? { overlayUrlCopiedAt: now } : a === "dismiss" ? { dismissedAt: now } : { dismissedAt: null };
  await db.sellerOnboarding.upsert({ where: { sellerId: ctx.sellerId }, create: { sellerId: ctx.sellerId, ...data }, update: data });
  return { ok: true as const };
}
