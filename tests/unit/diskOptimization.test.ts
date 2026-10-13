import { describe, expect, it } from "vitest";
import type { AdminSessionContext } from "../../lib/server/auth/session";
import { DISK_OPTIMIZATION_POLICY as policy, diskOptimizationJob, diskReadiness, previewDiskOptimization } from "../../lib/server/ops/diskOptimization";

const admin = (role = "SUPER_ADMIN") => ({ admin: { id: "admin", role } }) as unknown as AdminSessionContext;
const body = { actionId: policy.actionId, policyVersion: policy.version };

describe("디스크 최적화 차단 계약", () => {
  it("미검증 호스트는 후보/예상회수량/만료시각을 만들어 내지 않는다", () => {
    expect(previewDiskOptimization(admin(), body)).toMatchObject({ ok: false, status: 503, candidates: null, candidateFingerprint: null, expiresAt: null, estimatedReclaimedBytes: null, job: null });
    expect(diskReadiness()).toMatchObject({ autoEnableAllowed: false, manualExecuteAllowed: false });
    expect(policy.excludedCategories).toEqual(expect.arrayContaining(["GLOBAL_DOCKER_PRUNE", "UNKNOWN_OWNER_CACHE", "DB_VOLUMES", "CONTAINERS", "BACKUPS", "ROLLBACK_IMAGES", "CHECKOUT_ARTIFACTS"]));
  });
  it("임의 명령/경로/env/정책은 고정 preview로 전달하지 않는다", () => {
    for (const extra of [{ path: "/" }, { command: "rm -rf /" }, { env: {} }, { actionId: "CUSTOM" }, { policyVersion: "CUSTOM" }]) {
      expect(previewDiskOptimization(admin(), { ...body, ...extra })).toMatchObject({ ok: false, status: 400 });
    }
    for (const role of ["OPERATIONS", "CS", "READ_ONLY"]) expect(() => previewDiskOptimization(admin(role), body)).toThrow("forbidden");
  });
  it("거부 요청을 실제 job으로 표시하지 않는다", () => {
    expect(diskOptimizationJob(admin(), "00000000-0000-4000-8000-000000000001")).toMatchObject({ status: 404, job: null });
    expect(diskOptimizationJob(admin(), "../../" + "a".repeat(100))).toMatchObject({ status: 400 });
  });
});
