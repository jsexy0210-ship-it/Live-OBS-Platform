import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { adminCan } from "../authz/permissions";
import { forbidden } from "../authz/errors";
import { dbNow } from "../billing/subscription";
import { writeAudit } from "../audit/log";
import { DISK_OPTIMIZATION_POLICY as policy, previewDiskOptimization, requestDiskOptimization, diskOptimizationJob } from "./diskOptimization";
import { configuredDiskOptimizationBridge, diskCandidateFingerprint, validDiskActualJob, validDiskPreview, type DiskOptimizationBridge } from "./diskOptimizationBridge";

const PREVIEW = "disk_optimization_preview";
const REQUEST = "disk_optimization_request";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const error = (status: number, reason: string) => ({ ok: false as const, status, reason, job: null });
const unavailable = () => error(503, "disk_optimization_unavailable");
function body(value: unknown, keys: string[]): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k)) ? value as Record<string, unknown> : null;
}
function requireInfra(admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "infra.manage")) throw forbidden();
}
async function revalidate(db: PrismaClient | Prisma.TransactionClient, admin: AdminSessionContext, at: Date) {
  const session = await db.adminSession.findUnique({ where: { id: admin.sessionId }, include: { admin: true } });
  if (!session || session.adminId !== admin.admin.id || session.revokedAt || session.expiresAt <= at || session.admin.status !== "ACTIVE" || !adminCan(session.admin.role, "infra.manage")) throw forbidden();
}
const previewKey = (admin: AdminSessionContext, fingerprint: string, expiresAt: string) => hash([admin.admin.id, fingerprint, expiresAt]);

/** 미연결 기본값은 기존 503 그대로다. 후보는 검증된 runner 증거가 있을 때만 발급한다. */
export async function previewApprovedDiskOptimization(db: PrismaClient, admin: AdminSessionContext, input: unknown, bridge: DiskOptimizationBridge | null = configuredDiskOptimizationBridge()) {
  const initial = previewDiskOptimization(admin, input);
  if (initial.status === 400 || !bridge) return initial;
  try {
    const evidence = await bridge.preview();
    const at = await dbNow(db);
    await revalidate(db, admin, at);
    if (!validDiskPreview(evidence, at)) return unavailable();
    const estimatedReclaimedBytes = evidence.candidates.reduce((sum, c) => sum + c.bytes, 0);
    if (!Number.isSafeInteger(estimatedReclaimedBytes)) return unavailable();
    const candidateFingerprint = diskCandidateFingerprint(evidence.candidates);
    // 브라우저가 보낸 임의 fingerprint/만료시각은 서버가 발급한 preview를 대신하지 못한다.
    await db.opsEvent.upsert({ where: { source_eventId: { source: PREVIEW, eventId: previewKey(admin, candidateFingerprint, evidence.expiresAt) } }, update: {}, create: {
      source: PREVIEW, eventId: previewKey(admin, candidateFingerprint, evidence.expiresAt), kind: "info", key: policy.target, severity: "info", message: "승인 범주의 정리 후보를 확인했습니다", occurredAt: at,
      detail: { requestedByAdminId: admin.admin.id, candidateFingerprint, expiresAt: evidence.expiresAt, policyVersion: policy.version } as Prisma.InputJsonValue,
    } });
    return { ok: true as const, status: 200, reason: undefined, policy, candidates: evidence.candidates, candidateFingerprint, expiresAt: evidence.expiresAt, estimatedReclaimedBytes, job: null };
  } catch (e) {
    if (e instanceof Error && e.message === "forbidden") throw e;
    return unavailable();
  }
}

export async function executeApprovedDiskOptimization(db: PrismaClient, admin: AdminSessionContext, input: unknown, meta: { ip?: string | null; userAgent?: string | null } = {}, bridge: DiskOptimizationBridge | null = configuredDiskOptimizationBridge()) {
  requireInfra(admin);
  if (!bridge) return requestDiskOptimization(db, admin, input, meta);
  const b = body(input, ["actionId", "policyVersion", "idempotencyKey", "candidateFingerprint", "previewExpiresAt"]);
  if (!b || b.actionId !== policy.actionId || b.policyVersion !== policy.version || typeof b.idempotencyKey !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(b.idempotencyKey) || typeof b.candidateFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(b.candidateFingerprint) || typeof b.previewExpiresAt !== "string" || !Number.isFinite(Date.parse(b.previewExpiresAt)) || new Date(b.previewExpiresAt).toISOString() !== b.previewExpiresAt) return error(400, "invalid_input");
  const requestId = b.idempotencyKey, candidateFingerprint = b.candidateFingerprint, previewExpiresAt = b.previewExpiresAt;
  const requestDigest = hash([b.actionId, b.policyVersion, candidateFingerprint, previewExpiresAt]);
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('disk_optimization_requests'))`;
    const at = await dbNow(tx);
    await revalidate(tx, admin, at);
    const prior = await tx.opsEvent.findUnique({ where: { source_eventId: { source: REQUEST, eventId: requestId } } });
    if (prior) {
      const d = body(prior.detail, ["requestDigest", "requestedByAdminId", "result", "jobId", "candidateFingerprint", "policyVersion", "actionId", "reasons"]);
      if (!d || d.requestDigest !== requestDigest || d.requestedByAdminId !== admin.admin.id) return error(409, "idempotency_conflict");
      if (d.result !== "DISPATCHED" || typeof d.jobId !== "string") return { ...unavailable(), requestId, replayed: true };
      try {
        const job = await bridge.job(d.jobId);
        return job && validDiskActualJob(job, { requestId, candidateFingerprint }) && job.id === d.jobId ? { ok: true as const, status: 200, reason: undefined, job, requestId, replayed: true } : unavailable();
      } catch { return unavailable(); }
    }
    if (Date.parse(previewExpiresAt) <= at.getTime()) return error(409, "preview_expired");
    const issued = await tx.opsEvent.findUnique({ where: { source_eventId: { source: PREVIEW, eventId: previewKey(admin, candidateFingerprint, previewExpiresAt) } } });
    if (!issued) return error(409, "preview_not_issued");
    let acceptedJob: Awaited<ReturnType<DiskOptimizationBridge["dispatch"]>>;
    let acceptedAt = at;
    try {
      const fresh = await bridge.preview();
      const now = await dbNow(tx);
      if (Date.parse(previewExpiresAt) <= now.getTime()) return error(409, "preview_expired");
      if (!validDiskPreview(fresh, now)) return unavailable();
      if (diskCandidateFingerprint(fresh.candidates) !== candidateFingerprint) return error(409, "candidate_changed");
      if (fresh.candidates.length === 0) return error(409, "no_candidates");
      await revalidate(tx, admin, now);
      // bridge는 requestId로 원자적 중복 방지를 수행해야 한다. 불확실한 응답을 새 요청으로 재발행하지 않는다.
      const job = await bridge.dispatch({ requestId, requestedByAdminId: admin.admin.id, candidateFingerprint, previewExpiresAt });
      if (!validDiskActualJob(job, { requestId, candidateFingerprint })) throw new Error("invalid_job_evidence");
      acceptedJob = job; acceptedAt = now;
    } catch (e) {
      if (e instanceof Error && e.message === "forbidden") throw e;
      // 연결/응답 실패는 완료가 아니다. 동일 키 재시도는 이 거부 기록을 읽으며 재dispatch하지 않는다.
      await tx.opsEvent.create({ data: { source: REQUEST, eventId: requestId, kind: "info", key: policy.target, severity: "warn", message: "전용 runner 접수 결과를 확인하지 못했습니다", occurredAt: at,
        detail: { requestDigest, requestedByAdminId: admin.admin.id, result: "REJECTED_UNAVAILABLE", policyVersion: policy.version, actionId: policy.actionId, reasons: ["BRIDGE_EVIDENCE_UNAVAILABLE"] } as Prisma.InputJsonValue } });
      await writeAudit(tx, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, action: "admin.infra.disk_execute_rejected", targetType: "DiskOptimizationRequest", targetId: requestId, after: { result: "REJECTED_UNAVAILABLE", beforeBytes: null, afterBytes: null }, ...meta });
      return { ...unavailable(), requestId, replayed: false };
    }
    await tx.opsEvent.create({ data: { source: REQUEST, eventId: requestId, kind: "info", key: policy.target, severity: "info", message: "전용 runner 작업을 접수했습니다", occurredAt: acceptedAt,
      detail: { requestDigest, requestedByAdminId: admin.admin.id, result: "DISPATCHED", jobId: acceptedJob.id, candidateFingerprint, policyVersion: policy.version, actionId: policy.actionId } as Prisma.InputJsonValue } });
    await writeAudit(tx, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, action: "admin.infra.disk_dispatched", targetType: "DiskOptimizationRequest", targetId: requestId, after: { jobId: acceptedJob.id, candidateFingerprint, policyVersion: policy.version }, ...meta });
    return { ok: true as const, status: 202, reason: undefined, job: acceptedJob, requestId, replayed: false };
  });
}

export async function readApprovedDiskOptimizationJob(db: PrismaClient, admin: AdminSessionContext, id: string, bridge: DiskOptimizationBridge | null = configuredDiskOptimizationBridge()) {
  requireInfra(admin);
  if (!/^[1-9][0-9]{0,19}$/.test(id)) return diskOptimizationJob(admin, id);
  if (!bridge) return error(404, "disk_optimization_job_not_found");
  await revalidate(db, admin, await dbNow(db));
  try {
    const job = await bridge.job(id);
    if (!job) return error(404, "disk_optimization_job_not_found");
    if (!validDiskActualJob(job) || job.id !== id) return unavailable();
    const request = await db.opsEvent.findUnique({ where: { source_eventId: { source: REQUEST, eventId: job.requestId } } });
    const d = body(request?.detail, ["requestDigest", "requestedByAdminId", "result", "jobId", "candidateFingerprint", "policyVersion", "actionId"]);
    if (!d || d.result !== "DISPATCHED" || d.jobId !== id || d.candidateFingerprint !== job.candidateFingerprint) return error(404, "disk_optimization_job_not_found");
    return { ok: true as const, status: 200, reason: undefined, job };
  } catch { return unavailable(); }
}
