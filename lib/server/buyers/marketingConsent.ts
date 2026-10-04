import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { SIGNUP_CONSENT_VERSIONS } from "./consent";

// 구매자 마케팅 정보 수신 동의 조회·철회·다시 동의(대기열 6번, 정보통신망법 제50조 제2항: 수신자는 언제든 철회할 수 있다).
// 철회하면 동의 시각·문서 버전을 비우고 철회 시각을 남긴다. 다시 동의하면 화면이 보여 준 문서 버전이 지금 버전과 같을 때만 받는다.
// 광고성 알림(방송 시작 알림 등)은 동의 중(marketingConsentAt 있음)인 회원에게만 보낸다(PRODUCT_SCOPE 「방송 시작 알림」).
// 이미 같은 상태(철회됨, 또는 지금 버전으로 동의 중)면 아무것도 바꾸지 않고 지금 상태를 돌려준다(다시 보낸 요청에 안전).
// 동의 중이지만 버전이 없거나 옛 버전이면 다시 동의할 때 지금 버전·시각으로 새로 기록한다.

export type MarketingConsentState = { agreed: boolean; agreedAt: string | null; version: string | null; withdrawnAt: string | null; currentVersion: string };

export const MARKETING_CONSENT_MESSAGES = {
  invalid_marketing_consent: "마케팅 정보 수신 동의를 다시 선택해 주세요",
  consent_outdated: "약관이 바뀌었어요. 다시 확인하고 동의해 주세요",
} as const;
export const MARKETING_CONSENT_STATUS = { invalid_marketing_consent: 400, consent_outdated: 409 } as const;

type Scope = { sellerId: string; buyerMemberId: string };
type Meta = { ip?: string | null; userAgent?: string | null };

const stateOf = (m: { marketingConsentAt: Date | null; marketingConsentVersion: string | null; marketingWithdrawnAt: Date | null }): MarketingConsentState => ({
  agreed: m.marketingConsentAt !== null,
  agreedAt: m.marketingConsentAt?.toISOString() ?? null,
  version: m.marketingConsentAt ? m.marketingConsentVersion : null,
  withdrawnAt: m.marketingWithdrawnAt?.toISOString() ?? null,
  currentVersion: SIGNUP_CONSENT_VERSIONS.marketing,
});

const SELECT = { marketingConsentAt: true, marketingConsentVersion: true, marketingWithdrawnAt: true } as const;

export async function readMarketingConsent(db: PrismaClient, scope: Scope): Promise<MarketingConsentState | null> {
  const m = await db.buyerMember.findFirst({ where: { id: scope.buyerMemberId, sellerId: scope.sellerId, deletedAt: null }, select: SELECT });
  return m ? stateOf(m) : null;
}

// 본문: { agreed: boolean, marketingVersion?: string }(다시 동의할 때만 화면이 보여 준 문서 버전). 감사 기록을 남긴다.
export async function setMarketingConsent(db: PrismaClient, scope: Scope, raw: unknown, meta: Meta = {}) {
  const b = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (typeof b.agreed !== "boolean") return { ok: false as const, reason: "invalid_marketing_consent" as const };
  if (b.agreed && b.marketingVersion !== SIGNUP_CONSENT_VERSIONS.marketing) return { ok: false as const, reason: "consent_outdated" as const };
  const agreed = b.agreed;
  return db.$transaction(async (tx) => {
    // 같은 회원의 동시 변경을 한 줄로 세운다(늦은 쪽이 앞 결과를 보고 판단)
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "BuyerMember" WHERE "id" = ${scope.buyerMemberId}::uuid AND "sellerId" = ${scope.sellerId}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
    if (!row) return { ok: false as const, reason: "not_found" as const };
    const cur = await tx.buyerMember.findUniqueOrThrow({ where: { id: row.id }, select: SELECT });
    // 바꿀 것이 없는 경우: 철회 요청인데 이미 철회됨, 또는 동의 요청인데 이미 지금 버전으로 동의함.
    // 동의 중이어도 버전이 없거나(이 기능 전 회원) 옛 버전이면 지금 버전으로 다시 기록한다(Codex P1).
    const current = agreed ? cur.marketingConsentAt !== null && cur.marketingConsentVersion === SIGNUP_CONSENT_VERSIONS.marketing : cur.marketingConsentAt === null;
    if (current) return { ok: true as const, state: stateOf(cur), changed: false };
    const now = new Date();
    const next = await tx.buyerMember.update({
      where: { id: row.id },
      data: agreed
        ? { marketingConsentAt: now, marketingConsentVersion: SIGNUP_CONSENT_VERSIONS.marketing, marketingWithdrawnAt: null }
        : { marketingConsentAt: null, marketingConsentVersion: null, marketingWithdrawnAt: now },
      select: SELECT,
    });
    await writeAudit(tx, {
      actorType: "BUYER",
      actorId: row.id,
      sellerId: scope.sellerId,
      action: agreed ? "buyer.marketing_consent.agree" : "buyer.marketing_consent.withdraw",
      targetType: "BuyerMember",
      targetId: row.id,
      before: { agreed: cur.marketingConsentAt !== null, version: cur.marketingConsentVersion },
      after: { agreed, version: next.marketingConsentVersion },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, state: stateOf(next), changed: true };
  });
}
