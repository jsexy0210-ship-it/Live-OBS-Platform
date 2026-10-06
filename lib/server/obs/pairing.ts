import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type ObsPairingChallenge } from "@prisma/client";
import { generateToken, hashToken } from "../auth/token";
import { writeAudit } from "../audit/log";
import { ObsPairingError } from "./errors";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { isJobId } from "../automation/ids";
import { readObsConnectionEligibilityTx } from "./reader";

export const OBS_PAIRING_CONSENT_VERSION = "2026-10-07";
function deny(code = "obs_pairing_denied", status = 403): never { throw new ObsPairingError(status, code); }
const secretValid = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{43}$/.test(s);
const uuid = (s: unknown): s is string => typeof s === "string" && isJobId(s);
async function clock(tx: Prisma.TransactionClient): Promise<Date> {
  const [r] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return r.now;
}
async function lockChallenge(tx: Prisma.TransactionClient, id: string) {
  if (!uuid(id)) deny();
  await tx.$queryRaw`SELECT id FROM "ObsPairingChallenge" WHERE id = ${id}::uuid FOR UPDATE`;
  return tx.obsPairingChallenge.findUnique({ where: { id } });
}
async function currentOwner(tx: Prisma.TransactionClient, ctx: TenantContext): Promise<TenantContext> {
  requireSellerPermission(ctx, "OVERLAY_EDIT");
  if (ctx.readOnly || !ctx.isOwner || ctx.actorType !== "SELLER_USER") deny();
  const user = await tx.sellerUser.findFirst({ where: { id: ctx.actorId, sellerId: ctx.sellerId, isOwner: true, status: "ACTIVE" }, select: { id: true } });
  if (!user) deny();
  return ctx;
}
async function eligible(tx: Prisma.TransactionClient, ctx: TenantContext, installJobId?: string) {
  await currentOwner(tx, ctx);
  try {
    const r = await readObsConnectionEligibilityTx(tx, ctx, await clock(tx), installJobId);
    if (r.state !== "pairing_required") deny("obs_purchase_required");
  } catch (e) {
    if (e instanceof Error && ["obs_access_denied", "obs_purchase_required", "obs_purchase_unverified"].includes(e.message)) deny(e.message);
    throw e;
  }
}
async function audit(tx: Prisma.TransactionClient, c: ObsPairingChallenge, action: string, generation: number) {
  await writeAudit(tx, { actorType: "SELLER_USER", actorId: c.approvedActorId, sellerId: c.sellerId,
    action, targetType: "ObsDevice", targetId: c.deviceId, after: { generation, challengeId: c.id } });
}

// 제한된 PC bootstrap. 미승인 행/고엔트로피 verifier는 기기/판매자 인증 권한이 아니다.
export async function createObsPairingChallenge(db: PrismaClient) {
  return db.$transaction(async tx => {
    // 전체 DB의 발급량을 한곳에서 제한한다. 쿠키/위조 IP를 인증 근거로 쓰지 않는다.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('obs-pairing-create'))`;
    const now = await clock(tx);
    const count = await tx.obsPairingChallenge.count({ where: { createdAt: { gte: new Date(now.getTime() - 60_000) } } });
    if (count >= 100) deny("obs_pairing_rate_limited", 429);
    // 승인/소비 이력은 보존하고 오래된 미승인 bootstrap만 정리한다.
    await tx.obsPairingChallenge.deleteMany({ where: { sellerId: null, approvedAt: null, consumedAt: null, expiresAt: { lt: new Date(now.getTime() - 86_400_000) } } });
    const verifier = generateToken();
    const confirmationCode = generateToken();
    const c = await tx.obsPairingChallenge.create({ data: {
      id: randomUUID(), deviceId: randomUUID(), verifierHash: hashToken(verifier), confirmationHash: hashToken(confirmationCode),
      expiresAt: new Date(now.getTime() + 5 * 60_000),
    }, select: { id: true, deviceId: true, expiresAt: true } });
    return { ...c, verifier, confirmationCode, consentVersion: OBS_PAIRING_CONSENT_VERSION };
  });
}

export async function approveObsPairingChallenge(db: PrismaClient, ctx: TenantContext, id: string,
  input: { confirmationCode: unknown; consentVersion: unknown; installJobId?: unknown; replacesChallengeId?: unknown }) {
  if (!secretValid(input.confirmationCode) || input.consentVersion !== OBS_PAIRING_CONSENT_VERSION ||
    (input.installJobId !== undefined && !uuid(input.installJobId)) || (input.replacesChallengeId !== undefined && !uuid(input.replacesChallengeId))) deny();
  return db.$transaction(async tx => {
    const c = await lockChallenge(tx, id);
    if (!c || c.sellerId || c.consumedAt || c.approvedAt || c.expiresAt <= await clock(tx) || c.confirmationHash !== hashToken(input.confirmationCode as string)) deny();
    await eligible(tx, ctx, input.installJobId as string | undefined);
    let deviceId = c.deviceId; let generation = 1;
    if (input.replacesChallengeId) {
      // 응답 유실/재페어링은 해당 기존 발급을 정확히 지정하고 먼저 회수한다.
      const old = await lockChallenge(tx, input.replacesChallengeId as string);
      if (!old?.consumedAt || old.sellerId !== ctx.sellerId || old.approvedActorId !== ctx.actorId) deny();
      const d = await tx.obsDevice.findFirst({ where: { id: old.deviceId, sellerId: ctx.sellerId } });
      if (!d || d.generation !== old.generation || d.revokedAt) deny();
      generation = d.generation + 1; deviceId = d.id;
      const changed = await tx.obsDevice.updateMany({ where: { id: d.id, sellerId: ctx.sellerId, generation: d.generation, revokedAt: null },
        data: { tokenHash: null, revokedAt: await clock(tx), generation } });
      if (changed.count !== 1) deny();
      await audit(tx, old, "obs.device.repair_revoke", generation);
    }
    const changed = await tx.$executeRaw`UPDATE "ObsPairingChallenge" SET "sellerId" = ${ctx.sellerId}::uuid,
      "approvedActorId" = ${ctx.actorId}::uuid, "approvedAt" = clock_timestamp(), "consentVersion" = ${OBS_PAIRING_CONSENT_VERSION},
      "installJobId" = ${input.installJobId ?? null}::uuid, "deviceId" = ${deviceId}::uuid, generation = ${generation}
      WHERE id = ${id}::uuid AND "sellerId" IS NULL AND "approvedAt" IS NULL AND "consumedAt" IS NULL
      AND "expiresAt" > clock_timestamp() AND "confirmationHash" = ${c.confirmationHash}`;
    if (changed !== 1) deny();
    const updated = await tx.obsPairingChallenge.findUniqueOrThrow({ where: { id } });
    await audit(tx, updated, "obs.pairing.approved", generation);
    return { challengeId: id, deviceId, sellerId: ctx.sellerId, generation, state: "pc_confirmation_required" as const };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

// verifier 소유를 검증할 뿐 helper의 실제 화면/클릭을 검증했다고 주장하지 않는다.
export async function consumeObsPairingChallenge(db: PrismaClient, id: string, verifier: unknown,
  input: { deviceId: unknown; sellerId: unknown; consentVersion: unknown }) {
  if (!secretValid(verifier) || !uuid(input.deviceId) || !uuid(input.sellerId) || input.consentVersion !== OBS_PAIRING_CONSENT_VERSION) deny();
  return db.$transaction(async tx => {
    const c = await lockChallenge(tx, id);
    if (!c || !c.approvedAt || !c.approvedActorId || !c.sellerId || c.consumedAt || c.expiresAt <= await clock(tx) ||
      c.verifierHash !== hashToken(verifier as string) || c.deviceId !== input.deviceId || c.sellerId !== input.sellerId || c.consentVersion !== OBS_PAIRING_CONSENT_VERSION) deny();
    const ctx: TenantContext = { sellerId: c.sellerId!, actorId: c.approvedActorId!, actorType: "SELLER_USER", isOwner: true, readOnly: false, permissions: [] };
    await eligible(tx, ctx, c.installJobId ?? undefined);
    const consumed = await tx.$executeRaw`UPDATE "ObsPairingChallenge" SET "consumedAt" = clock_timestamp()
      WHERE id = ${id}::uuid AND "consumedAt" IS NULL AND "approvedAt" IS NOT NULL AND "expiresAt" > clock_timestamp()
      AND "sellerId" = ${ctx.sellerId}::uuid AND "approvedActorId" = ${ctx.actorId}::uuid
      AND "deviceId" = ${c.deviceId}::uuid AND generation = ${c.generation} AND "verifierHash" = ${c.verifierHash}`;
    if (consumed !== 1) deny();
    const token = generateToken();
    const existing = await tx.obsDevice.findUnique({ where: { id: c.deviceId } });
    if (existing) {
      if (existing.sellerId !== ctx.sellerId || existing.generation !== c.generation || !existing.revokedAt || existing.tokenHash) deny();
      await tx.obsDevice.update({ where: { id: existing.id }, data: { tokenHash: hashToken(token), revokedAt: null, registeredAt: await clock(tx), registeredById: ctx.actorId, consentVersion: OBS_PAIRING_CONSENT_VERSION } });
    } else {
      await tx.obsDevice.create({ data: { id: c.deviceId, sellerId: ctx.sellerId, tokenHash: hashToken(token), generation: c.generation,
        registeredById: ctx.actorId, consentVersion: OBS_PAIRING_CONSENT_VERSION } });
    }
    await audit(tx, c, "obs.pairing.consumed", c.generation);
    return { deviceId: c.deviceId, sellerId: ctx.sellerId, generation: c.generation, token, state: "registered_commands_unavailable" as const };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function revokeObsDevice(db: PrismaClient, ctx: TenantContext, deviceId: string, generation: unknown) {
  if (!uuid(deviceId) || !Number.isSafeInteger(generation) || Number(generation) < 1) deny();
  return db.$transaction(async tx => {
    await currentOwner(tx, ctx);
    const d = await tx.obsDevice.findFirst({ where: { id: deviceId, sellerId: ctx.sellerId } });
    if (!d) deny();
    if (d.revokedAt && d.generation === Number(generation) + 1) return { state: "revoked" as const, generation: d.generation };
    if (d.generation !== generation || d.revokedAt) deny();
    const changed = await tx.obsDevice.updateMany({ where: { id: deviceId, sellerId: ctx.sellerId, generation: Number(generation), revokedAt: null },
      data: { tokenHash: null, revokedAt: await clock(tx), generation: { increment: 1 } } });
    if (changed.count !== 1) deny();
    await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "obs.device.revoked",
      targetType: "ObsDevice", targetId: deviceId, after: { generation: d.generation + 1 } });
    return { state: "revoked" as const, generation: d.generation + 1 };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
