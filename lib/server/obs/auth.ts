import { Prisma, type PrismaClient } from "@prisma/client";
import { hashToken } from "../auth/token";
import { isJobId } from "../automation/ids";
import type { TenantContext } from "../tenant/context";
import { ObsPairingError } from "./errors";
import { readObsConnectionEligibilityTx } from "./reader";

type DeviceInput = { token: unknown; sellerId: unknown; deviceId: unknown; generation: unknown; installJobId?: unknown; jobFence?: unknown };
type Identity = Readonly<{ sellerId: string; deviceId: string; generation: number }>;
export type ObsDeviceAuthentication = Identity & (
  { readonly state: "authenticated_transport_unavailable"; readonly entitlement: "INTEGRATED_BASIC"; readonly job: null } |
  { readonly state: "authenticated_transport_unavailable"; readonly entitlement: "PAID_INITIAL_INSTALL"; readonly job: Readonly<{ id: string; fence: number; leaseExpiresAt: number }> } |
  { readonly state: "control_denied_support_required"; readonly entitlement: null; readonly reason: "overlay_persistent_control_unresolved" }
);
function fail(code = "obs_device_unverified", status = 401): never { throw new ObsPairingError(status, code); }
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;

// 저장 credential 검증과 현재 자격의 읽기 전용 관측이다. ObsServerReader/ObsAuthority가 아니다.
// 연결 epoch/OBS pairing 실측/helper 동의/명령 송신은 구현하지 않고 임의 값을 만들지 않는다.
export async function readObsDeviceAuthentication(db: PrismaClient, input: DeviceInput): Promise<ObsDeviceAuthentication> {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
    Object.keys(input).some(k => !["token", "sellerId", "deviceId", "generation", "installJobId", "jobFence"].includes(k)) ||
    typeof input.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.token) ||
    typeof input.sellerId !== "string" || !isJobId(input.sellerId) || typeof input.deviceId !== "string" || !isJobId(input.deviceId) || !positive(input.generation) ||
    (input.installJobId !== undefined && (typeof input.installJobId !== "string" || !isJobId(input.installJobId))) ||
    (input.jobFence !== undefined && !positive(input.jobFence))) fail();
  const { token, sellerId, deviceId, generation, installJobId, jobFence } = input;
  try {
    return await db.$transaction(async tx => {
      const d = await tx.obsDevice.findFirst({ where: { id: deviceId, sellerId, generation, revokedAt: null, tokenHash: hashToken(token) },
        select: { id: true, sellerId: true, generation: true, registeredById: true, consentVersion: true } });
      if (!d) fail();
      const registration = await tx.obsPairingChallenge.findFirst({ where: {
        deviceId: d.id, sellerId: d.sellerId, generation: d.generation, approvedActorId: d.registeredById,
        consentVersion: d.consentVersion, approvedAt: { not: null }, consumedAt: { not: null },
      }, select: { installJobId: true }, orderBy: { consumedAt: "desc" } });
      if (!registration) fail();
      const owner = await tx.sellerUser.findFirst({ where: { id: d.registeredById, sellerId: d.sellerId, isOwner: true, status: "ACTIVE" }, select: { id: true } });
      if (!owner) fail("obs_device_owner_unavailable", 403);
      const ctx: TenantContext = { sellerId: d.sellerId, actorId: owner.id, actorType: "SELLER_USER", isOwner: true, readOnly: false, permissions: [] };
      const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      const account = await readObsConnectionEligibilityTx(tx, ctx, now);
      const identity = { sellerId: d.sellerId, deviceId: d.id, generation: d.generation };
      if (account.state === "pairing_required" && account.entitlement === "INTEGRATED_BASIC") {
        return Object.freeze({ ...identity, state: "authenticated_transport_unavailable" as const, entitlement: "INTEGRATED_BASIC" as const, job: null });
      }
      // 실제 OVERLAY credential이라도 완료 설치를 영구 제어 권리로 승격하지 않는다.
      if (!installJobId) return Object.freeze({ ...identity, state: "control_denied_support_required" as const, entitlement: null,
        reason: "overlay_persistent_control_unresolved" as const });
      if (registration.installJobId !== installJobId || !positive(jobFence)) fail("obs_job_scope_denied", 403);
      const install = await readObsConnectionEligibilityTx(tx, ctx, now, installJobId as string);
      if (install.state !== "pairing_required" || install.entitlement !== "PAID_INITIAL_INSTALL" || !install.records.install) fail("obs_job_scope_denied", 403);
      const j = install.records.install.job;
      if (j.fencingToken !== jobFence || !positive(j.fencingToken) || !j.leaseExpiresAt || j.leaseExpiresAt <= now) fail("obs_job_scope_denied", 403);
      return Object.freeze({ ...identity, state: "authenticated_transport_unavailable" as const, entitlement: "PAID_INITIAL_INSTALL" as const,
        job: Object.freeze({ id: j.id, fence: j.fencingToken, leaseExpiresAt: j.leaseExpiresAt.getTime() }) });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  } catch (e) {
    if (e instanceof ObsPairingError) throw e;
    if (e instanceof Error && ["obs_access_denied", "obs_purchase_required", "obs_purchase_unverified"].includes(e.message)) fail(e.message, 403);
    // Prisma 오류에 query/credential hash가 있을 수 있어 재출력하거나 cause로 전달하지 않는다.
    fail("obs_device_auth_unavailable", 503);
  }
}
