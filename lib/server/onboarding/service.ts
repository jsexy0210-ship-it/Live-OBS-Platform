import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { sellerPlanOf } from "../billing/subscription";
import { forbidden } from "../authz/errors";
import { sellerCan } from "../authz/permissions";
import { requireSellerPermission, type TenantContext } from "../tenant/context";

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
  shop_info: "/seller/settings/shop",
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
export const TRACK_MESSAGES = {
  invalid_track: "쇼핑몰까지 쓰기와 방송 화면만 쓰기 중에서 골라 주십시오",
  track_locked: "이용권을 결제한 뒤에는 구독 화면의 플랜 바꾸기에서 바꿀 수 있습니다",
  plan_missing: "이용권 정보를 찾지 못했습니다. 잠시 뒤 다시 시도해 주십시오",
} as const;
export type OnboardingAction = (typeof ACTIONS)[number];

export async function getOnboarding(db: PrismaClient, ctx: TenantContext) {
  const sid = ctx.sellerId;
  const plan = await sellerPlanOf(db, sid);
  const track = TRACKS.find((t) => t === plan?.code) ?? null;
  const [state, seller, paid, products, orderPolicy, layout, shops, subscription] = await Promise.all([
    db.sellerOnboarding.findUnique({ where: { sellerId: sid } }),
    db.seller.findUniqueOrThrow({ where: { id: sid }, select: { shareTitle: true, shopTagline: true, slug: true, trialEndsAt: true } }),
    db.subscriptionPayment.count({ where: { sellerId: sid, status: "PAID" } }),
    db.product.count({ where: { sellerId: sid, deletedAt: null } }),
    db.sellerOrderPolicy.count({ where: { sellerId: sid } }),
    db.overlayLayout.count({ where: { sellerId: sid } }),
    db.externalShopConnection.count({ where: { sellerId: sid, status: "CONNECTED" } }),
    db.sellerSubscription.findUnique({ where: { sellerId: sid }, select: { status: true, billingKeyCipher: true } }),
  ]);
  const done: Record<StepKey, boolean> = {
    subscription: paid > 0,
    shop_info: !!seller.shareTitle?.trim() || !!seller.shopTagline?.trim(),
    products: products > 0,
    order_policy: orderPolicy > 0,
    overlay: layout > 0,
    overlay_url: !!state?.overlayUrlCopiedAt,
    external_shop: shops > 0,
  };
  // status: DONE 완료 · CURRENT 지금 할 차례(첫 미완료) · WAITING 기다리는 중(그 뒤 단계). 화면의 상태 3종(SA-003)과 같다.
  const keysOfTrack = track ? STEPS[track] : [];
  const firstOpen = keysOfTrack.find((key) => !done[key]);
  const steps = keysOfTrack.map((key) => ({ key, done: done[key], status: done[key] ? ("DONE" as const) : key === firstOpen ? ("CURRENT" as const) : ("WAITING" as const), href: STEP_HREF[key] }));
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
    // 시작하기는 대표자만 본다(직원 화면은 홈으로 보낸다, SA-003). 갈래 바꾸기는 첫 결제·카드 등록 전까지(trackChangeable).
    isOwner: ctx.isOwner,
    trackChangeable: track !== null && !subscription,
    // 「지금 상태」 요약(SA-003): 이용권·쇼핑몰 주소·결제 연결·상품 수·방송 화면 주소 복사 여부
    summary: {
      plan: { code: plan?.code ?? null, name: plan?.name ?? null, paid: paid > 0 },
      shopSlug: seller.slug,
      billingConnected: !!subscription?.billingKeyCipher,
      productCount: products,
      overlayUrlCopied: !!state?.overlayUrlCopiedAt,
    },
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

// 갈래 바꾸기(SA-003 「어떻게 쓰시겠습니까?」, SA-004 흡수). 갈래 = 판매자 플랜(쇼핑몰 통합 / 오버레이 전용). 승인된 쇼핑몰이
// 구독(카드 등록·결제)을 만들기 전까지만 여기서 바꾼다. 그 뒤에는 금액이 걸리므로 구독 화면의 플랜 바꾸기(changePlan)로 한다(409 track_locked).
// 체험 종료일은 승인 시각 + 새 플랜의 체험 일수로 다시 정한다(체험 없는 플랜이면 비움). 바꿔서 체험이 늘어나지 않게 승인일 기준이다.
// 대표자·구독 관리 권한만(SUBSCRIPTION_MANAGE). 로그 추적 onboarding.track_change(before/after).
export async function changeTrack(db: PrismaClient, ctx: TenantContext, rawTrack: unknown) {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  const track = TRACKS.find((t) => t === rawTrack);
  if (!track) return { ok: false as const, reason: "invalid_track" as const };
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`seller_plan:${ctx.sellerId}`}))`;
    const seller = await tx.seller.findUniqueOrThrow({ where: { id: ctx.sellerId }, select: { status: true, planId: true, approvedAt: true, trialEndsAt: true, plan: { select: { code: true } } } });
    if (seller.status !== "ACTIVE") throw forbidden();
    const target = await tx.subscriptionPlan.findUnique({ where: { code: track } });
    if (!target) return { ok: false as const, reason: "plan_missing" as const };
    if (await tx.sellerSubscription.findUnique({ where: { sellerId: ctx.sellerId }, select: { id: true } })) return { ok: false as const, reason: "track_locked" as const };
    if (seller.planId === target.id) return { ok: true as const, track, changed: false };
    const trialEndsAt = target.trialDays > 0 && seller.approvedAt ? new Date(seller.approvedAt.getTime() + target.trialDays * 86_400_000) : null;
    await tx.seller.update({ where: { id: ctx.sellerId }, data: { planId: target.id, trialEndsAt } });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "onboarding.track_change",
      targetType: "Seller",
      targetId: ctx.sellerId,
      before: { planCode: seller.plan?.code ?? null, trialEndsAt: seller.trialEndsAt },
      after: { planCode: target.code, trialEndsAt },
    });
    return { ok: true as const, track, changed: true };
  });
}
