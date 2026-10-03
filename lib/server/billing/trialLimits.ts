import type { Prisma, PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { writeAudit } from "../audit/log";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { DEFAULT_PLAN_CODE, sellerAccessFor } from "./subscription";

// 체험하기 중 한도(대표님 결정 2026-10-02): 알림톡·문자 100건, 구매자 휴대폰 본인확인 50건, 저장 용량 1GB.
// 값은 SubscriptionPlan에 있고 마스터가 코드 수정 없이 바꾼다. 알림톡·업로드 기능을 붙일 때 이 확인 함수를 부른다.
// 휴대폰 본인확인(identity)은 성공 1건을 1로 세고(identity/verification.ts identityUsage), 주문 알림 문자(message)와 따로 센다.

export type TrialLimitKind = "message" | "identity" | "storageMb";

const COLUMN = { message: "trialMessageLimit", identity: "trialIdentityLimit", storageMb: "trialStorageMb" } as const;

export type TrialLimitResult = { ok: true } | { ok: false; reason: "trial_limit_exceeded"; limit: number };

// 체험하기 중인 판매자만 한도를 본다. used = 지금까지 쓴 양, adding = 이번에 더할 양.
export async function checkTrialLimit(
  db: PrismaClient | Prisma.TransactionClient,
  sellerId: string,
  kind: TrialLimitKind,
  usage: { used: number; adding: number },
  now?: Date,
): Promise<TrialLimitResult> {
  if ((await sellerAccessFor(db, sellerId, now)) !== "trial") return { ok: true };
  const plan = await db.subscriptionPlan.findUnique({ where: { code: DEFAULT_PLAN_CODE } });
  if (!plan) return { ok: true };
  const limit = plan[COLUMN[kind]];
  return usage.used + usage.adding <= limit ? { ok: true } : { ok: false, reason: "trial_limit_exceeded", limit };
}

const isLimit = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10_000_000;

// 체험하기 한도 변경(마스터, billing.manage). 감사 로그에 전·후 값을 남긴다.
export async function updateTrialLimits(
  db: PrismaClient,
  admin: AdminSessionContext,
  code: string,
  input: { message: unknown; identity: unknown; storageMb: unknown },
  meta: { ip?: string | null; userAgent?: string | null } = {},
) {
  if (!adminCan(admin.admin.role, "billing.manage")) throw forbidden();
  if (!isLimit(input.message) || !isLimit(input.identity) || !isLimit(input.storageMb)) {
    return { ok: false as const, reason: "invalid_limit" as const };
  }
  const before = await db.subscriptionPlan.findUnique({ where: { code } });
  if (!before) return { ok: false as const, reason: "not_found" as const };
  const plan = await db.subscriptionPlan.update({
    where: { code },
    data: { trialMessageLimit: input.message, trialIdentityLimit: input.identity, trialStorageMb: input.storageMb },
  });
  const view = (p: typeof plan) => ({ message: p.trialMessageLimit, identity: p.trialIdentityLimit, storageMb: p.trialStorageMb });
  await writeAudit(db, {
    actorType: "PLATFORM_ADMIN",
    actorId: admin.admin.id,
    action: "admin.plan.trial_limits_update",
    targetType: "SubscriptionPlan",
    targetId: plan.id,
    before: view(before),
    after: view(plan),
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { ok: true as const, limits: view(plan) };
}
