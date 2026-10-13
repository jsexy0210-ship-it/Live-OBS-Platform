import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db, resetDb, createSeller, createSellerUser } from "./helpers";
import { prisma } from "../../lib/server/db";
import { hashToken } from "../../lib/server/auth/token";
import { createSellerSession } from "../../lib/server/auth/session";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createObsPairingChallenge, approveObsPairingChallenge, consumeObsPairingChallenge, revokeObsDevice, OBS_PAIRING_CONSENT_VERSION } from "../../lib/server/obs/pairing";
import { POST as approveRoute } from "../../app/api/seller/obs/pairing/challenges/[id]/approve/route";
import { POST as consumeRoute } from "../../app/api/obs/pairing/challenges/[id]/consume/route";
import { POST as createRoute } from "../../app/api/obs/pairing/challenges/route";

beforeEach(() => resetDb());
afterAll(async () => { await db.$disconnect(); await prisma.$disconnect(); });
const version = OBS_PAIRING_CONSENT_VERSION;
async function owner(planCode = "INTEGRATED") {
  const { seller } = await createSeller();
  const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: planCode } });
  await db.seller.update({ where: { id: seller.id }, data: { planId: plan.id } });
  const user = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorId: user.id, actorType: "SELLER_USER", isOwner: true, permissions: [], readOnly: false };
  return { ctx, user };
}
async function approved(ctx?: TenantContext) {
  const actor = ctx ?? (await owner()).ctx;
  const c = await createObsPairingChallenge(db);
  const a = await approveObsPairingChallenge(db, actor, c.id, { confirmationCode: c.confirmationCode, consentVersion: version });
  return { c, a, ctx: actor, input: { deviceId: a.deviceId, sellerId: actor.sellerId, consentVersion: version } };
}
async function paidInstall(ctx: TenantContext) {
  const p = await db.automationPayment.create({ data: { sellerId: ctx.sellerId, amount: 110_000, status: "PAID", paidAt: new Date(),
    idempotencyKey: randomUUID(), requestFingerprint: "pairing-test", consentNoticeVersion: "2026-10-04", consentAgreedAt: new Date() } });
  return db.automationJob.create({ data: { sellerId: ctx.sellerId, paymentId: p.id, kind: "INITIAL", status: "RUNNING", obsTargetKey: "obs:fixture", stepIndex: 2,
    fencingToken: 9, leaseOwner: "pairing-test", leaseExpiresAt: new Date(Date.now() + 60_000), obsPairingId: "pc-fixture" } });
}

describe("OBS 페어링 저장 계약 (실제 폐기 PG, PC 동의/helper/송출 검증 아님)", () => {
  it("고엔트로피 proof와 대표자 확인으로 등록하며 DB/로그에 원문 비밀을 남기지 않는다", async () => {
    const f = await approved();
    const r = await consumeObsPairingChallenge(db, f.c.id, f.c.verifier, f.input);
    expect(r.state).toBe("registered_commands_unavailable");
    const d = await db.obsDevice.findUniqueOrThrow({ where: { id: r.deviceId } });
    expect(d.tokenHash).toBe(hashToken(r.token)); expect(d.tokenHash).not.toBe(r.token);
    const rows = await db.obsPairingChallenge.findMany();
    const logs = await db.auditLog.findMany();
    for (const secret of [r.token, f.c.verifier, f.c.confirmationCode, hashToken(r.token), hashToken(f.c.verifier)]) {
      expect(JSON.stringify(logs)).not.toContain(secret);
    }
    expect(JSON.stringify(rows)).not.toContain(f.c.verifier);
    expect(JSON.stringify(rows)).not.toContain(f.c.confirmationCode);
    expect(logs.map(l => l.action)).toEqual(["obs.pairing.approved", "obs.pairing.consumed"]);
  });
  it("대표자만 또는 PC proof만으로는 등록하지 않는다", async () => {
    const c = await createObsPairingChallenge(db); const { ctx } = await owner();
    await expect(consumeObsPairingChallenge(db, c.id, c.verifier, { deviceId: c.deviceId, sellerId: ctx.sellerId, consentVersion: version })).rejects.toThrow();
    await approveObsPairingChallenge(db, ctx, c.id, { confirmationCode: c.confirmationCode, consentVersion: version });
    await expect(consumeObsPairingChallenge(db, c.id, true, { deviceId: c.deviceId, sellerId: ctx.sellerId, consentVersion: version })).rejects.toThrow();
    expect(await db.obsDevice.count()).toBe(0);
  });
  it("한 번 소비 후 재사용은 원문 credential을 반환하지 않는다", async () => {
    const f = await approved(); await consumeObsPairingChallenge(db, f.c.id, f.c.verifier, f.input);
    await expect(consumeObsPairingChallenge(db, f.c.id, f.c.verifier, f.input)).rejects.toThrow();
    expect(await db.obsDevice.count()).toBe(1);
  });
  it("동시 consume은 하나만 성공하고 하나의 기기·소비 로그만 남긴다", async () => {
    const f = await approved();
    const result = await Promise.allSettled(Array.from({ length: 4 }, () => consumeObsPairingChallenge(db, f.c.id, f.c.verifier, f.input)));
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.obsDevice.count()).toBe(1);
    expect(await db.auditLog.count({ where: { action: "obs.pairing.consumed" } })).toBe(1);
  });
  it("만료 경계는 승인·소비 양쪽에서 차단한다", async () => {
    const { ctx } = await owner(); const c = await createObsPairingChallenge(db);
    await db.obsPairingChallenge.update({ where: { id: c.id }, data: { expiresAt: new Date(0) } });
    await expect(approveObsPairingChallenge(db, ctx, c.id, { confirmationCode: c.confirmationCode, consentVersion: version })).rejects.toThrow();
    const f = await approved(ctx);
    await db.obsPairingChallenge.update({ where: { id: f.c.id }, data: { expiresAt: new Date(0) } });
    await expect(consumeObsPairingChallenge(db, f.c.id, f.c.verifier, f.input)).rejects.toThrow();
  });
  it("교차 seller/device/challenge proof는 거부한다", async () => {
    const f = await approved(); const other = await approved();
    for (const input of [{ ...f.input, sellerId: other.ctx.sellerId }, { ...f.input, deviceId: other.a.deviceId }]) {
      await expect(consumeObsPairingChallenge(db, f.c.id, f.c.verifier, input)).rejects.toThrow();
    }
    await expect(consumeObsPairingChallenge(db, f.c.id, other.c.verifier, f.input)).rejects.toThrow();
    await expect(approveObsPairingChallenge(db, other.ctx, f.c.id, { confirmationCode: f.c.confirmationCode, consentVersion: version })).rejects.toThrow();
    expect(await db.obsDevice.count()).toBe(0);
  });
  it("다른 PC 확인정보·동의 버전은 승인하지 않는다", async () => {
    const { ctx } = await owner(); const c = await createObsPairingChallenge(db); const other = await createObsPairingChallenge(db);
    for (const input of [{ confirmationCode: other.confirmationCode, consentVersion: version }, { confirmationCode: c.confirmationCode, consentVersion: "old" }]) {
      await expect(approveObsPairingChallenge(db, ctx, c.id, input)).rejects.toThrow();
    }
  });
  it("대리 조회/직원/위조 actor는 현재 DB 대표자가 아니다", async () => {
    const { ctx } = await owner(); const c = await createObsPairingChallenge(db); const other = await owner();
    for (const actor of [{ ...ctx, readOnly: true }, { ...ctx, isOwner: false }, { ...ctx, actorId: other.ctx.actorId }]) {
      await expect(approveObsPairingChallenge(db, actor, c.id, { confirmationCode: c.confirmationCode, consentVersion: version })).rejects.toThrow();
    }
  });
  it.each(["owner_inactive", "seller_suspended", "subscription_expired"])("승인 이후 %s이면 소비하지 않는다", async change => {
    const f = await approved();
    if (change === "owner_inactive") await db.sellerUser.update({ where: { id: f.ctx.actorId }, data: { status: "DISABLED" } });
    if (change === "seller_suspended") await db.seller.update({ where: { id: f.ctx.sellerId }, data: { status: "SUSPENDED" } });
    if (change === "subscription_expired") await db.seller.update({ where: { id: f.ctx.sellerId }, data: { trialEndsAt: new Date(0) } });
    await expect(consumeObsPairingChallenge(db, f.c.id, f.c.verifier, f.input)).rejects.toThrow();
    expect((await db.obsPairingChallenge.findUniqueOrThrow({ where: { id: f.c.id } })).consumedAt).toBeNull();
  });
  it("오버레이 수동만으로는 등록하지 않으며 PAID INITIAL만 현재 임시 자격을 준다", async () => {
    const { ctx } = await owner("OVERLAY_ONLY"); const c = await createObsPairingChallenge(db);
    await expect(approveObsPairingChallenge(db, ctx, c.id, { confirmationCode: c.confirmationCode, consentVersion: version })).rejects.toThrow();
    const job = await paidInstall(ctx);
    await approveObsPairingChallenge(db, ctx, c.id, { confirmationCode: c.confirmationCode, consentVersion: version, installJobId: job.id });
    expect(await consumeObsPairingChallenge(db, c.id, c.verifier, { deviceId: c.deviceId, sellerId: ctx.sellerId, consentVersion: version })).toMatchObject({ generation: 1, state: "registered_commands_unavailable" });
  });
  it.each(["CANCELED", "SUCCEEDED", "FAILED"] as const)("승인 이후 INITIAL %s는 완료 권리로 승격하지 않는다", async status => {
    const { ctx } = await owner("OVERLAY_ONLY"); const c = await createObsPairingChallenge(db); const j = await paidInstall(ctx);
    await approveObsPairingChallenge(db, ctx, c.id, { confirmationCode: c.confirmationCode, consentVersion: version, installJobId: j.id });
    await db.automationJob.update({ where: { id: j.id }, data: { status, leaseOwner: null, leaseExpiresAt: null } });
    await expect(consumeObsPairingChallenge(db, c.id, c.verifier, { deviceId: c.deviceId, sellerId: ctx.sellerId, consentVersion: version })).rejects.toThrow();
  });
  it.each(["lease", "payment"])("유료 INITIAL %s 변경도 소비 전에 다시 확인한다", async change => {
    const { ctx } = await owner("OVERLAY_ONLY");
      const c = await createObsPairingChallenge(db); const j = await paidInstall(ctx);
      await approveObsPairingChallenge(db, ctx, c.id, { confirmationCode: c.confirmationCode, consentVersion: version, installJobId: j.id });
      if (change === "lease") await db.automationJob.update({ where: { id: j.id }, data: { leaseExpiresAt: new Date(0) } });
      else await db.automationPayment.update({ where: { id: j.paymentId! }, data: { status: "REFUNDED" } });
      await expect(consumeObsPairingChallenge(db, c.id, c.verifier, { deviceId: c.deviceId, sellerId: ctx.sellerId, consentVersion: version })).rejects.toThrow();
  });
  it("응답 유실 후 명시 재페어링은 이전 credential 회수와 세대회전부터 한다", async () => {
    const f = await approved(); const old = await consumeObsPairingChallenge(db, f.c.id, f.c.verifier, f.input);
    const fresh = await createObsPairingChallenge(db);
    const a = await approveObsPairingChallenge(db, f.ctx, fresh.id, { confirmationCode: fresh.confirmationCode, consentVersion: version, replacesChallengeId: f.c.id });
    expect(a).toMatchObject({ deviceId: old.deviceId, generation: 2 });
    expect(await db.obsDevice.findUnique({ where: { tokenHash: hashToken(old.token) } })).toBeNull();
    const r = await consumeObsPairingChallenge(db, fresh.id, fresh.verifier, { deviceId: a.deviceId, sellerId: f.ctx.sellerId, consentVersion: version });
    expect(r.generation).toBe(2); expect(await db.obsDevice.count()).toBe(1); expect(r.token).not.toBe(old.token);
  });
  it("철회는 tenant/generation을 대조하고 중복 철회는 세대를 다시 올리지 않는다", async () => {
    const f = await approved(); const r = await consumeObsPairingChallenge(db, f.c.id, f.c.verifier, f.input); const other = await owner();
    await expect(revokeObsDevice(db, other.ctx, r.deviceId, 1)).rejects.toThrow();
    await expect(revokeObsDevice(db, f.ctx, r.deviceId, 99)).rejects.toThrow();
    expect(await revokeObsDevice(db, f.ctx, r.deviceId, 1)).toEqual({ state: "revoked", generation: 2 });
    expect(await revokeObsDevice(db, f.ctx, r.deviceId, 1)).toEqual({ state: "revoked", generation: 2 });
    expect(await db.obsDevice.findUnique({ where: { tokenHash: hashToken(r.token) } })).toBeNull();
    expect(await db.auditLog.count({ where: { action: "obs.device.revoked" } })).toBe(1);
  });
  it("감사 INSERT 실패는 challenge 소비와 device 생성을 모두 롤백한다", async () => {
    const f = await approved();
    await db.$executeRawUnsafe(`CREATE FUNCTION obs_pairing_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'obs.pairing.consumed' THEN RAISE EXCEPTION 'test_audit_failure'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER obs_pairing_test_audit_failure BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION obs_pairing_audit_failure()`);
    try {
      await expect(consumeObsPairingChallenge(db, f.c.id, f.c.verifier, f.input)).rejects.toThrow();
      expect(await db.obsDevice.count()).toBe(0);
      expect((await db.obsPairingChallenge.findUniqueOrThrow({ where: { id: f.c.id } })).consumedAt).toBeNull();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER obs_pairing_test_audit_failure ON "AuditLog"`);
      await db.$executeRawUnsafe(`DROP FUNCTION obs_pairing_audit_failure()`);
    }
  });
  it("발급 상한은 DB 전체에 공유되며 허용량을 넘기면 행을 추가하지 않는다", async () => {
    await db.obsPairingChallenge.createMany({ data: Array.from({ length: 100 }, () => ({ id: randomUUID(), deviceId: randomUUID(), verifierHash: randomUUID(), confirmationHash: "fixture", expiresAt: new Date(Date.now() + 300_000) })) });
    await expect(createObsPairingChallenge(db)).rejects.toThrow("obs_pairing_rate_limited");
    expect(await db.obsPairingChallenge.count()).toBe(100);
  });
  it("대표자 API는 세션/Origin 검증, PC API는 cookie/boolean·body actorId를 거부한다", async () => {
    const { ctx, user } = await owner(); const c = await createObsPairingChallenge(db);
    const url = `https://test.example/api/seller/obs/pairing/challenges/${c.id}/approve`;
    const body = { confirmationCode: c.confirmationCode, consentVersion: version };
    const args = { params: Promise.resolve({ id: c.id }) };
    expect((await approveRoute(new Request(url, { method: "POST", body: JSON.stringify(body), headers: { origin: "https://test.example" } }), args)).status).toBe(401);
    const session = await createSellerSession(db, ctx.sellerId, user.id, {}, user.credentialVersion);
    const headers = { cookie: `lo_seller=${session.token}`, origin: "https://test.example", "content-type": "application/json" };
    expect((await approveRoute(new Request(url, { method: "POST", body: JSON.stringify(body), headers: { ...headers, origin: "https://other.example" } }), args)).status).toBe(403);
    expect((await approveRoute(new Request(url, { method: "POST", body: JSON.stringify(body), headers }), args)).status).toBe(200);
    const pcUrl = `https://test.example/api/obs/pairing/challenges/${c.id}/consume`;
    const pcInput = { deviceId: c.deviceId, sellerId: ctx.sellerId, consentVersion: version };
    expect((await consumeRoute(new Request(pcUrl, { method: "POST", body: JSON.stringify({ ...pcInput, consent: true, actorId: ctx.actorId }), headers: { authorization: `Bearer ${c.verifier}` } }), args)).status).toBe(400);
    expect((await consumeRoute(new Request(pcUrl, { method: "POST", body: JSON.stringify(pcInput), headers: { cookie: "lo_seller=invalid", authorization: `Bearer ${c.verifier}` } }), args)).status).toBe(403);
    const response = await consumeRoute(new Request(pcUrl, { method: "POST", body: JSON.stringify(pcInput), headers: { authorization: `Bearer ${c.verifier}` } }), args);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await createRoute(new Request("https://test.example/api/obs/pairing/challenges", { method: "POST", body: "x".repeat(2049) }))).status).toBe(413);
  });
});
