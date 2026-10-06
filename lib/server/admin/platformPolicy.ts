import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { adminCan } from "../authz/permissions";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";

// 플랫폼 기본 정책(MA-081). 정의는 이 표가 정본이다: 기본값은 지금 코드가 쓰던 값, 범위는 서버가 검증한다.
// 값은 정수로 저장하고(불리언 0/1) 행이 없으면 기본값이다. applied=true인 키만 실제 기능이 이 값을 읽는다(나머지는 저장만 하고 화면이 「적용 예정」으로 보인다).
// 읽는 쪽: policyValue(). 바꾸는 쪽: updatePlatformPolicy(최고관리자만, 바뀐 키만 로그 추적에 before/after).
type Def = { key: string; group: "signup" | "billing" | "broadcast" | "rewards" | "session" | "legal"; kind: "int" | "bool" | "enum"; default: number; min?: number; max?: number; options?: number[]; unit: string; applied: boolean };

const D = (def: Def) => def;
export const POLICY_DEFS = [
  D({ key: "reviewTargetHours", group: "signup", kind: "enum", default: 48, options: [24, 48, 72], unit: "hours", applied: true }),
  D({ key: "supplementAutoRejectDays", group: "signup", kind: "enum", default: 7, options: [3, 7, 0], unit: "days", applied: true }), // 0 = 안 함
  D({ key: "bizStatusAutoCheck", group: "signup", kind: "bool", default: 1, unit: "", applied: false }),
  D({ key: "duplicateSignupBlock", group: "signup", kind: "bool", default: 1, unit: "", applied: false }),
  D({ key: "paymentRetryCount", group: "billing", kind: "int", default: 3, min: 1, max: 10, unit: "times", applied: true }),
  D({ key: "overdueLockDays", group: "billing", kind: "int", default: 7, min: 1, max: 60, unit: "days", applied: true }),
  D({ key: "lockToCloseDays", group: "billing", kind: "int", default: 30, min: 1, max: 365, unit: "days", applied: true }),
  D({ key: "dataRetentionDays", group: "billing", kind: "enum", default: 90, options: [90, 180], unit: "days", applied: false }),
  D({ key: "priceNoticeDays", group: "billing", kind: "int", default: 30, min: 30, max: 365, unit: "days", applied: false }), // 30일 미만으로 줄일 수 없음
  D({ key: "openTimerSeconds", group: "broadcast", kind: "int", default: 60, min: 5, max: 3600, unit: "seconds", applied: false }),
  D({ key: "overlayReconnectMax", group: "broadcast", kind: "int", default: 10, min: 1, max: 100, unit: "times", applied: false }),
  D({ key: "hitSeconds", group: "broadcast", kind: "int", default: 6, min: 1, max: 60, unit: "seconds", applied: false }),
  D({ key: "carryOverAlways", group: "broadcast", kind: "bool", default: 0, unit: "", applied: false }), // 0 파트너스 선택(기본 이월) · 1 항상 이월
  D({ key: "maxEarnRatePercent", group: "rewards", kind: "int", default: 10, min: 1, max: 100, unit: "percent", applied: false }),
  D({ key: "maxUseRatioPercent", group: "rewards", kind: "int", default: 50, min: 1, max: 100, unit: "percent", applied: false }),
  D({ key: "rewardBalanceWarnPercent", group: "rewards", kind: "int", default: 25, min: 1, max: 100, unit: "percent", applied: false }),
  D({ key: "manualGrantMax", group: "rewards", kind: "int", default: 1_000_000, min: 1_000, max: 100_000_000, unit: "won", applied: false }),
  D({ key: "adminSessionHours", group: "session", kind: "int", default: 8, min: 1, max: 24, unit: "hours", applied: false }),
  D({ key: "adminIdleMinutes", group: "session", kind: "int", default: 30, min: 5, max: 240, unit: "minutes", applied: false }),
  D({ key: "impersonationMinutes", group: "session", kind: "int", default: 30, min: 5, max: 60, unit: "minutes", applied: true }),
  D({ key: "reconsentOnNewLegalVersion", group: "legal", kind: "bool", default: 1, unit: "", applied: false }),
] as const satisfies readonly Def[];

export type PolicyKey = (typeof POLICY_DEFS)[number]["key"];
const DEF = new Map<string, Def>(POLICY_DEFS.map((d) => [d.key, d]));

export const PLATFORM_POLICY_MESSAGES = {
  invalid_policy: "정책 값이 범위를 벗어났습니다. 입력한 값을 확인해 주십시오",
  price_notice_min: "요금 변경 사전 고지는 30일 미만으로 줄일 수 없습니다",
} as const;

type AuditMeta = { ip?: string | null; userAgent?: string | null };
type Db = PrismaClient | Prisma.TransactionClient;
type Row = { key: string; intValue: number; updatedAt: Date };

async function rows(db: Db): Promise<Map<string, Row>> {
  return new Map((await db.platformPolicy.findMany()).map((r) => [r.key, r]));
}

// 기능 코드가 쓰는 값 하나(행이 없으면 기본값). 정수로 돌려준다(불리언은 0/1).
export async function policyValue(db: Db, key: PolicyKey): Promise<number> {
  const row = await db.platformPolicy.findUnique({ where: { key } });
  return row?.intValue ?? DEF.get(key)!.default;
}

const present = (d: Def, v: number) => (d.kind === "bool" ? v === 1 : v);

// 조회: 키마다 현재 값·기본값·범위·적용 여부.
export async function readPlatformPolicy(db: Db) {
  const stored = await rows(db);
  return POLICY_DEFS.map((d) => {
    const r = stored.get(d.key);
    return {
      key: d.key,
      group: d.group,
      kind: d.kind,
      unit: d.unit,
      value: present(d, r?.intValue ?? d.default),
      default: present(d, d.default),
      ...("min" in d ? { min: d.min, max: d.max } : {}),
      ...("options" in d ? { options: d.options } : {}),
      applied: d.applied,
      updatedAt: r?.updatedAt ?? null,
    };
  });
}

function parse(d: Def, v: unknown): number | null {
  if (d.kind === "bool") return typeof v === "boolean" ? (v ? 1 : 0) : null;
  if (typeof v !== "number" || !Number.isInteger(v)) return null;
  if (d.kind === "enum") return d.options!.includes(v) ? v : null;
  return v >= d.min! && v <= d.max! ? v : null;
}

// 본문: { values: { [key]: number | boolean } }. 모르는 키·범위 밖 값·빈 본문은 400. 최고관리자만. 바뀐 키가 없으면 로그 없이 현재 값을 돌려준다.
export async function updatePlatformPolicy(db: PrismaClient, admin: AdminSessionContext, raw: unknown, meta: AuditMeta = {}) {
  if (!adminCan(admin.admin.role, "system.manage")) throw forbidden();
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const values = b.values && typeof b.values === "object" && !Array.isArray(b.values) ? (b.values as Record<string, unknown>) : null;
  if (!values || Object.keys(values).length === 0) return { ok: false as const, reason: "invalid_policy" as const };
  const next = new Map<string, number>();
  for (const [key, v] of Object.entries(values)) {
    const d = DEF.get(key);
    if (!d) return { ok: false as const, reason: "invalid_policy" as const, field: key };
    const n = parse(d, v);
    if (n === null) {
      return { ok: false as const, reason: key === "priceNoticeDays" && typeof v === "number" && v < 30 ? ("price_notice_min" as const) : ("invalid_policy" as const), field: key };
    }
    next.set(key, n);
  }
  const changed = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('platform_policy'))`;
    const cur = await rows(tx);
    const before: Record<string, number | boolean> = {};
    const after: Record<string, number | boolean> = {};
    for (const [key, n] of next) {
      const d = DEF.get(key)!;
      const was = cur.get(key)?.intValue ?? d.default;
      if (was === n) continue;
      before[key] = present(d, was);
      after[key] = present(d, n);
      await tx.platformPolicy.upsert({ where: { key }, create: { key, intValue: n, updatedByAdminId: admin.admin.id }, update: { intValue: n, updatedByAdminId: admin.admin.id } });
    }
    if (Object.keys(after).length > 0) {
      await writeAudit(tx, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, action: "platform.policy.update", targetType: "PlatformPolicy", targetId: "policy", before, after, ip: meta.ip, userAgent: meta.userAgent });
    }
    return Object.keys(after);
  });
  return { ok: true as const, changed, policy: await readPlatformPolicy(db) };
}
