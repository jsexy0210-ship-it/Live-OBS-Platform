import { Prisma, type PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { writeAudit } from "../audit/log";
import { dbNow } from "../billing/subscription";
import { releaseBuyerIdentityFee, reserveBuyerIdentityFee } from "../identity/fee";
import { type IdentityProvider } from "../identity/provider";
import { completeIdentityVerification, parseIdentityPerson, sendFirstIdentityCode, startIdentityVerification } from "../identity/verification";

// 구매자 휴대폰 번호 변경 재인증(SH-024, 대표님 확정 2026-10-26, docs/COST_POLICY.md).
// 로그인한 회원이 새 번호로 휴대폰 본인확인(BUYER_PHONE_CHANGE)을 마치면 번호와 생년월일을 바꾼다.
// - 새 번호 본인확인 결과의 CI 해시가 회원의 ciHash와 같을 때만 바꾼다(다른 사람 명의 번호로는 못 바꾼다).
// - 비용은 가입 본인확인과 같다: 체험 중 무료, 아니면 파트너스 발송·이용 충전금에서 시작 때 잡고(성공하면 확정), 잔액이 없으면 번호 변경만 멈춘다.
// - 회원당 하루(KST) 3번까지 시작할 수 있다(실패 포함). 쇼핑몰 전체 한도는 없다.
// - 기존 회원 계정 관리라 쇼핑몰이 일시 정지·구독 만료·준비 중이어도 할 수 있다(닉네임·비밀번호 변경과 같은 기준, ARCHITECTURE 4.8.0). 비용만 충전금 규칙을 따른다.
// - 바꿔도 다른 기기 로그인 세션은 그대로 둔다. 본인확인 기록의 식별 항목은 바꾼 직후 비운다(행과 subjectId는 하루 횟수 계산에 남긴다).
export const PHONE_CHANGE_DAILY_LIMIT = 3;
export const BUYER_PHONE_CHANGE_IDV_COOKIE = "lo_bpc";
// 확인 쿠키 범위: 시작·다시 보내기·확인·바꾸기 라우트가 모두 이 아래에 있다
export const buyerPhoneChangePath = (slug: string) => `/api/shop/${slug}/me/phone`;

export const PHONE_CHANGE_MESSAGES = {
  same_phone: "지금 쓰는 번호와 다른 번호를 입력해 주세요",
  phone_taken: "이미 다른 회원이 쓰는 번호예요",
  daily_limit_exceeded: "오늘은 번호 변경 인증을 더 할 수 없어요. 내일 다시 해 주세요",
  phone_change_unavailable: "지금은 번호를 바꿀 수 없어요. 쇼핑몰에 문의해 주세요",
  identity_mismatch: "가입할 때 본인확인한 분 명의의 번호로만 바꿀 수 있어요",
  verification_pending: "인증번호 확인을 마친 뒤에 바꿀 수 있어요",
  verification_invalid: "본인확인을 처음부터 다시 해 주세요",
  not_found: "회원 정보를 찾을 수 없어요",
} as const;
export type PhoneChangeFailure = keyof typeof PHONE_CHANGE_MESSAGES;
export const PHONE_CHANGE_STATUS: Record<PhoneChangeFailure, number> = {
  same_phone: 409,
  phone_taken: 409,
  daily_limit_exceeded: 429,
  phone_change_unavailable: 503,
  identity_mismatch: 403,
  verification_pending: 409,
  verification_invalid: 400,
  not_found: 404,
};

type Scope = { sellerId: string; buyerMemberId: string };
type Meta = { ip?: string | null; userAgent?: string | null; now?: Date };

// 본인확인 시작: 요청 기록을 만들고 새 번호로 첫 인증번호를 보낸다. 본문은 가입 본인확인과 같은 인적사항 { name, phone, birth7, carrier, device? }.
export async function startBuyerPhoneChange(db: PrismaClient, provider: IdentityProvider, scope: Scope, rawPerson: unknown, meta: Meta = {}) {
  const person = parseIdentityPerson(rawPerson);
  if (!person) return { ok: false as const, reason: "invalid_identity_input" as const };
  type Started = { kind: "failed"; reason: PhoneChangeFailure } | { kind: "send"; verificationId: string; ownerToken: string; now: Date };
  const started = await db.$transaction(async (tx): Promise<Started> => {
    const now = meta.now ?? (await dbNow(tx));
    const member = await tx.buyerMember.findFirst({ where: { id: scope.buyerMemberId, sellerId: scope.sellerId, status: "ACTIVE", deletedAt: null }, select: { phone: true } });
    if (!member) return { kind: "failed", reason: "not_found" };
    if (member.phone === person.phone) return { kind: "failed", reason: "same_phone" };
    // 같은 회원의 동시 시작이 하루 한도를 넘지 않도록 회원 단위로 잠근다
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`buyer_phone_change:${scope.sellerId}:${scope.buyerMemberId}`}))`;
    const [{ count }] = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM "IdentityVerification"
      WHERE "purpose" = 'BUYER_PHONE_CHANGE' AND "sellerId" = ${scope.sellerId}::uuid AND "subjectId" = ${scope.buyerMemberId}::uuid
        AND "createdAt" >= (date_trunc('day', ${now}::timestamptz AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul')`;
    if (Number(count) >= PHONE_CHANGE_DAILY_LIMIT) return { kind: "failed", reason: "daily_limit_exceeded" };
    const id = randomUUID();
    if (!(await reserveBuyerIdentityFee(tx, scope.sellerId, id, now)).ok) return { kind: "failed", reason: "phone_change_unavailable" };
    const created = await startIdentityVerification(tx, provider, { purpose: "BUYER_PHONE_CHANGE", sellerId: scope.sellerId, person, subjectId: scope.buyerMemberId, sendStartedAt: now, id, now: meta.now });
    return { kind: "send", verificationId: created.verification.id, ownerToken: created.ownerToken, now };
  });
  if (started.kind === "failed") return { ok: false as const, reason: started.reason };
  const v = await db.identityVerification.findUniqueOrThrow({ where: { id: started.verificationId } });
  const sent = await sendFirstIdentityCode(db, provider, v, person, meta.now);
  if (!sent.ok) {
    await releaseBuyerIdentityFee(db, scope.sellerId, v.id);
    return { ok: false as const, reason: sent.reason };
  }
  return { ok: true as const, verificationId: v.id, ownerToken: started.ownerToken };
}

// 인증번호 확인을 마친 본인확인으로 번호를 바꾼다. 본인확인은 한 번만 쓴다.
export async function applyBuyerPhoneChange(db: PrismaClient, provider: IdentityProvider, scope: Scope, input: { verificationId: unknown; ownerToken: string | undefined }, meta: Meta = {}) {
  const id = typeof input.verificationId === "string" ? input.verificationId : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return { ok: false as const, reason: "verification_invalid" as const };
  const done = await completeIdentityVerification(db, provider, id, { sellerId: scope.sellerId, purpose: "BUYER_PHONE_CHANGE", ownerToken: input.ownerToken }, meta.now);
  if (!done.ok) return { ok: false as const, reason: done.reason === "pending" ? ("verification_pending" as const) : ("verification_invalid" as const) };
  const v = done.verification;
  if (v.subjectId !== scope.buyerMemberId || v.consumedAt || v.anonymizedAt || !v.phone || !v.ciHash) return { ok: false as const, reason: "verification_invalid" as const };
  const newPhone = v.phone;
  try {
    return await db.$transaction(async (tx) => {
      const now = meta.now ?? (await dbNow(tx));
      const [member] = await tx.$queryRaw<{ id: string; ciHash: string; phone: string }[]>`
        SELECT "id", "ciHash", "phone" FROM "BuyerMember"
        WHERE "id" = ${scope.buyerMemberId}::uuid AND "sellerId" = ${scope.sellerId}::uuid AND "status" = 'ACTIVE' AND "deletedAt" IS NULL FOR UPDATE`;
      if (!member) return { ok: false as const, reason: "not_found" as const };
      if (member.ciHash !== v.ciHash) return { ok: false as const, reason: "identity_mismatch" as const };
      if (member.phone === newPhone) return { ok: false as const, reason: "same_phone" as const };
      const used = await tx.identityVerification.updateMany({ where: { id: v.id, consumedAt: null, anonymizedAt: null }, data: { consumedAt: now } });
      if (used.count !== 1) return { ok: false as const, reason: "verification_invalid" as const };
      // 새 번호를 쓰는 다른 회원이 있으면 (sellerId, phone) 유니크 인덱스에 걸려 P2002로 돌아간다
      await tx.buyerMember.update({ where: { id: member.id }, data: { phone: newPhone, birthDate: v.birthDate, identityVerifiedAt: now } });
      await tx.$executeRaw`
        UPDATE "IdentityVerification"
        SET "name" = NULL, "phone" = NULL, "requestedPhone" = NULL, "birthDate" = NULL, "ciHash" = NULL, "ownerTokenHash" = NULL,
            "requestId" = 'anonymized:' || gen_random_uuid()::text, "anonymizedAt" = ${now}
        WHERE "id" = ${v.id}::uuid`;
      await writeAudit(tx, {
        actorType: "BUYER",
        actorId: scope.buyerMemberId,
        sellerId: scope.sellerId,
        action: "buyer.profile.phone_change",
        targetType: "BuyerMember",
        targetId: scope.buyerMemberId,
        after: { reverified: true },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return { ok: true as const };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false as const, reason: "phone_taken" as const };
    throw e;
  }
}
