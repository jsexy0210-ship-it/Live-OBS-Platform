import type { ActorType, Prisma, PrismaClient } from "@prisma/client";
import { memberAuditRetainMonths } from "../buyers/memberData";

type Db = PrismaClient | Prisma.TransactionClient;

const SECRET_KEYS = new Set(["passwordHash", "password", "tokenHash", "token", "ciHash", "codeHash"]);

// 비밀값 필드는 기록 전에 제거한다.
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !SECRET_KEYS.has(k))
        .map(([k, v]) => [k, redact(v)]),
    );
  }
  return value;
}

export type AuditEntry = {
  actorType: ActorType;
  actorId?: string | null;
  sellerId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  ip?: string | null;
  userAgent?: string | null;
};

// 구매자 회원이 행위자·대상인 행은 기록 시각 기준 보관 기한(retainUntil)을 함께 단다(거래 관련 5년, 거래 무관 3개월,
// buyers/memberData.ts MEMBER_AUDIT_RETENTION). 기한이 지나면 회원 id를 비식별한다(⑩). 탈퇴와 상관없이 모든 회원에 적용한다.
export async function writeAudit(db: Db, e: AuditEntry): Promise<void> {
  const memberRow = (e.actorType === "BUYER" && !!e.actorId) || (e.targetType === "BuyerMember" && !!e.targetId);
  const row = await db.auditLog.create({
    data: {
      actorType: e.actorType,
      actorId: e.actorId ?? null,
      sellerId: e.sellerId ?? null,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      before: e.before === undefined ? undefined : (redact(e.before) as Prisma.InputJsonValue),
      after: e.after === undefined ? undefined : (redact(e.after) as Prisma.InputJsonValue),
      reason: e.reason,
      ip: e.ip ?? null,
      userAgent: e.userAgent ?? null,
    },
    select: { id: true },
  });
  if (memberRow) {
    await db.$executeRaw`UPDATE "AuditLog" SET "retainUntil" = "createdAt" + make_interval(months => ${memberAuditRetainMonths(e.action)}::int) WHERE "id" = ${row.id}::uuid`;
  }
}
