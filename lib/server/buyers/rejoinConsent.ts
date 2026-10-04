import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";

// 구매자 「재가입 제한 정보 보관 동의」(선택 동의) 조회·철회(대기열 6번, PRODUCT_SCOPE 「구매자 탈퇴·재가입」, 개인정보 보호법 제37조).
// 철회하면 동의 기간·시각·문서 버전을 비우고 철회 시각을 남긴다. 탈퇴 때는 지금 동의 상태로 재가입 제한·CI 해시 보관을 정한다
// (buyers/withdraw.ts가 회원 행을 잠근 뒤 다시 읽음). 다시 동의하는 기능은 없다(정본에 없음).
// 이미 철회됐거나 동의한 적이 없으면 아무것도 바꾸지 않고 지금 상태를 돌려준다(다시 보낸 요청에 안전).

export type RejoinRetentionState = { agreed: boolean; agreedAt: string | null; version: string | null; restrictionDays: number | null; withdrawnAt: string | null };

export const REJOIN_RETENTION_MESSAGES = { invalid_rejoin_retention_consent: "재가입 제한 정보 보관 동의는 철회만 할 수 있어요" } as const;
export const REJOIN_RETENTION_STATUS = { invalid_rejoin_retention_consent: 400 } as const;

type Scope = { sellerId: string; buyerMemberId: string };
type Meta = { ip?: string | null; userAgent?: string | null };

const SELECT = { rejoinRestrictionDaysAgreed: true, rejoinRetentionAgreedAt: true, rejoinRetentionVersion: true, rejoinRetentionWithdrawnAt: true } as const;
type Row = { rejoinRestrictionDaysAgreed: number | null; rejoinRetentionAgreedAt: Date | null; rejoinRetentionVersion: string | null; rejoinRetentionWithdrawnAt: Date | null };

// 탈퇴 때 보는 값(rejoinRestrictionDaysAgreed)이 있으면 동의 중이다
const stateOf = (m: Row): RejoinRetentionState => ({
  agreed: m.rejoinRestrictionDaysAgreed !== null,
  agreedAt: m.rejoinRetentionAgreedAt?.toISOString() ?? null,
  version: m.rejoinRetentionVersion,
  restrictionDays: m.rejoinRestrictionDaysAgreed,
  withdrawnAt: m.rejoinRetentionWithdrawnAt?.toISOString() ?? null,
});

export async function readRejoinRetentionConsent(db: PrismaClient, scope: Scope): Promise<RejoinRetentionState | null> {
  const m = await db.buyerMember.findFirst({ where: { id: scope.buyerMemberId, sellerId: scope.sellerId, deletedAt: null }, select: SELECT });
  return m ? stateOf(m) : null;
}

// 본문: { agreed: false }. 감사 기록을 남긴다.
export async function withdrawRejoinRetentionConsent(db: PrismaClient, scope: Scope, raw: unknown, meta: Meta = {}) {
  const b = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (b.agreed !== false) return { ok: false as const, reason: "invalid_rejoin_retention_consent" as const };
  return db.$transaction(async (tx) => {
    // 탈퇴(withdraw.ts)와 같은 회원 행 잠금. 탈퇴가 먼저면 철회는 not_found, 철회가 먼저면 탈퇴는 철회된 상태를 본다.
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "BuyerMember" WHERE "id" = ${scope.buyerMemberId}::uuid AND "sellerId" = ${scope.sellerId}::uuid AND "deletedAt" IS NULL FOR NO KEY UPDATE`;
    if (!row) return { ok: false as const, reason: "not_found" as const };
    const cur = await tx.buyerMember.findUniqueOrThrow({ where: { id: row.id }, select: SELECT });
    if (cur.rejoinRestrictionDaysAgreed === null && cur.rejoinRetentionAgreedAt === null) return { ok: true as const, state: stateOf(cur), changed: false };
    const next = await tx.buyerMember.update({
      where: { id: row.id },
      data: { rejoinRestrictionDaysAgreed: null, rejoinRetentionAgreedAt: null, rejoinRetentionVersion: null, rejoinRetentionWithdrawnAt: new Date() },
      select: SELECT,
    });
    await writeAudit(tx, {
      actorType: "BUYER",
      actorId: row.id,
      sellerId: scope.sellerId,
      action: "buyer.rejoin_retention_consent.withdraw",
      targetType: "BuyerMember",
      targetId: row.id,
      before: { agreed: cur.rejoinRestrictionDaysAgreed !== null, version: cur.rejoinRetentionVersion, restrictionDays: cur.rejoinRestrictionDaysAgreed },
      after: { agreed: false },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, state: stateOf(next), changed: true };
  });
}
