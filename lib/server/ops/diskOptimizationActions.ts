import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { adminCan } from "../authz/permissions";
import { diskCandidateFingerprint, validDiskActualJob, validDiskPreview, type DiskActualJob, type DiskOptimizationBridge, type DiskPreviewEvidence } from "./diskOptimizationBridge";

export const DISK_ACTIONS_REPO = "jsexy0210-ship-it/Live-OBS-Platform";
export const DISK_PREVIEW_WORKFLOW = "disk-optimization-preview-obs-test.yml";
export const DISK_EXECUTE_WORKFLOW = "disk-optimization-approved-obs-test.yml";
const SOURCE = "disk_actions_transport", CLAIM = "disk_actions_claim";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function fail(code: string): never { throw new Error(code); }
const where = (source: string, eventId: string) => ({ source_eventId: { source, eventId } });
type Db = PrismaClient | Prisma.TransactionClient;
const currentTime = async (db: Db) => (await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
const actionsTime = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fail("ACTIONS_TIME_UNVERIFIED");
export type DiskActionsTransport = (method: "GET" | "POST", path: string, body?: unknown) => Promise<{ status: number; data: unknown }>;

/** path만 주입받는다. 다른 저장소/host로 자격을 전달하거나 응답 원문을 오류에 싣지 않는다. */
export function diskActionsTransport(token: string): DiskActionsTransport {
  return async (method, path, body) => {
    const prefix = `/repos/${DISK_ACTIONS_REPO}/actions/`;
    const suffix = path.startsWith(prefix) ? path.slice(prefix.length) : "";
    const workflows = [DISK_PREVIEW_WORKFLOW, DISK_EXECUTE_WORKFLOW];
    const allowed = method === "POST"
      ? workflows.some(name => suffix === `workflows/${name}/dispatches`)
      : /^runs\/[1-9][0-9]{0,19}(?:\/jobs\?per_page=100)?$/.test(suffix)
        || workflows.some(name => suffix === `workflows/${name}/runs?branch=main&event=workflow_dispatch&per_page=100`)
        || suffix === "workflows/deploy-obs-test.yml/runs?branch=main&status=in_progress&per_page=100";
    if (!allowed) fail("ACTIONS_TARGET_DENIED");
    const response = await fetch(`https://api.github.com${path}`, { method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: response.status === 204 ? null : await response.json() };
  };
}

/** 실제 설정은 별도 승인 대상이다. preview 설정만으로 삭제 경로는 열리지 않는다. */
export function configuredDiskActions(db: PrismaClient): DiskActionsBridge | null {
  const token = process.env.ONQ_DISK_ACTIONS_TOKEN, callbackToken = process.env.ONQ_DISK_CALLBACK_TOKEN;
  if (process.env.ONQ_DISK_ACTIONS_MODE !== "preview" || !token || !callbackToken || callbackToken.length < 32) return null;
  return new DiskActionsBridge(db, diskActionsTransport(token), callbackToken, false);
}

export class DiskActionsBridge implements DiskOptimizationBridge {
  constructor(private readonly db: PrismaClient, private readonly transport: DiskActionsTransport, private readonly callbackToken: string, private readonly executionApproved: boolean) {}
  get executionReady() { return this.executionApproved; }
  authorized(header: string | null) {
    const value = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const a = Buffer.from(value), b = Buffer.from(this.callbackToken);
    return b.length >= 32 && a.length === b.length && timingSafeEqual(a, b);
  }
  private async api(method: "GET" | "POST", suffix: string, body?: unknown) {
    const response = await this.transport(method, `/repos/${DISK_ACTIONS_REPO}/actions/${suffix}`, body);
    if (method === "POST" ? response.status !== 204 : response.status !== 200) fail("ACTIONS_RESPONSE_UNAVAILABLE");
    return object(response.data);
  }
  private title(mode: "preview" | "execute", requestId: string) { return `MA120 ${mode.toUpperCase()} ${requestId}`; }
  private workflow(mode: "preview" | "execute") { return mode === "preview" ? DISK_PREVIEW_WORKFLOW : DISK_EXECUTE_WORKFLOW; }
  private async run(id: string, mode: "preview" | "execute", requestId: string) {
    if (!/^[1-9][0-9]{0,19}$/.test(id) || !UUID.test(requestId)) fail("INVALID_ACTIONS_CORRELATION");
    const run = await this.api("GET", `runs/${id}`);
    const repo = object(run.repository);
    if (String(run.id) !== id || repo.full_name !== DISK_ACTIONS_REPO || object(run.head_repository).full_name !== DISK_ACTIONS_REPO || run.head_branch !== "main" || run.event !== "workflow_dispatch" || run.run_attempt !== 1 || run.path !== `.github/workflows/${this.workflow(mode)}` || run.display_title !== this.title(mode, requestId)) fail("ACTIONS_RUN_MISMATCH");
    return run;
  }
  private async locate(mode: "preview" | "execute", requestId: string): Promise<string | null> {
    const result = await this.api("GET", `workflows/${this.workflow(mode)}/runs?branch=main&event=workflow_dispatch&per_page=100`);
    const runs = Array.isArray(result.workflow_runs) ? result.workflow_runs.map(object).filter(run => run.display_title === this.title(mode, requestId)) : [];
    if (runs.length > 1) fail("ACTIONS_DUPLICATE_RUN");
    if (!runs.length) return null;
    const id = String(runs[0].id); await this.run(id, mode, requestId); return id;
  }
  private async verifyRunner(runId: string) {
    const jobs = await this.api("GET", `runs/${runId}/jobs?per_page=100`);
    if (!Array.isArray(jobs.jobs) || !jobs.jobs.some(j => { const labels = object(j).labels; return Array.isArray(labels) && labels.includes("self-hosted") && labels.includes("obs-kakao"); })) fail("RUNNER_UNVERIFIED");
  }
  private async submit(mode: "preview" | "execute", requestId: string, detail: Record<string, unknown>) {
    await this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('disk_actions_transport'))`;
      if (await tx.opsEvent.findUnique({ where: where(SOURCE, `${mode}:${requestId}`) })) fail("ACTIONS_ALREADY_SUBMITTED");
      await tx.opsEvent.create({ data: { source: SOURCE, eventId: `${mode}:${requestId}`, key: "OBS_TEST", kind: "info", severity: "info", message: "전용 Actions 요청을 예약했습니다", occurredAt: await currentTime(tx), detail: { ...detail, requestId, mode, submitted: true } as Prisma.InputJsonValue } });
    });
    // 204에는 run ID가 없다. 응답 유실도 같은 요청의 run 조회로만 조정한다.
    try { await this.api("POST", `workflows/${this.workflow(mode)}/dispatches`, { ref: "main", inputs: { request_id: requestId, ...(mode === "execute" ? { candidate_fingerprint: detail.candidateFingerprint, preview_expires_at: detail.previewExpiresAt } : {}) } }); }
    catch { /* durable submitted는 남긴다. 같은 요청으로 POST하지 않는다. */ }
  }
  async preview(): Promise<DiskPreviewEvidence> {
    const row = await this.db.opsEvent.findFirst({ where: { source: SOURCE, eventId: { startsWith: "preview:" } }, orderBy: { createdAt: "desc" } });
    const detail = object(row?.detail), at = await currentTime(this.db);
    if (typeof detail.requestId === "string") {
      const id = typeof detail.runId === "string" ? detail.runId : await this.locate("preview", detail.requestId);
      if (id) {
        const run = await this.run(id, "preview", detail.requestId);
        if (run.status !== "completed") fail("PREVIEW_PENDING");
        if (run.conclusion === "success" && validDiskPreview(detail.evidence as DiskPreviewEvidence, at)) return detail.evidence as DiskPreviewEvidence;
      } else fail("PREVIEW_SUBMISSION_UNCERTAIN");
    }
    await this.submit("preview", randomUUID(), {});
    return fail("PREVIEW_PENDING");
  }
  async dispatch(input: { requestId: string; requestedByAdminId: string; candidateFingerprint: string; previewExpiresAt: string }): Promise<DiskActualJob> {
    if (!this.executionApproved) fail("EXECUTION_NOT_APPROVED");
    if (!UUID.test(input.requestId) || !HASH.test(input.candidateFingerprint)) fail("INVALID_ACTIONS_CORRELATION");
    const reservation = object((await this.db.opsEvent.findUnique({ where: where("disk_optimization_request", input.requestId) }))?.detail);
    if (reservation.result !== "RESERVED" || reservation.requestedByAdminId !== input.requestedByAdminId || reservation.candidateFingerprint !== input.candidateFingerprint || reservation.previewExpiresAt !== input.previewExpiresAt) fail("RESERVATION_REQUIRED");
    await this.submit("execute", input.requestId, input);
    return await this.resolve(input.requestId) ?? fail("DISPATCH_SUBMISSION_UNCERTAIN");
  }
  async resolve(requestId: string): Promise<DiskActualJob | null> {
    const row = await this.db.opsEvent.findUnique({ where: where(SOURCE, `execute:${requestId}`) });
    if (!row) return null;
    const id = await this.locate("execute", requestId);
    if (!id) return null;
    const d = object(row.detail);
    if (d.runId && d.runId !== id) fail("ACTIONS_RUN_MISMATCH");
    await this.db.opsEvent.update({ where: where(SOURCE, `execute:${requestId}`), data: { detail: { ...d, runId: id } as Prisma.InputJsonValue } });
    return this.job(id);
  }
  async job(id: string): Promise<DiskActualJob | null> {
    if (!/^[1-9][0-9]{0,19}$/.test(id)) return null;
    const row = await this.db.opsEvent.findFirst({ where: { source: SOURCE, detail: { path: ["runId"], equals: id } } });
    let detail = object(row?.detail);
    if (!row) {
      // lost dispatch 응답으로 runId 저장 전이라면 실제 run의 request 제목과 durable 예약을 대조한다.
      const run = await this.api("GET", `runs/${id}`);
      const match = typeof run.display_title === "string" && /^MA120 EXECUTE ([0-9a-f-]{36})$/.exec(run.display_title);
      if (!match) return null;
      const found = await this.db.opsEvent.findUnique({ where: where(SOURCE, `execute:${match[1]}`) });
      if (!found) return null;
      detail = object(found.detail);
    }
    if (typeof detail.requestId !== "string" || typeof detail.candidateFingerprint !== "string") return null;
    const run = await this.run(id, "execute", detail.requestId);
    const claim = object((await this.db.opsEvent.findUnique({ where: where(CLAIM, detail.requestId) }))?.detail);
    const result = object(claim.job);
    const base = { id, requestId: detail.requestId, target: "OBS_TEST" as const, policyVersion: "ONQ_DISK_SAFE_V1" as const, candidateFingerprint: detail.candidateFingerprint };
    let job: DiskActualJob;
    if (run.status === "queued" || run.status === "waiting" || run.status === "pending" || run.status === "requested") job = { ...base, state: "QUEUED", startedAt: null, completedAt: null, reclaimedBytes: null, errorCode: null };
    else if (run.status === "in_progress") job = { ...base, state: "RUNNING", startedAt: actionsTime(run.run_started_at), completedAt: null, reclaimedBytes: null, errorCode: null };
    else if (run.status === "completed" && run.conclusion === "success" && validDiskActualJob(result as DiskActualJob, base) && result.state === "SUCCEEDED") job = result as DiskActualJob;
    else if (run.status === "completed") job = { ...base, state: "FAILED", startedAt: actionsTime(run.run_started_at ?? run.created_at), completedAt: actionsTime(run.updated_at), reclaimedBytes: Number.isSafeInteger(result.reclaimedBytes) ? Number(result.reclaimedBytes) : null, errorCode: typeof result.errorCode === "string" ? result.errorCode : "ACTIONS_RESULT_UNVERIFIED" };
    else return null;
    if (!validDiskActualJob(job, base)) fail("ACTIONS_JOB_UNVERIFIED");
    return job;
  }
  async callback(input: unknown) {
    const b = object(input), requestId = b.requestId, runId = b.runId;
    const keys = b.action === "preview" ? ["action", "requestId", "runId", "evidence"] : b.action === "claim" ? ["action", "requestId", "runId", "candidateFingerprint", "previewExpiresAt"] : ["action", "requestId", "runId", "candidateFingerprint", "reclaimedBytes", "errorCode"];
    if (Object.keys(b).length !== keys.length || Object.keys(b).some(key => !keys.includes(key))) fail("INVALID_CALLBACK");
    if (typeof requestId !== "string" || !UUID.test(requestId) || typeof runId !== "string") fail("INVALID_CALLBACK");
    if (b.action !== "preview" && (typeof b.candidateFingerprint !== "string" || !HASH.test(b.candidateFingerprint))) fail("INVALID_CALLBACK");
    if (b.action === "claim" && (typeof b.previewExpiresAt !== "string" || !Number.isFinite(Date.parse(b.previewExpiresAt)))) fail("INVALID_CALLBACK");
    if (b.action === "preview") {
      const run = await this.run(runId, "preview", requestId);
      if (run.status !== "in_progress") fail("INVALID_CALLBACK_RUN");
      if (await this.locate("preview", requestId) !== runId) fail("ACTIONS_RUN_MISMATCH");
      await this.verifyRunner(runId);
      const evidence = b.evidence as DiskPreviewEvidence;
      if (!validDiskPreview(evidence, await currentTime(this.db))) fail("INVALID_PREVIEW_EVIDENCE");
      await this.db.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('disk_actions_preview'))`;
        const row = await tx.opsEvent.findUnique({ where: where(SOURCE, `preview:${requestId}`) });
        if (!row || object(row.detail).runId) fail("CALLBACK_ALREADY_RECORDED");
        await tx.opsEvent.update({ where: where(SOURCE, `preview:${requestId}`), data: { detail: { ...object(row.detail), runId, evidence } as Prisma.InputJsonValue } });
      });
      return { ok: true };
    }
    if (!this.executionApproved || (b.action !== "claim" && b.action !== "result")) fail("EXECUTION_NOT_APPROVED");
    const run = await this.run(runId, "execute", requestId);
    if (run.status !== "in_progress") fail("INVALID_CALLBACK_RUN");
    if (await this.locate("execute", requestId) !== runId) fail("ACTIONS_RUN_MISMATCH");
    await this.verifyRunner(runId);
    if (b.action === "claim") {
      const deploy = await this.api("GET", "workflows/deploy-obs-test.yml/runs?branch=main&status=in_progress&per_page=100");
      if (!Array.isArray(deploy.workflow_runs) || deploy.workflow_runs.length) fail("DEPLOYMENT_BUSY");
    }
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('disk_actions_claim'))`;
      const transport = await tx.opsEvent.findUnique({ where: where(SOURCE, `execute:${requestId}`) });
      const d = object(transport?.detail), at = await currentTime(tx);
      if (!transport || (d.runId && d.runId !== runId) || d.candidateFingerprint !== b.candidateFingerprint) fail("CLAIM_CANDIDATE_MISMATCH");
      const previous = await tx.opsEvent.findUnique({ where: where(CLAIM, requestId) });
      if (b.action === "claim") {
        if (previous) fail("CLAIM_ALREADY_TAKEN");
        const reservation = object((await tx.opsEvent.findUnique({ where: where("disk_optimization_request", requestId) }))?.detail);
        if (!["RESERVED", "DISPATCHED", "DISPATCH_UNCERTAIN"].includes(String(reservation.result)) || reservation.candidateFingerprint !== b.candidateFingerprint || reservation.previewExpiresAt !== b.previewExpiresAt || typeof reservation.adminSessionId !== "string" || typeof reservation.previewExpiresAt !== "string" || !Number.isFinite(Date.parse(reservation.previewExpiresAt)) || Date.parse(reservation.previewExpiresAt) <= at.getTime()) fail("CLAIM_EXPIRED_OR_UNRESERVED");
        const session = await tx.adminSession.findUnique({ where: { id: reservation.adminSessionId }, include: { admin: true } });
        if (!session || session.revokedAt || session.expiresAt <= at || session.adminId !== reservation.requestedByAdminId || session.admin.status !== "ACTIVE" || !adminCan(session.admin.role, "infra.manage")) fail("CLAIM_PERMISSION_REVOKED");
        const job: DiskActualJob = { id: runId, requestId, target: "OBS_TEST", policyVersion: "ONQ_DISK_SAFE_V1", candidateFingerprint: String(b.candidateFingerprint), state: "RUNNING", startedAt: at.toISOString(), completedAt: null, reclaimedBytes: null, errorCode: null };
        await tx.opsEvent.create({ data: { source: CLAIM, eventId: requestId, key: "OBS_TEST", kind: "info", severity: "info", message: "전용 runner가 단일 실행권을 받았습니다", occurredAt: at, detail: { job } as Prisma.InputJsonValue } });
        await tx.opsEvent.update({ where: where(SOURCE, `execute:${requestId}`), data: { detail: { ...d, runId } as Prisma.InputJsonValue } });
        return { ok: true, job };
      }
      const job = object(object(previous?.detail).job);
      if (!previous || job.id !== runId || job.state !== "RUNNING" || !Number.isSafeInteger(b.reclaimedBytes) || Number(b.reclaimedBytes) < 0 || (b.errorCode !== null && (typeof b.errorCode !== "string" || !/^[A-Z0-9_]{1,80}$/.test(b.errorCode)))) fail("INVALID_RESULT_EVIDENCE");
      const completed = { ...job, state: b.errorCode === null ? "SUCCEEDED" : "FAILED", completedAt: at.toISOString(), reclaimedBytes: b.reclaimedBytes, errorCode: b.errorCode };
      if (!validDiskActualJob(completed as DiskActualJob)) fail("INVALID_RESULT_EVIDENCE");
      await tx.opsEvent.update({ where: where(CLAIM, requestId), data: { detail: { job: completed } as Prisma.InputJsonValue } });
      return { ok: true };
    });
  }
}
