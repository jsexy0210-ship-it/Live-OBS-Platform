import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { configuredDiskActions, diskActionsTransport, DiskActionsBridge, DISK_ACTIONS_REPO, DISK_EXECUTE_WORKFLOW, DISK_PREVIEW_WORKFLOW, type DiskActionsTransport } from "../../lib/server/ops/diskOptimizationActions";
import { diskCandidateFingerprint, type DiskPreviewEvidence } from "../../lib/server/ops/diskOptimizationBridge";

const ownedPem = Buffer.from(generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey).toString("base64");
const id = "00000000-0000-4000-8000-000000000001", fp = "a".repeat(64), token = "owned-callback-fixture-".repeat(3);
const expires = "2026-10-13T00:05:00.000Z";
const preview = (): DiskPreviewEvidence => ({ target: "OBS_TEST", policyVersion: "ONQ_DISK_SAFE_V1", checkedAt: "2026-10-13T00:00:00.000Z", expiresAt: expires, hostValidated: true, runnerValidated: true, deploymentConcurrencyVerified: true, candidates: [{ category: "RUNNER_DIAGNOSTIC_LOGS_OLDER_THAN_14_DAYS", id: "Worker_owned.log", bytes: 20, contentHash: fp }] });
type Row = { source: string; eventId: string; detail: Record<string, unknown> };
function fixture(approved = true) {
  const rows = new Map<string, Row>(), runs: Record<string, unknown>[] = [];
  let now = new Date("2026-10-13T00:00:00.000Z"), lost = false, createRun = true, busy = false;
  const session = { adminId: "owned-admin", revokedAt: null as Date | null, expiresAt: new Date(expires), admin: { status: "ACTIVE", role: "SUPER_ADMIN" } };
  const key = (w: { source_eventId: { source: string; eventId: string } }) => `${w.source_eventId.source}:${w.source_eventId.eventId}`;
  let transaction = Promise.resolve();
  const raw = { $executeRaw: vi.fn(async () => 1), $queryRaw: vi.fn(async () => [{ now }]), adminSession: { findUnique: vi.fn(async () => session) }, opsEvent: {
    findUnique: vi.fn(async ({ where }) => rows.get(key(where)) ?? null),
    findFirst: vi.fn(async ({ where }) => [...rows.values()].reverse().find(row => row.source === where.source && (!where.eventId || row.eventId.startsWith(where.eventId.startsWith)) && (!where.detail || row.detail[where.detail.path[0]] === where.detail.equals)) ?? null),
    create: vi.fn(async ({ data }) => { const k = `${data.source}:${data.eventId}`; if (rows.has(k)) throw new Error("duplicate"); rows.set(k, data); return data; }),
    update: vi.fn(async ({ where, data }) => { const row = rows.get(key(where)); if (!row) throw new Error("missing"); Object.assign(row, data); return row; }),
  }, $transaction: async <T>(callback: (db: unknown) => Promise<T>) => {
    const prior = transaction; let release!: () => void;
    transaction = new Promise(resolve => { release = resolve; });
    await prior;
    try { return await callback(raw); } finally { release(); }
  } };
  const makeRun = (requestId: string, mode: string, runId = "101") => ({ id: Number(runId), repository: { full_name: DISK_ACTIONS_REPO }, head_repository: { full_name: DISK_ACTIONS_REPO }, path: `.github/workflows/${mode === "execute" ? DISK_EXECUTE_WORKFLOW : DISK_PREVIEW_WORKFLOW}`, head_branch: "main", event: "workflow_dispatch", run_attempt: 1, display_title: `MA120 ${mode.toUpperCase()} ${requestId}`, status: "queued", conclusion: null, run_started_at: "2026-10-13T00:00:00Z", updated_at: "2026-10-13T00:01:00Z" });
  const transport = vi.fn<DiskActionsTransport>(async (method, path, body) => {
    expect(path.startsWith(`/repos/${DISK_ACTIONS_REPO}/actions/`)).toBe(true);
    if (method === "POST") {
      // 실제 API에 보내기 전에 예약이 커밋돼 있어야 한다.
      const b = body as { ref: string; inputs: { request_id: string } };
      expect(b.ref).toBe("main");
      const mode = path.includes(DISK_EXECUTE_WORKFLOW) ? "execute" : "preview";
      expect(rows.has(`disk_actions_transport:${mode}:${b.inputs.request_id}`)).toBe(true);
      if (createRun) runs.push(makeRun(b.inputs.request_id, mode));
      if (lost) throw new Error("owned response lost");
      return { status: 204, data: null };
    }
    if (path.endsWith("/jobs?per_page=100")) return { status: 200, data: { jobs: [{ labels: ["self-hosted", "obs-kakao"] }] } };
    if (path.includes("deploy-obs-test.yml")) return { status: 200, data: { workflow_runs: busy ? [{}] : [] } };
    if (path.includes("/workflows/")) return { status: 200, data: { workflow_runs: runs } };
    return { status: 200, data: runs.find(run => String(run.id) === path.split("/").at(-1)) ?? {} };
  });
  const db = raw as unknown as PrismaClient;
  const bridge = new DiskActionsBridge(db, transport, token, approved);
  const input = { requestId: id, requestedByAdminId: "owned-admin", candidateFingerprint: fp, previewExpiresAt: expires };
  const reserve = () => rows.set(`disk_optimization_request:${id}`, { source: "disk_optimization_request", eventId: id, detail: { ...input, result: "RESERVED", adminSessionId: "owned-session" } });
  const claim = () => ({ action: "claim", requestId: id, runId: "101", candidateFingerprint: fp, previewExpiresAt: expires });
  return { db, rows, runs, transport, bridge, input, reserve, claim, session, makeRun, setTime: (at: string) => { now = new Date(at); }, loseResponse: () => { lost = true; }, omitRun: () => { createRun = false; }, busyDeploy: () => { busy = true; } };
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("ONQ 전용 실제 Actions 응답 계약", () => {
  it("실제 transport는 고정 API의 preview만 접수하고 실행·경로 탈출·배포 접수는 거부한다", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const transport = diskActionsTransport("owned-transport-fixture");
    const prefix = `/repos/${DISK_ACTIONS_REPO}/actions/`;
    for (const path of [`${prefix}workflows/${DISK_EXECUTE_WORKFLOW}/dispatches`, `${prefix}../../other`, `${prefix}workflows/deploy-obs-test.yml/dispatches`, `${prefix}workflows/unapproved.yml/dispatches`, `${prefix}runs/101#fragment`, `/repos/other/repo/actions/runs/101`]) {
      await expect(transport("POST", path)).rejects.toThrow("ACTIONS_TARGET_DENIED");
    }
    expect(fetch).not.toHaveBeenCalled();
    await expect(transport("POST", `${prefix}workflows/${DISK_PREVIEW_WORKFLOW}/dispatches`, { ref: "main" })).resolves.toEqual({ status: 204, data: null });
    expect(fetch).toHaveBeenCalledWith(`https://api.github.com${prefix}workflows/${DISK_PREVIEW_WORKFLOW}/dispatches`, expect.objectContaining({ method: "POST", redirect: "error", cache: "no-store" }));
  });
  it("읽기 자격이 구성돼도 production factory의 실행 승인과 POST는 열리지 않는다", async () => {
    vi.stubEnv("ONQ_DISK_ACTIONS_MODE", "preview"); vi.stubEnv("ONQ_DISK_APP_ID", "1"); vi.stubEnv("ONQ_DISK_INSTALLATION_ID", "2"); vi.stubEnv("ONQ_DISK_APP_PRIVATE_KEY_BASE64", ownedPem); vi.stubEnv("ONQ_DISK_CALLBACK_TOKEN", token);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const bridge = configuredDiskActions(fixture().db);
    expect(bridge?.executionReady).toBe(false);
    await expect(bridge!.dispatch(fixture().input)).rejects.toThrow("EXECUTION_NOT_APPROVED");
    expect(fetch).not.toHaveBeenCalled();
    vi.stubEnv("ONQ_DISK_ACTIONS_MODE", "execute");
    expect(configuredDiskActions(fixture().db)).toBeNull();
  });
  it("미설정과 preview-only 설정은 실행 권한을 만들지 않는다", async () => {
    vi.stubEnv("ONQ_DISK_ACTIONS_MODE", ""); vi.stubEnv("ONQ_DISK_ACTIONS_TOKEN", ""); vi.stubEnv("ONQ_DISK_CALLBACK_TOKEN", "");
    const f = fixture(false);
    expect(configuredDiskActions(f.db)).toBeNull();
    expect(f.bridge.authorized(`Bearer ${token}`)).toBe(true);
    expect(f.bridge.authorized("Bearer wrong")).toBe(false);
    await expect(f.bridge.dispatch(f.input)).rejects.toThrow("EXECUTION_NOT_APPROVED");
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("App 자격 사전검증 실패는 workflow POST나 불확실 송신 예약을 남기지 않는다", async () => {
    vi.stubEnv("ONQ_DISK_ACTIONS_MODE", "preview"); vi.stubEnv("ONQ_DISK_APP_ID", "1"); vi.stubEnv("ONQ_DISK_INSTALLATION_ID", "2"); vi.stubEnv("ONQ_DISK_APP_PRIVATE_KEY_BASE64", ownedPem); vi.stubEnv("ONQ_DISK_CALLBACK_TOKEN", token);
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ error: "owned auth unavailable" }, { status: 403 })); vi.stubGlobal("fetch", fetch);
    const f = fixture(), bridge = configuredDiskActions(f.db)!;
    await expect(bridge.preview()).rejects.toThrow("ACTIONS_APP_AUTH_UNAVAILABLE");
    expect(f.rows.size).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`https://api.github.com/repos/${DISK_ACTIONS_REPO}/installation`, expect.objectContaining({ method: "GET" }));
  });
  it("앱의 durable 예약 없는 접수는 POST0이다", async () => {
    const f = fixture();
    await expect(f.bridge.dispatch(f.input)).rejects.toThrow("RESERVATION_REQUIRED");
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("204를 가짜 job으로 바꾸지 않고 main의 실제 run ID를 조회한다", async () => {
    const f = fixture(); f.reserve();
    expect(await f.bridge.dispatch(f.input)).toMatchObject({ id: "101", requestId: id, state: "QUEUED" });
    expect(f.transport.mock.calls.filter(call => call[0] === "POST")).toHaveLength(1);
    await expect(f.bridge.dispatch(f.input)).rejects.toThrow("ACTIONS_ALREADY_SUBMITTED");
    expect(f.transport.mock.calls.filter(call => call[0] === "POST")).toHaveLength(1);
  });
  it("POST 응답 유실 후 이미 생성된 실제 run만 대조한다", async () => {
    const f = fixture(); f.reserve(); f.loseResponse();
    expect(await f.bridge.dispatch(f.input)).toMatchObject({ id: "101", state: "QUEUED" });
    expect(await f.bridge.resolve(id)).toMatchObject({ id: "101" });
    expect(f.transport.mock.calls.filter(call => call[0] === "POST")).toHaveLength(1);
  });
  it("응답과 run이 아직 없으면503 경계를 유지하고 나중 조회에도 POST하지 않는다", async () => {
    const f = fixture(); f.reserve(); f.loseResponse(); f.omitRun();
    await expect(f.bridge.dispatch(f.input)).rejects.toThrow("DISPATCH_SUBMISSION_UNCERTAIN");
    expect(await f.bridge.resolve(id)).toBeNull();
    f.runs.push(f.makeRun(id, "execute"));
    expect(await f.bridge.resolve(id)).toMatchObject({ id: "101" });
    expect(f.transport.mock.calls.filter(call => call[0] === "POST")).toHaveLength(1);
  });
  it("다른 저장소/branch/workflow/재실행/run명과 중복 run은 증거가 아니다", async () => {
    for (const change of [{ repository: { full_name: "other/repo" } }, { head_repository: { full_name: "other/repo" } }, { head_branch: "other" }, { path: ".github/workflows/disk-cleanup-obs-test.yml" }, { run_attempt: 2 }, { display_title: "unrelated" }]) {
      const f = fixture(); f.reserve(); await f.bridge.dispatch(f.input); Object.assign(f.runs[0], change);
      await expect(f.bridge.job("101")).rejects.toThrow("ACTIONS_RUN_MISMATCH");
      expect(f.rows.has(`disk_actions_claim:${id}`)).toBe(false);
    }
    const f = fixture(); f.reserve(); await f.bridge.dispatch(f.input); f.runs.push(f.makeRun(id, "execute", "102"));
    await expect(f.bridge.resolve(id)).rejects.toThrow("ACTIONS_DUPLICATE_RUN");
  });
});

describe("runner 원자 claim과 실제 완료 증거", () => {
  async function submitted() { const f = fixture(); f.reserve(); await f.bridge.dispatch(f.input); f.runs[0].status = "in_progress"; return f; }
  it("동시 claim은 하나만 받고 같은 run의 재claim도 거부한다", async () => {
    const f = await submitted();
    const results = await Promise.allSettled([f.bridge.callback(f.claim()), f.bridge.callback(f.claim())]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(f.rows.get(`disk_actions_claim:${id}`)?.detail.job).toMatchObject({ id: "101", state: "RUNNING" });
  });
  it("만료 경계·권한 철회·동시 배포·다른 후보는 claim0이다", async () => {
    for (const reason of ["preview", "session", "role", "revoked", "deploy", "candidate"]) {
      const f = await submitted(), claim = f.claim();
      if (reason === "preview") f.setTime(expires);
      if (reason === "session") f.session.expiresAt = new Date("2026-10-13T00:00:00.000Z");
      if (reason === "role") f.session.admin.role = "OPERATIONS";
      if (reason === "revoked") f.session.revokedAt = new Date("2026-10-13T00:00:00.000Z");
      if (reason === "deploy") f.busyDeploy();
      if (reason === "candidate") claim.candidateFingerprint = "b".repeat(64);
      await expect(f.bridge.callback(claim)).rejects.toThrow();
      expect(f.rows.has(`disk_actions_claim:${id}`)).toBe(false);
    }
  });
  it("Actions success만으로 정리 성공을 표시하지 않는다", async () => {
    const f = await submitted(); f.runs[0].status = "completed"; f.runs[0].conclusion = "success";
    expect(await f.bridge.job("101")).toMatchObject({ state: "FAILED", reclaimedBytes: null, errorCode: "ACTIONS_RESULT_UNVERIFIED" });
  });
  it("단일 claim의 실측 결과와 Actions 완료가 모두 있어야 성공한다", async () => {
    const f = await submitted(); await f.bridge.callback(f.claim());
    f.setTime("2026-10-13T00:01:00.000Z");
    await f.bridge.callback({ action: "result", requestId: id, runId: "101", candidateFingerprint: fp, reclaimedBytes: 90, errorCode: null });
    expect(await f.bridge.job("101")).toMatchObject({ state: "RUNNING", reclaimedBytes: null });
    f.runs[0].status = "completed"; f.runs[0].conclusion = "success";
    expect(await f.bridge.job("101")).toMatchObject({ state: "SUCCEEDED", reclaimedBytes: 90 });
  });
  it("claim 없는 결과/음수 실측/추가 필드/다른 run은 기록0이다", async () => {
    const f = await submitted();
    const result = { action: "result", requestId: id, runId: "101", candidateFingerprint: fp, reclaimedBytes: 90, errorCode: null };
    await expect(f.bridge.callback(result)).rejects.toThrow("INVALID_RESULT_EVIDENCE");
    await f.bridge.callback(f.claim());
    for (const bad of [{ ...result, reclaimedBytes: -1 }, { ...result, command: "custom" }, { ...result, runId: "102" }]) await expect(f.bridge.callback(bad)).rejects.toThrow();
    expect(f.rows.get(`disk_actions_claim:${id}`)?.detail.job).toMatchObject({ state: "RUNNING" });
  });
  it("preview callback은 실제 전용 run 완료 뒤에만 후보 증거가 된다", async () => {
    const f = fixture(false);
    await expect(f.bridge.preview()).rejects.toThrow("PREVIEW_PENDING");
    const requestId = String([...f.rows.values()][0].detail.requestId);
    f.runs[0].status = "in_progress";
    await f.bridge.callback({ action: "preview", requestId, runId: "101", evidence: preview() });
    await expect(f.bridge.preview()).rejects.toThrow("PREVIEW_PENDING");
    f.runs[0].status = "completed"; f.runs[0].conclusion = "success";
    expect(diskCandidateFingerprint((await f.bridge.preview()).candidates)).toBe(diskCandidateFingerprint(preview().candidates));
    expect(f.transport.mock.calls.filter(call => call[0] === "POST")).toHaveLength(1);
  });
});
