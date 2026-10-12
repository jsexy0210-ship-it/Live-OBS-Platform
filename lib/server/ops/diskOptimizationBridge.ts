import { createHash } from "node:crypto";

export type DiskCandidate = {
  category: "OLD_ONQ_NON_ROLLBACK_IMAGES" | "RUNNER_DIAGNOSTIC_LOGS_OLDER_THAN_14_DAYS";
  id: string;
  bytes: number;
  contentHash: string;
};
export type DiskPreviewEvidence = {
  target: "OBS_TEST";
  policyVersion: "ONQ_DISK_SAFE_V1";
  checkedAt: string;
  expiresAt: string;
  hostValidated: true;
  runnerValidated: true;
  deploymentConcurrencyVerified: true;
  candidates: DiskCandidate[];
};
export type DiskActualJob = {
  id: string;
  requestId: string;
  target: "OBS_TEST";
  policyVersion: "ONQ_DISK_SAFE_V1";
  candidateFingerprint: string;
  state: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  startedAt: string | null;
  completedAt: string | null;
  reclaimedBytes: number | null;
  errorCode: string | null;
};

/** 전용 runner의 실제 증거만 읽는 경계. 인증과 호스트 연결은 별도 검증 게이트에서 구성한다. */
export interface DiskOptimizationBridge {
  preview(): Promise<DiskPreviewEvidence>;
  dispatch(input: { requestId: string; requestedByAdminId: string; candidateFingerprint: string; previewExpiresAt: string }): Promise<DiskActualJob>;
  job(id: string): Promise<DiskActualJob | null>;
}

// 현재 bridge는 미연결이다. 원천이나 성공 job을 만들어 readiness를 열지 않는다.
export const configuredDiskOptimizationBridge = (): DiskOptimizationBridge | null => null;

const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const exact = (v: unknown, keys: string[]) => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === keys.length && Object.keys(v).every(k => keys.includes(k));
const iso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export function validDiskPreview(v: DiskPreviewEvidence, now: Date): boolean {
  if (!exact(v, ["target", "policyVersion", "checkedAt", "expiresAt", "hostValidated", "runnerValidated", "deploymentConcurrencyVerified", "candidates"]) || v.target !== "OBS_TEST" || v.policyVersion !== "ONQ_DISK_SAFE_V1" || v.hostValidated !== true || v.runnerValidated !== true || v.deploymentConcurrencyVerified !== true || !iso(v.checkedAt) || !iso(v.expiresAt) || Date.parse(v.checkedAt) > now.getTime() || Date.parse(v.expiresAt) <= now.getTime() || Date.parse(v.checkedAt) >= Date.parse(v.expiresAt) || !Array.isArray(v.candidates)) return false;
  const seen = new Set<string>();
  return v.candidates.every(c => {
    if (!exact(c, ["category", "id", "bytes", "contentHash"]) || !Number.isSafeInteger(c.bytes) || c.bytes < 0 || typeof c.id !== "string" || typeof c.contentHash !== "string" || !HASH.test(c.contentHash)) return false;
    const validId = c.category === "OLD_ONQ_NON_ROLLBACK_IMAGES" ? /^sha256:[0-9a-f]{64}$/.test(c.id) : c.category === "RUNNER_DIAGNOSTIC_LOGS_OLDER_THAN_14_DAYS" && /^(Runner|Worker)_[A-Za-z0-9_.-]+\.log$/.test(c.id);
    const key = `${c.category}:${c.id}`;
    if (!validId || seen.has(key)) return false;
    seen.add(key); return true;
  });
}
export function diskCandidateFingerprint(candidates: DiskCandidate[]): string {
  const lines = candidates.map(c => `${c.category}\t${c.id}\t${c.bytes}\t${c.contentHash}\n`).sort();
  return createHash("sha256").update(`ONQ_DISK_SAFE_V1\n${lines.join("")}`).digest("hex");
}
export function validDiskActualJob(job: DiskActualJob, expected: { requestId?: string; candidateFingerprint?: string } = {}): boolean {
  if (!exact(job, ["id", "requestId", "target", "policyVersion", "candidateFingerprint", "state", "startedAt", "completedAt", "reclaimedBytes", "errorCode"]) || typeof job.id !== "string" || typeof job.requestId !== "string" || typeof job.candidateFingerprint !== "string" || !/^[1-9][0-9]{0,19}$/.test(job.id) || !UUID.test(job.requestId) || job.target !== "OBS_TEST" || job.policyVersion !== "ONQ_DISK_SAFE_V1" || !HASH.test(job.candidateFingerprint) || (expected.requestId && job.requestId !== expected.requestId) || (expected.candidateFingerprint && job.candidateFingerprint !== expected.candidateFingerprint)) return false;
  if (job.startedAt !== null && !iso(job.startedAt) || job.completedAt !== null && !iso(job.completedAt)) return false;
  if (job.errorCode !== null && !/^[A-Z0-9_]{1,80}$/.test(job.errorCode)) return false;
  if (job.reclaimedBytes !== null && (!Number.isSafeInteger(job.reclaimedBytes) || job.reclaimedBytes < 0)) return false;
  if (job.state === "QUEUED") return job.startedAt === null && job.completedAt === null && job.reclaimedBytes === null && job.errorCode === null;
  if (job.state === "RUNNING") return job.startedAt !== null && job.completedAt === null && job.reclaimedBytes === null && job.errorCode === null;
  if (job.state !== "SUCCEEDED" && job.state !== "FAILED" || job.startedAt === null || job.completedAt === null || Date.parse(job.completedAt) < Date.parse(job.startedAt)) return false;
  return job.state === "SUCCEEDED" ? job.reclaimedBytes !== null && job.errorCode === null : job.errorCode !== null;
}
