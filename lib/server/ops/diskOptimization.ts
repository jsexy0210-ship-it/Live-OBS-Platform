import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { adminCan } from "../authz/permissions";
import { forbidden } from "../authz/errors";
import { writeAudit } from "../audit/log";
import { dbNow } from "../billing/subscription";
import { infraStatus } from "./infra";

// 호스트/runner 검증 전의 차단 계약이다. shell, SSH, workflow dispatch, scheduler 실행을 연결하지 않는다.
export const DISK_OPTIMIZATION_POLICY = {
  target: "OBS_TEST", actionId: "OPTIMIZE_APPROVED_ARTIFACTS_V1", version: "ONQ_DISK_SAFE_V1",
  allowedCategories: ["OLD_ONQ_NON_ROLLBACK_IMAGES", "RUNNER_DIAGNOSTIC_LOGS_OLDER_THAN_14_DAYS"],
  excludedCategories: ["GLOBAL_DOCKER_PRUNE", "UNKNOWN_OWNER_CACHE", "DB_VOLUMES", "CONTAINERS", "BACKUPS", "ROLLBACK_IMAGES", "CHECKOUT_ARTIFACTS"],
} as const;
const AUTO_KEY = "diskOptimizationAutoEnabled";
const REQUEST_SOURCE = "disk_optimization_request";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const reasons = ["HOST_ACCESS_UNVALIDATED", "RUNNER_UNVALIDATED", "SCHEDULE_UNVERIFIED"] as const;
type Meta = { ip?: string | null; userAgent?: string | null };
const requireInfra = (a: AdminSessionContext) => { if (!adminCan(a.admin.role, "infra.manage")) throw forbidden(); };
export const diskReadiness = () => ({ autoEnableAllowed: false, manualExecuteAllowed: false, reasons: [...reasons] });
const invalid = () => ({ ok: false as const, status: 400, reason: "invalid_input" });
const conflict = () => ({ ok: false as const, status: 409, reason: "version_conflict" });
const unavailable = () => ({ ok: false as const, status: 503, reason: "disk_optimization_unavailable", readiness: diskReadiness(), job: null });
function object(input: unknown, keys: string[]): Record<string, unknown> | null {
  return input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).every((k) => keys.includes(k)) ? input as Record<string, unknown> : null;
}
const fixedPolicy = (b: Record<string, unknown>) => b.actionId === DISK_OPTIMIZATION_POLICY.actionId && b.policyVersion === DISK_OPTIMIZATION_POLICY.version;
const version = (row: { updatedAt: Date } | null) => row?.updatedAt.toISOString() ?? null;

export async function diskOptimizationStatus(db: PrismaClient, admin: AdminSessionContext) {
  requireInfra(admin);
  const [row, infra] = await Promise.all([db.platformPolicy.findUnique({ where: { key: AUTO_KEY } }), infraStatus(db)]);
  return {
    checkedAt: infra.checkedAt, target: DISK_OPTIMIZATION_POLICY.target, policy: DISK_OPTIMIZATION_POLICY,
    readiness: diskReadiness(),
    serverDisk: { state: "unavailable", totalBytes: null, usedBytes: null, availableBytes: null },
    appFilesystem: { scope: "APP_FILESYSTEM_ONLY", disk: infra.current.disk, verifiedAsHost: false },
    auto: { enabled: false, effectiveEnabled: false, state: "unavailable", version: version(row), configurationValid: !row || row.intValue === 0 },
    schedule: { source: "UNVERIFIED", cadence: null, nextRunAt: null },
    latestActualJob: null, lastOptimizedAt: null, nextRunAt: null,
    executionEvidence: "NOT_AVAILABLE", deploymentConcurrency: { group: "deploy-obs-test", verified: false },
  };
}

export async function updateDiskOptimizationAuto(db: PrismaClient, admin: AdminSessionContext, input: unknown, meta: Meta = {}) {
  requireInfra(admin);
  const b = object(input, ["enabled", "expectedVersion"]);
  if (!b || typeof b.enabled !== "boolean" || !(b.expectedVersion === null || typeof b.expectedVersion === "string")) return invalid();
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('disk_optimization_auto'))`;
    const row = await tx.platformPolicy.findUnique({ where: { key: AUTO_KEY } });
    if (version(row) !== b.expectedVersion) return conflict();
    if (b.enabled) {
      await writeAudit(tx, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, action: "admin.infra.disk_auto_rejected", targetType: "DiskOptimization", targetId: DISK_OPTIMIZATION_POLICY.target, after: { requestedEnabled: true, enabled: false, policyVersion: DISK_OPTIMIZATION_POLICY.version, reasons }, ...meta });
      return unavailable();
    }
    // 이미 꺼진 기본값/설정은 다시 쓰지 않는다. 검증되지 않은 true 설정도 명시적으로 끌 수 있다.
    if (!row || row.intValue === 0) return { ok: true as const, enabled: false, effectiveEnabled: false, version: version(row), readiness: diskReadiness() };
    const saved = await tx.platformPolicy.update({ where: { key: AUTO_KEY }, data: { intValue: 0, updatedByAdminId: admin.admin.id } });
    await writeAudit(tx, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, action: "admin.infra.disk_auto_disabled", targetType: "DiskOptimization", targetId: DISK_OPTIMIZATION_POLICY.target, before: { configuredValue: row.intValue }, after: { enabled: false, policyVersion: DISK_OPTIMIZATION_POLICY.version }, ...meta });
    return { ok: true as const, enabled: false, effectiveEnabled: false, version: version(saved), readiness: diskReadiness() };
  });
}

export function previewDiskOptimization(admin: AdminSessionContext, input: unknown) {
  requireInfra(admin);
  const b = object(input, ["actionId", "policyVersion"]);
  if (!b || !fixedPolicy(b)) return invalid();
  return { ...unavailable(), policy: DISK_OPTIMIZATION_POLICY, candidates: null, candidateFingerprint: null, expiresAt: null, estimatedReclaimedBytes: null };
}

/** OpsEvent는 거부된 요청의 멱등 추적일 뿐 실제 job이 아니다. 성공시각/실행중/성공 결과를 쓰지 않는다. */
export async function requestDiskOptimization(db: PrismaClient, admin: AdminSessionContext, input: unknown, meta: Meta = {}) {
  requireInfra(admin);
  const b = object(input, ["actionId", "policyVersion", "idempotencyKey", "candidateFingerprint", "previewExpiresAt"]);
  if (!b || !fixedPolicy(b) || typeof b.idempotencyKey !== "string" || !UUID.test(b.idempotencyKey)) return invalid();
  const emptyPreview = b.candidateFingerprint === null && b.previewExpiresAt === null;
  const datedPreview = typeof b.candidateFingerprint === "string" && HASH.test(b.candidateFingerprint) && typeof b.previewExpiresAt === "string" && Number.isFinite(Date.parse(b.previewExpiresAt)) && new Date(b.previewExpiresAt).toISOString() === b.previewExpiresAt;
  if (!emptyPreview && !datedPreview) return invalid();
  const requestId = b.idempotencyKey;
  const digest = createHash("sha256").update(JSON.stringify([b.actionId, b.policyVersion, b.candidateFingerprint, b.previewExpiresAt])).digest("hex");
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('disk_optimization_requests'))`;
    const prior = await tx.opsEvent.findUnique({ where: { source_eventId: { source: REQUEST_SOURCE, eventId: requestId } } });
    if (prior) {
      const d = object(prior.detail, ["requestDigest", "requestedByAdminId", "result", "policyVersion", "actionId", "reasons"]);
      if (!d || d.requestDigest !== digest || d.requestedByAdminId !== admin.admin.id || d.result !== "REJECTED_UNAVAILABLE") return { ok: false as const, status: 409, reason: "idempotency_conflict" };
      return { ...unavailable(), requestId, replayed: true };
    }
    const at = await dbNow(tx);
    if (datedPreview && Date.parse(b.previewExpiresAt as string) <= at.getTime()) return { ok: false as const, status: 409, reason: "preview_expired" };
    // 클라이언트 fingerprint는 검증된 후보가 아니다. 실행 직전 재검사의 원천이 없어 반드시 거부한다.
    await tx.opsEvent.create({ data: { source: REQUEST_SOURCE, eventId: requestId, kind: "info", key: DISK_OPTIMIZATION_POLICY.target, severity: "warn", message: "서버 연결 미확인으로 디스크 정리 요청을 거부했습니다", occurredAt: at, detail: { requestDigest: digest, requestedByAdminId: admin.admin.id, result: "REJECTED_UNAVAILABLE", policyVersion: DISK_OPTIMIZATION_POLICY.version, actionId: DISK_OPTIMIZATION_POLICY.actionId, reasons } as Prisma.InputJsonValue } });
    await writeAudit(tx, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, action: "admin.infra.disk_execute_rejected", targetType: "DiskOptimizationRequest", targetId: requestId, after: { policyVersion: DISK_OPTIMIZATION_POLICY.version, result: "REJECTED_UNAVAILABLE", reasons, beforeBytes: null, afterBytes: null }, ...meta });
    return { ...unavailable(), requestId, replayed: false };
  });
}

export function diskOptimizationJob(admin: AdminSessionContext, id: string) {
  requireInfra(admin);
  if (!UUID.test(id)) return invalid();
  // 요청 추적 ID를 실제 job ID로 변환하지 않는다. 검증된 job 원천은 아직 연결되지 않았다.
  return { ok: false as const, status: 404, reason: "disk_optimization_job_not_found", job: null, readiness: diskReadiness() };
}
