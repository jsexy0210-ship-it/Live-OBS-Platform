import { describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import { readObsConnectionEligibility } from "../../lib/server/obs/reader";
import type { TenantContext } from "../../lib/server/tenant/context";

const now = new Date("2026-10-07T00:00:00Z");
const future = () => new Date(now.getTime() + 60_000);
const jobId = "11111111-1111-4111-8111-111111111111";
const ctx: TenantContext = { sellerId: "seller-a", actorId: "owner-a", actorType: "SELLER_USER", isOwner: true, permissions: [], readOnly: false };
const sellerRow = () => ({ id: ctx.sellerId, status: "ACTIVE", trialEndsAt: null as Date | null, plan: { code: "OVERLAY_ONLY" }, subscription: {
  sellerId: ctx.sellerId, status: "ACTIVE", currentPeriodEnd: future() as Date | null,
  nextChargeAt: null as Date | null, graceUntil: null as Date | null, cancelAtPeriodEnd: false, plan: { code: "INTEGRATED" },
} });
const jobRow = () => ({ id: jobId, sellerId: ctx.sellerId, paymentId: "payment-a", kind: "INITIAL", status: "RUNNING", stepIndex: 2,
  fencingToken: 3, leaseExpiresAt: future(), obsPairingId: "pc-a", cancelRequestedAt: null as Date | null, connectionRevokedAt: null as Date | null,
  payment: { id: "payment-a", sellerId: ctx.sellerId, status: "PAID", amount: 110_000, paidAt: now as Date | null },
});
function dbFixture() {
  // Prisma delegates만 모의한다. 실제 DB snapshot/SQL/인증·기기 연결 증거가 아니다.
  const seller = sellerRow();
  const job = jobRow();
  const tx = {
    seller: { findUnique: vi.fn(async () => seller) },
    subscriptionPayment: { findFirst: vi.fn(async (): Promise<{ sellerId: string; status: "PAID" } | null> => ({ sellerId: ctx.sellerId, status: "PAID" })) },
    automationJob: { findFirst: vi.fn(async () => job) },
  };
  const transaction = vi.fn(async (read: (client: typeof tx) => Promise<unknown>, _options: { isolationLevel: Prisma.TransactionIsolationLevel }) => read(tx));
  const db = { $transaction: transaction } as unknown as PrismaClient;
  return { db, tx, transaction, seller, job };
}
async function paidFixture() {
  const f = dbFixture(); f.seller.subscription.plan.code = "OVERLAY_ONLY";
  return f;
}

describe("DB OBS 자격 reader (Prisma delegate 모의, 지속 기기 권한 미발급)", () => {
  it("구독 플랜을 우선하고 같은 스냅숏에서 최소 저장필드만 읽는다", async () => {
    const f = dbFixture();
    const result = await readObsConnectionEligibility(f.db, ctx, now);
    expect(result).toMatchObject({ state: "pairing_required", entitlement: "INTEGRATED_BASIC", records: { planCode: "INTEGRATED" } });
    expect(f.transaction.mock.calls[0][1]).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    expect(f.tx.seller.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ctx.sellerId } }));
    expect(f.tx.subscriptionPayment.findFirst).toHaveBeenCalledWith({ where: { sellerId: ctx.sellerId, status: "PAID" }, select: { sellerId: true, status: true } });
    expect(f.tx.automationJob.findFirst).not.toHaveBeenCalled();
    expect(JSON.stringify(f.tx.seller.findUnique.mock.calls)).not.toMatch(/billingKey|Cipher|email/);
    expect(result).not.toHaveProperty("device"); expect(result).not.toHaveProperty("authority");
  });
  it("오버레이만으로는 자동 연결을 열지 않고 수동 사용을 유지한다", async () => {
    const f = await paidFixture();
    expect(await readObsConnectionEligibility(f.db, ctx, now)).toEqual({ state: "manual_only", entitlement: null });
    expect(f.tx.automationJob.findFirst).not.toHaveBeenCalled();
  });
  it("저장된 110000원 PAID INITIAL과 현재 lease를 확인하되 기기로 승격하지 않는다", async () => {
    const f = await paidFixture();
    const result = await readObsConnectionEligibility(f.db, ctx, now, jobId);
    expect(result).toMatchObject({ state: "pairing_required", entitlement: "PAID_INITIAL_INSTALL", records: { install: { job: { fencingToken: 3, obsPairingId: "pc-a" } } } });
    expect(f.tx.automationJob.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: jobId, sellerId: ctx.sellerId } }));
    if (result.state === "pairing_required") {
      expect(result.records).not.toHaveProperty("device");
      expect(result.records).not.toHaveProperty("explicitInput");
    }
  });
  it("클라이언트 plan/paid 힌트가 붙어도 DB 미결제 근거를 덮지 못한다", async () => {
    const f = dbFixture(); f.tx.subscriptionPayment.findFirst.mockResolvedValue(null);
    const clientHints = { ...ctx, planCode: "INTEGRATED", paid: true };
    await expect(readObsConnectionEligibility(f.db, clientHints, now)).rejects.toThrow("obs_access_denied");
  });
  it.each(["PENDING", "SUSPENDED", "REJECTED"])("판매자 %s 상태는 차단한다", async status => {
    const f = dbFixture(); f.seller.status = status;
    await expect(readObsConnectionEligibility(f.db, ctx, now)).rejects.toThrow("obs_access_denied");
  });
  it("만료는 차단하고 기존 유예·결제한 해지예약 기간은 유지한다", async () => {
    const f = dbFixture(); f.seller.subscription.currentPeriodEnd = now;
    await expect(readObsConnectionEligibility(f.db, ctx, now)).rejects.toThrow("obs_access_denied");
    f.seller.subscription.status = "PAST_DUE"; f.seller.subscription.graceUntil = future();
    expect(await readObsConnectionEligibility(f.db, ctx, now)).toMatchObject({ entitlement: "INTEGRATED_BASIC" });
    f.seller.subscription.currentPeriodEnd = future(); f.seller.subscription.cancelAtPeriodEnd = true;
    expect(await readObsConnectionEligibility(f.db, ctx, now)).toMatchObject({ entitlement: "INTEGRATED_BASIC" });
  });
  it("기존 이전 체험은 유지하며 구독 없는 경우 seller 플랜으로 판정한다", async () => {
    const f = dbFixture(); f.tx.subscriptionPayment.findFirst.mockResolvedValue(null);
    f.seller.trialEndsAt = future();
    expect(await readObsConnectionEligibility(f.db, ctx, now)).toMatchObject({ entitlement: "INTEGRATED_BASIC" });
    f.tx.seller.findUnique.mockResolvedValue({ ...f.seller, subscription: null } as unknown as ReturnType<typeof sellerRow>);
    expect(await readObsConnectionEligibility(f.db, ctx, now)).toEqual({ state: "manual_only", entitlement: null });
  });
  it("교차 seller·구독·청구 반환값도 명시적으로 거부한다", async () => {
    for (const target of ["seller", "subscription", "payment"]) {
      const f = dbFixture();
      if (target === "seller") f.seller.id = "seller-b";
      if (target === "subscription") f.seller.subscription.sellerId = "seller-b";
      if (target === "payment") f.tx.subscriptionPayment.findFirst.mockResolvedValue({ sellerId: "seller-b", status: "PAID" });
      await expect(readObsConnectionEligibility(f.db, ctx, now)).rejects.toThrow("obs_access_denied");
    }
  });
  it.each(["PENDING", "FAILED", "REFUND_PENDING", "REFUNDED"])("자동연결 결제 %s는 자격을 주지 않는다", async status => {
    const f = await paidFixture(); f.job.payment.status = status;
    await expect(readObsConnectionEligibility(f.db, ctx, now, jobId)).rejects.toThrow("obs_purchase_unverified");
  });
  it.each(["QUEUED", "CANCELED", "FAILED", "SUCCEEDED"])("%s job를 새 임시 설치 권한으로 바꾸지 않는다", async status => {
    const f = await paidFixture(); f.job.status = status;
    await expect(readObsConnectionEligibility(f.db, ctx, now, jobId)).rejects.toThrow("obs_purchase_unverified");
  });
  it("VERIFYING 허용, tenant·결제 연결·금액·시각·취소·회수·lease 반례는 차단한다", async () => {
    const ok = await paidFixture(); ok.job.status = "VERIFYING";
    expect(await readObsConnectionEligibility(ok.db, ctx, now, jobId)).toMatchObject({ entitlement: "PAID_INITIAL_INSTALL" });
    for (const change of [
      (j: ReturnType<typeof jobRow>) => { j.sellerId = "seller-b"; },
      (j: ReturnType<typeof jobRow>) => { j.id = "other-job"; },
      (j: ReturnType<typeof jobRow>) => { j.payment.sellerId = "seller-b"; },
      (j: ReturnType<typeof jobRow>) => { j.paymentId = "other-payment"; },
      (j: ReturnType<typeof jobRow>) => { j.payment.amount = 33_000; },
      (j: ReturnType<typeof jobRow>) => { j.payment.paidAt = null; },
      (j: ReturnType<typeof jobRow>) => { j.payment.paidAt = future(); },
      (j: ReturnType<typeof jobRow>) => { j.cancelRequestedAt = now; },
      (j: ReturnType<typeof jobRow>) => { j.connectionRevokedAt = now; },
      (j: ReturnType<typeof jobRow>) => { j.leaseExpiresAt = now; },
      (j: ReturnType<typeof jobRow>) => { j.kind = "REINSTALL"; },
      (j: ReturnType<typeof jobRow>) => { j.kind = "RECONNECT_FREE"; },
    ]) {
      const f = await paidFixture(); change(f.job);
      await expect(readObsConnectionEligibility(f.db, ctx, now, jobId)).rejects.toThrow("obs_purchase_unverified");
    }
  });
  it("권한·잘못된 job·시각은 조회 전 차단하고 유료설치는 대표자만 조회한다", async () => {
    const f = await paidFixture();
    for (const actor of [{ ...ctx, readOnly: true }, { ...ctx, isOwner: false }]) {
      await expect(readObsConnectionEligibility(f.db, actor, now)).rejects.toThrow();
    }
    await expect(readObsConnectionEligibility(f.db, ctx, now, "paid=true")).rejects.toThrow("obs_purchase_unverified");
    await expect(readObsConnectionEligibility(f.db, ctx, new Date(NaN))).rejects.toThrow("obs_access_denied");
    expect(f.transaction).not.toHaveBeenCalled();
    const staff = { ...ctx, isOwner: false, permissions: ["OVERLAY_EDIT"] as const };
    expect(await readObsConnectionEligibility(f.db, staff, now)).toMatchObject({ state: "manual_only" });
    await expect(readObsConnectionEligibility(f.db, staff, now, jobId)).rejects.toThrow("obs_purchase_required");
  });
  it("DB 오류를 자격 허용으로 바꾸지 않는다", async () => {
    const f = dbFixture(); f.tx.seller.findUnique.mockRejectedValue(new Error("db_unavailable"));
    await expect(readObsConnectionEligibility(f.db, ctx, now)).rejects.toThrow("db_unavailable");
  });
});
