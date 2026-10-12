import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../../lib/server/auth/session";
import { DISK_OPTIMIZATION_POLICY as policy } from "../../lib/server/ops/diskOptimization";
import { diskCandidateFingerprint, validDiskActualJob, validDiskPreview, type DiskActualJob, type DiskOptimizationBridge, type DiskPreviewEvidence } from "../../lib/server/ops/diskOptimizationBridge";
import { executeApprovedDiskOptimization, previewApprovedDiskOptimization, readApprovedDiskOptimizationJob } from "../../lib/server/ops/diskOptimizationConnected";

const { clock } = vi.hoisted(() => ({ clock: { at: new Date("2026-10-13T00:00:00.000Z") } }));
vi.mock("../../lib/server/billing/subscription", () => ({ dbNow: async (db: { transactionStartedAt?: Date }) => db.transactionStartedAt ?? clock.at }));
vi.mock("../../lib/server/audit/log", () => ({ writeAudit: vi.fn(async () => undefined) }));
const admin = { admin: { id: "synthetic-admin", role: "SUPER_ADMIN" }, sessionId: "synthetic-session" } as AdminSessionContext;
const requestId = "00000000-0000-4000-8000-000000000001";
const hash = "a".repeat(64);
const preview = (): DiskPreviewEvidence => ({ target: "OBS_TEST", policyVersion: policy.version, checkedAt: "2026-10-12T23:59:59.000Z", expiresAt: "2026-10-13T00:05:00.000Z", hostValidated: true, runnerValidated: true, deploymentConcurrencyVerified: true, candidates: [
  { category: "OLD_ONQ_NON_ROLLBACK_IMAGES", id: `sha256:${hash}`, bytes: 100, contentHash: hash },
  { category: "RUNNER_DIAGNOSTIC_LOGS_OLDER_THAN_14_DAYS", id: "Worker_owned.log", bytes: 20, contentHash: "b".repeat(64) },
] });
const job = (): DiskActualJob => ({ id: "12345", requestId, target: "OBS_TEST", policyVersion: policy.version, candidateFingerprint: diskCandidateFingerprint(preview().candidates), state: "QUEUED", startedAt: null, completedAt: null, reclaimedBytes: null, errorCode: null });
function fixture() {
  const events = new Map<string, { detail: unknown }>();
  const session = { adminId: admin.admin.id, revokedAt: null as Date | null, expiresAt: new Date("2026-10-14T00:00:00Z"), admin: { status: "ACTIVE", role: "SUPER_ADMIN" } };
  const key = (x: { source_eventId: { source: string; eventId: string } }) => `${x.source_eventId.source}:${x.source_eventId.eventId}`;
  const raw = { transactionStartedAt: undefined as Date | undefined, $queryRaw: vi.fn(async () => [{ now: clock.at }]), adminSession: { findUnique: vi.fn(async () => session) }, $executeRaw: vi.fn(async () => 1), opsEvent: {
    findUnique: vi.fn(async ({ where }) => events.get(key(where)) ?? null),
    upsert: vi.fn(async ({ where, create }) => { if (!events.has(key(where))) events.set(key(where), create); return events.get(key(where)); }),
    create: vi.fn(async ({ data }) => { const k = `${data.source}:${data.eventId}`; if (events.has(k)) throw new Error("duplicate"); events.set(k, data); return data; }),
  }, $transaction: async <T>(fn: (db: unknown) => Promise<T>) => {
    raw.transactionStartedAt = clock.at;
    try { return await fn(raw); } finally { raw.transactionStartedAt = undefined; }
  } };
  const db = raw as unknown as PrismaClient;
  const bridge: DiskOptimizationBridge = { preview: vi.fn(async () => preview()), dispatch: vi.fn(async () => job()), job: vi.fn(async () => job()) };
  return { db, bridge, session, events };
}
const input = () => ({ actionId: policy.actionId, policyVersion: policy.version, idempotencyKey: requestId, candidateFingerprint: diskCandidateFingerprint(preview().candidates), previewExpiresAt: preview().expiresAt });
beforeEach(() => { clock.at = new Date("2026-10-13T00:00:00Z"); });

describe("전용 두 범주 실제 증거 계약", () => {
  it("정확한 범주/식별자/필드만 받고 manifest 순서와 무관하게 동일 fingerprint를 만든다", () => {
    const p = preview();
    expect(validDiskPreview(p, clock.at)).toBe(true);
    expect(diskCandidateFingerprint(p.candidates)).toBe(diskCandidateFingerprint([...p.candidates].reverse()));
    expect(diskCandidateFingerprint([{ ...p.candidates[0], bytes: 101 }, p.candidates[1]])).not.toBe(diskCandidateFingerprint(p.candidates));
    for (const candidates of [[...p.candidates, p.candidates[0]], [{ ...p.candidates[1], id: "../Worker_owned.log" }], [{ ...p.candidates[0], path: "/backup" }], [{ ...p.candidates[0], category: "BACKUPS" }]]) expect(validDiskPreview({ ...p, candidates } as DiskPreviewEvidence, clock.at)).toBe(false);
    expect(validDiskPreview({ ...p, deploymentConcurrencyVerified: false } as unknown as DiskPreviewEvidence, clock.at)).toBe(false);
  });
  it("요청UUID를 실제job으로 바꾸거나 완료 증거 없이 성공하지 않는다", () => {
    expect(validDiskActualJob(job())).toBe(true);
    expect(validDiskActualJob({ ...job(), id: requestId })).toBe(false);
    expect(validDiskActualJob({ ...job(), state: "SUCCEEDED" })).toBe(false);
    expect(validDiskActualJob({ ...job(), state: "SUCCEEDED", startedAt: preview().checkedAt, completedAt: clock.at.toISOString(), reclaimedBytes: 90 })).toBe(true);
    expect(validDiskActualJob({ ...job(), command: "custom" } as DiskActualJob)).toBe(false);
  });
  it("미연결 bridge는 preview503과 numeric job404를 정직하게 유지한다", async () => {
    const { db } = fixture();
    expect(await previewApprovedDiskOptimization(db, admin, { actionId: policy.actionId, policyVersion: policy.version }, null)).toMatchObject({ status: 503, job: null, candidates: null });
    expect(await readApprovedDiskOptimizationJob(db, admin, "12345", null)).toMatchObject({ status: 404, job: null });
  });
});
describe("발급 preview와 실행 직전 원천 재검사", () => {
  async function issued() {
    const f = fixture();
    expect(await previewApprovedDiskOptimization(f.db, admin, { actionId: policy.actionId, policyVersion: policy.version }, f.bridge)).toMatchObject({ status: 200, estimatedReclaimedBytes: 120 });
    return f;
  }
  it("서버발급 없는 임의 후보는 dispatch하지 않는다", async () => {
    const f = fixture();
    expect(await executeApprovedDiskOptimization(f.db, admin, input(), {}, f.bridge)).toMatchObject({ status: 409, reason: "preview_not_issued" });
    expect(f.bridge.dispatch).not.toHaveBeenCalled();
  });
  it("fresh 후보가 같을 때만 접수하고 동일키 반복은 실제job 조회만 한다", async () => {
    const f = await issued();
    expect(await executeApprovedDiskOptimization(f.db, admin, input(), {}, f.bridge)).toMatchObject({ status: 202, job: { id: "12345", state: "QUEUED" } });
    expect(await executeApprovedDiskOptimization(f.db, admin, input(), {}, f.bridge)).toMatchObject({ status: 200, replayed: true });
    expect(f.bridge.dispatch).toHaveBeenCalledTimes(1);
    expect(await executeApprovedDiskOptimization(f.db, admin, { ...input(), candidateFingerprint: "c".repeat(64) }, {}, f.bridge)).toMatchObject({ status: 409, reason: "idempotency_conflict" });
  });
  it("대상 변화나 만료는 실행0으로 거부한다", async () => {
    const f = await issued();
    vi.mocked(f.bridge.preview).mockResolvedValueOnce({ ...preview(), candidates: [] });
    expect(await executeApprovedDiskOptimization(f.db, admin, input(), {}, f.bridge)).toMatchObject({ status: 409, reason: "candidate_changed" });
    clock.at = new Date(preview().expiresAt);
    expect(await executeApprovedDiskOptimization(f.db, admin, input(), {}, f.bridge)).toMatchObject({ status: 409, reason: "preview_expired" });
    expect(f.bridge.dispatch).not.toHaveBeenCalled();
  });
  it("fresh 조회 중 preview 만료시각에 도달하면 트랜잭션 시작시각과 무관하게 dispatch0이다", async () => {
    const f = await issued();
    vi.mocked(f.bridge.preview).mockImplementationOnce(async () => { clock.at = new Date(preview().expiresAt); return preview(); });
    expect(await executeApprovedDiskOptimization(f.db, admin, input(), {}, f.bridge)).toMatchObject({ status: 409, reason: "preview_expired" });
    expect(f.db.$queryRaw).toHaveBeenCalledWith(["SELECT clock_timestamp() AS now"]);
    expect(f.bridge.dispatch).not.toHaveBeenCalled();
  });
  it("fresh 조회 중 활성 세션 만료시각에 도달해도 dispatch0이다", async () => {
    const f = await issued();
    f.session.expiresAt = new Date("2026-10-13T00:01:00.000Z");
    vi.mocked(f.bridge.preview).mockImplementationOnce(async () => { clock.at = f.session.expiresAt; return preview(); });
    await expect(executeApprovedDiskOptimization(f.db, admin, input(), {}, f.bridge)).rejects.toThrow("forbidden");
    expect(f.db.$queryRaw).toHaveBeenCalledWith(["SELECT clock_timestamp() AS now"]);
    expect(f.bridge.dispatch).not.toHaveBeenCalled();
  });
  it("fresh 조회 동안 SUPER 권한/세션이 바뀌면 실제접수를 막는다", async () => {
    const f = await issued();
    vi.mocked(f.bridge.preview).mockImplementationOnce(async () => { f.session.admin.role = "OPERATIONS"; return preview(); });
    await expect(executeApprovedDiskOptimization(f.db, admin, input(), {}, f.bridge)).rejects.toThrow("forbidden");
    expect(f.bridge.dispatch).not.toHaveBeenCalled();
  });
  it("불확실한 접수는503을 기록하고 동일키로 다시 dispatch하지 않는다", async () => {
    const f = await issued();
    vi.mocked(f.bridge.dispatch).mockRejectedValueOnce(new Error("unavailable"));
    expect(await executeApprovedDiskOptimization(f.db, admin, input(), {}, f.bridge)).toMatchObject({ status: 503, job: null, replayed: false });
    expect(await executeApprovedDiskOptimization(f.db, admin, input(), {}, f.bridge)).toMatchObject({ status: 503, job: null, replayed: true });
    expect(f.bridge.dispatch).toHaveBeenCalledTimes(1);
  });
  it("실제job은 접수기록과 일치해야 하며 미등록작업은404다", async () => {
    const f = await issued();
    expect(await readApprovedDiskOptimizationJob(f.db, admin, "12345", f.bridge)).toMatchObject({ status: 404 });
    await executeApprovedDiskOptimization(f.db, admin, input(), {}, f.bridge);
    expect(await readApprovedDiskOptimizationJob(f.db, admin, "12345", f.bridge)).toMatchObject({ status: 200, job: { id: "12345" } });
  });
});
