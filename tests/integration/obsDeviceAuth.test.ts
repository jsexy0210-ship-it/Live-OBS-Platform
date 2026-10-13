import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { db, resetDb, createSeller, createSellerUser } from "./helpers";
import { prisma } from "../../lib/server/db";
import type { TenantContext } from "../../lib/server/tenant/context";
import { hashToken } from "../../lib/server/auth/token";
import { readObsDeviceAuthentication } from "../../lib/server/obs/auth";
import { createObsPairingChallenge, approveObsPairingChallenge, consumeObsPairingChallenge, revokeObsDevice, OBS_PAIRING_CONSENT_VERSION as version } from "../../lib/server/obs/pairing";

beforeEach(() => resetDb());
afterAll(async () => { await db.$disconnect(); await prisma.$disconnect(); });
async function fixture(overlay = false) {
  const { seller } = await createSeller();
  const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: overlay ? "OVERLAY_ONLY" : "INTEGRATED" } });
  await db.seller.update({ where: { id: seller.id }, data: { planId: plan.id, trialEndsAt: null } });
  const user = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorId: user.id, actorType: "SELLER_USER", isOwner: true, permissions: [], readOnly: false };
  const sub = await db.sellerSubscription.create({ data: { sellerId: seller.id, planId: plan.id, currentPeriodEnd: new Date(Date.now() + 3_600_000) } });
  await db.subscriptionPayment.create({ data: { sellerId: seller.id, subscriptionId: sub.id, amount: 100_000, status: "PAID", paidAt: new Date(), periodStart: new Date(), periodEnd: sub.currentPeriodEnd! } });
  const job = overlay ? await install(ctx) : null;
  const c = await createObsPairingChallenge(db);
  await approveObsPairingChallenge(db, ctx, c.id, { confirmationCode: c.confirmationCode, consentVersion: version, ...(job ? { installJobId: job.id } : {}) });
  const r = await consumeObsPairingChallenge(db, c.id, c.verifier, { sellerId: seller.id, deviceId: c.deviceId, consentVersion: version });
  const input = { token: r.token, sellerId: r.sellerId, deviceId: r.deviceId, generation: r.generation };
  return { ctx, c, input, sub, job };
}
async function install(ctx: TenantContext, completed = false) {
  const p = await db.automationPayment.create({ data: { sellerId: ctx.sellerId, amount: 110_000, status: "PAID", paidAt: new Date(), idempotencyKey: randomUUID(), requestFingerprint: "device-auth-test", consentNoticeVersion: "2026-10-04", consentAgreedAt: new Date() } });
  return db.automationJob.create({ data: { sellerId: ctx.sellerId, paymentId: p.id, kind: "INITIAL", status: completed ? "SUCCEEDED" : "RUNNING", obsTargetKey: "obs:fixture", stepIndex: 2, fencingToken: 9, leaseOwner: completed ? null : "device-auth-test", leaseExpiresAt: completed ? null : new Date(Date.now() + 60_000), obsPairingId: "pc-fixture" } });
}

describe("기기 인증 adapter (폐기 PG 저장값, 실제 helper/명령 권한 아님)", () => {
  it("현재 결제 INTEGRATED만 확인하며 비밀·명령권한을 반환하거나 DB에 쓰지 않는다", async () => {
    const f = await fixture();
    const before = { devices: await db.obsDevice.findMany(), challenges: await db.obsPairingChallenge.findMany(), logs: await db.auditLog.findMany() };
    const r = await readObsDeviceAuthentication(db, f.input);
    expect(r).toEqual({ sellerId: f.input.sellerId, deviceId: f.input.deviceId, generation: 1, state: "authenticated_transport_unavailable", entitlement: "INTEGRATED_BASIC", job: null });
    expect(Object.isFrozen(r)).toBe(true);
    for (const secret of [f.input.token, hashToken(f.input.token), f.ctx.actorId]) expect(JSON.stringify(r)).not.toContain(secret);
    expect(r).not.toHaveProperty("authority"); expect(r).not.toHaveProperty("epoch");
    expect({ devices: await db.obsDevice.findMany(), challenges: await db.obsPairingChallenge.findMany(), logs: await db.auditLog.findMany() }).toEqual(before);
  });
  it.each(["token", "seller", "device", "generation"])("다른 %s는 인증하지 않는다", async field => {
    const f = await fixture();
    const input = { ...f.input, ...(field === "token" ? { token: "A".repeat(43) } : field === "seller" ? { sellerId: randomUUID() } : field === "device" ? { deviceId: randomUUID() } : { generation: 2 }) };
    await expect(readObsDeviceAuthentication(db, input)).rejects.toMatchObject({ status: 401, code: "obs_device_unverified" });
  });
  it("다른 실제 판매자의 정상 credential도 교차 조합할 수 없다", async () => {
    const f = await fixture(); const other = await fixture();
    await expect(readObsDeviceAuthentication(db, { ...f.input, token: other.input.token })).rejects.toMatchObject({ status: 401 });
  });
  it("철회 이후 이전 credential과 generation은 사용할 수 없다", async () => {
    const f = await fixture(); await revokeObsDevice(db, f.ctx, f.input.deviceId, 1);
    await expect(readObsDeviceAuthentication(db, f.input)).rejects.toMatchObject({ status: 401 });
  });
  it("재페어링은 이전 secret을 회수하고 새 세대의 소비 근거만 인정한다", async () => {
    const f = await fixture(); const c = await createObsPairingChallenge(db);
    const a = await approveObsPairingChallenge(db, f.ctx, c.id, { confirmationCode: c.confirmationCode, consentVersion: version, replacesChallengeId: f.c.id });
    await expect(readObsDeviceAuthentication(db, f.input)).rejects.toMatchObject({ status: 401 });
    const r = await consumeObsPairingChallenge(db, c.id, c.verifier, { sellerId: a.sellerId, deviceId: a.deviceId, consentVersion: version });
    expect(await readObsDeviceAuthentication(db, { token: r.token, sellerId: r.sellerId, deviceId: r.deviceId, generation: r.generation })).toMatchObject({ generation: 2, entitlement: "INTEGRATED_BASIC" });
  });
  it.each(["inactive", "not_owner", "seller_inactive", "expired", "unpaid"])("현재 %s 저장값은 이전 등록을 무효화한다", async change => {
    const f = await fixture();
    if (change === "inactive") await db.sellerUser.update({ where: { id: f.ctx.actorId }, data: { status: "DISABLED" } });
    if (change === "not_owner") await db.sellerUser.update({ where: { id: f.ctx.actorId }, data: { isOwner: false } });
    if (change === "seller_inactive") await db.seller.update({ where: { id: f.ctx.sellerId }, data: { status: "SUSPENDED" } });
    if (change === "expired") await db.sellerSubscription.update({ where: { id: f.sub.id }, data: { currentPeriodEnd: new Date(0) } });
    if (change === "unpaid") await db.subscriptionPayment.updateMany({ where: { sellerId: f.ctx.sellerId }, data: { status: "FAILED" } });
    await expect(readObsDeviceAuthentication(db, f.input)).rejects.toMatchObject({ status: 403 });
  });
  it("기존 이전 체험·유예 계약을 reader 그대로 유지한다", async () => {
    const f = await fixture();
    await db.subscriptionPayment.updateMany({ where: { sellerId: f.ctx.sellerId }, data: { status: "FAILED" } });
    await db.seller.update({ where: { id: f.ctx.sellerId }, data: { trialEndsAt: new Date(Date.now() + 60_000) } });
    expect(await readObsDeviceAuthentication(db, f.input)).toMatchObject({ entitlement: "INTEGRATED_BASIC" });
    await db.seller.update({ where: { id: f.ctx.sellerId }, data: { trialEndsAt: new Date(0) } });
    await db.sellerSubscription.update({ where: { id: f.sub.id }, data: { currentPeriodEnd: new Date(0), status: "PAST_DUE", graceUntil: new Date(Date.now() + 60_000) } });
    expect(await readObsDeviceAuthentication(db, f.input)).toMatchObject({ entitlement: "INTEGRATED_BASIC" });
  });
  it("완료 소비 근거 없는 직접 저장 기기는 허용하지 않는다", async () => {
    const f = await fixture(); await db.obsPairingChallenge.update({ where: { id: f.c.id }, data: { consumedAt: null } });
    await expect(readObsDeviceAuthentication(db, f.input)).rejects.toMatchObject({ status: 401 });
  });
  it("OVERLAY로 변경하면 미정 지속 제어는 거부하되 수동 이용권을 변경하지 않는다", async () => {
    const f = await fixture(); const p = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "OVERLAY_ONLY" } });
    await db.sellerSubscription.update({ where: { id: f.sub.id }, data: { planId: p.id } });
    expect(await readObsDeviceAuthentication(db, f.input)).toMatchObject({ state: "control_denied_support_required", entitlement: null });
  });
  it("PAID INITIAL은 등록에 묶인 job의 현재 fence/lease만 관측한다", async () => {
    const f = await fixture(true); const input = { ...f.input, installJobId: f.job!.id, jobFence: 9 };
    const r = await readObsDeviceAuthentication(db, input);
    expect(r).toMatchObject({ entitlement: "PAID_INITIAL_INSTALL", job: { id: f.job!.id, fence: 9 } });
    expect("job" in r && Object.isFrozen(r.job)).toBe(true);
    const other = await install(f.ctx, true);
    await expect(readObsDeviceAuthentication(db, { ...input, installJobId: other.id })).rejects.toMatchObject({ code: "obs_job_scope_denied" });
    await db.automationJob.update({ where: { id: f.job!.id }, data: { fencingToken: 10 } });
    await expect(readObsDeviceAuthentication(db, input)).rejects.toMatchObject({ code: "obs_job_scope_denied" });
    expect(await readObsDeviceAuthentication(db, { ...input, jobFence: 10 })).toMatchObject({ generation: 1, job: { fence: 10 } });
  });
  it.each(["completed", "canceled", "lease", "refunded", "revoked"])("INITIAL %s는 인증 credential을 지속 권리로 승격하지 않는다", async change => {
    const f = await fixture(true); const j = f.job!;
    if (change === "completed" || change === "canceled") await db.automationJob.update({ where: { id: j.id }, data: { status: change === "completed" ? "SUCCEEDED" : "CANCELED", leaseOwner: null, leaseExpiresAt: null } });
    if (change === "lease") await db.automationJob.update({ where: { id: j.id }, data: { leaseExpiresAt: new Date(0) } });
    if (change === "refunded") await db.automationPayment.update({ where: { id: j.paymentId! }, data: { status: "REFUNDED" } });
    if (change === "revoked") await db.automationJob.update({ where: { id: j.id }, data: { connectionRevokedAt: new Date() } });
    await expect(readObsDeviceAuthentication(db, { ...f.input, installJobId: j.id, jobFence: 9 })).rejects.toMatchObject({ status: 403 });
    expect(await readObsDeviceAuthentication(db, f.input)).toMatchObject({ state: "control_denied_support_required", entitlement: null });
  });
  it.each(["paid", "planCode", "actorId"])("클라이언트 %s 주장 입력은 사용하지 않는다", async key => {
    const f = await fixture();
    await expect(readObsDeviceAuthentication(db, { ...f.input, [key]: true })).rejects.toMatchObject({ status: 401 });
  });
  it("DB 실패는 비밀·query를 재출력하지 않고 안전하게 거부한다", async () => {
    const input = { token: "A".repeat(43), sellerId: randomUUID(), deviceId: randomUUID(), generation: 1 };
    const broken = { $transaction: async () => { throw new Error(`query contains ${input.token}`); } } as unknown as PrismaClient;
    await expect(readObsDeviceAuthentication(broken, input)).rejects.toMatchObject({ status: 503, message: "obs_device_auth_unavailable" });
  });
});
