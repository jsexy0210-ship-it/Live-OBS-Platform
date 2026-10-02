import type { ActorType, Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

const SECRET_KEYS = new Set(["passwordHash", "password", "tokenHash", "token", "totpSecretEnc", "totpSecret", "codeHash"]);

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

export async function writeAudit(db: Db, e: AuditEntry): Promise<void> {
  await db.auditLog.create({
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
  });
}
