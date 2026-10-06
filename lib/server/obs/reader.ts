import { Prisma, type PrismaClient } from "@prisma/client";
import { DEFAULT_PLAN_CODE } from "../billing/subscription";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { isJobId } from "../automation/ids";
import { obsAccountAccess, obsInitialInstallValid, type ObsAccountRecords } from "./contract";

const sellerSelect = {
  id: true, status: true, trialEndsAt: true,
  plan: { select: { code: true } },
  subscription: { select: {
    sellerId: true, status: true, currentPeriodEnd: true, nextChargeAt: true, graceUntil: true, cancelAtPeriodEnd: true,
    plan: { select: { code: true } },
  } },
} satisfies Prisma.SellerSelect;
const jobSelect = {
  id: true, sellerId: true, paymentId: true, kind: true, status: true, stepIndex: true, fencingToken: true,
  leaseExpiresAt: true, obsPairingId: true, cancelRequestedAt: true, connectionRevokedAt: true,
  payment: { select: { id: true, sellerId: true, status: true, amount: true, paidAt: true } },
} satisfies Prisma.AutomationJobSelect;

export type ObsConnectionEligibility = {
  // 자격 조회 결과이지 ObsAuthority가 아니다. 현재 schema에는 지속 기기 인증 저장소가 없다.
  state: "pairing_required";
  entitlement: "INTEGRATED_BASIC" | "PAID_INITIAL_INSTALL";
  records: ObsAccountRecords;
} | { state: "manual_only"; entitlement: null };

// ctx는 기존 인증된 서버 세션에서 얻는다. 요청의 plan/paid/device 값을 받지 않는다.
// 읽기 전용 repeatable-read로 플랜·결제·작업을 같은 DB 스냅숏에서 읽는다.
// 반환 결과를 명령에 쓰려면 별도의 실제 기기 인증과 현재 job fencing 대조가 필요하다.
export async function readObsConnectionEligibility(
  db: PrismaClient, ctx: TenantContext, now: Date, installJobId?: string,
): Promise<ObsConnectionEligibility> {
  requireSellerPermission(ctx, "OVERLAY_EDIT");
  if (!Number.isFinite(now.getTime())) throw new Error("obs_access_denied");
  if (installJobId !== undefined && !isJobId(installJobId)) throw new Error("obs_purchase_unverified");
  return db.$transaction(async tx => {
    const seller = await tx.seller.findUnique({ where: { id: ctx.sellerId }, select: sellerSelect });
    if (!seller) throw new Error("obs_access_denied");
    const planCode = seller.subscription?.plan.code ?? seller.plan?.code ?? DEFAULT_PLAN_CODE;
    // 기존 sellerFeatures와 동일하게 판매자에게 확정된 PAID 청구가 있는지 조회한다.
    const firstPayment = await tx.subscriptionPayment.findFirst({
      where: { sellerId: ctx.sellerId, status: "PAID" }, select: { sellerId: true, status: true },
    });
    const records: ObsAccountRecords = {
      seller: { id: seller.id, status: seller.status, trialEndsAt: seller.trialEndsAt },
      planCode, subscription: seller.subscription ? {
        sellerId: seller.subscription.sellerId, status: seller.subscription.status,
        currentPeriodEnd: seller.subscription.currentPeriodEnd, nextChargeAt: seller.subscription.nextChargeAt,
        graceUntil: seller.subscription.graceUntil, cancelAtPeriodEnd: seller.subscription.cancelAtPeriodEnd,
      } : null,
      firstPayment, install: null,
    };
    obsAccountAccess(records, ctx.sellerId, now);
    if (planCode === "INTEGRATED") return { state: "pairing_required", entitlement: "INTEGRATED_BASIC", records };
    if (planCode !== "OVERLAY_ONLY") throw new Error("obs_purchase_required");
    // 오버레이 URL의 수동 사용권은 그대로다. 유료 설치를 요청하지 않으면 기기 권한을 만들지 않는다.
    if (!installJobId) return { state: "manual_only", entitlement: null };
    if (!ctx.isOwner) throw new Error("obs_purchase_required");
    const job = await tx.automationJob.findFirst({ where: { id: installJobId, sellerId: ctx.sellerId }, select: jobSelect });
    if (!job?.payment) throw new Error("obs_purchase_unverified");
    const { payment, ...jobRecords } = job;
    records.install = { payment, job: jobRecords };
    if (!obsInitialInstallValid(records.install, ctx.sellerId, installJobId, now)) throw new Error("obs_purchase_unverified");
    // fencingToken/obsPairingId는 임시 작업의 근거일 뿐 persistent device로 변환하지 않는다.
    // SUCCEEDED·REINSTALL·RECONNECT_FREE의 기존 지속/재설치 권리는 변경하거나 부정하지 않는다.
    return { state: "pairing_required", entitlement: "PAID_INITIAL_INSTALL", records };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
