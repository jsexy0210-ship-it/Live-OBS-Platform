import type { IdentityVerification, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { writeAudit } from "../audit/log";
import { dbNow } from "../billing/subscription";
import { forbidden } from "../authz/errors";
import { keyedOwnerToken, parseAttemptKey, reuseKeyedAttempt, scopedAttemptKeyHash } from "../identity/attempt";
import type { IdentityProvider } from "../identity/provider";
import { completeIdentityVerification, parseIdentityPerson, sendFirstIdentityCode, startIdentityVerification } from "../identity/verification";
import type { TenantContext } from "../tenant/context";
import { cleanText } from "../text/clean";

// 직원 본인확인 연결(2026-10-03 대표님 결정, PRODUCT_SCOPE 로그인): 직원이 로그인한 뒤 본인 휴대폰 본인확인을 한 번 해 그 CI 해시를
// 계정에 연결한다. 대표자가 등록한 이름·휴대폰 번호와 본인확인 결과가 맞을 때만 연결한다. 연결은 직원 셀프 아이디·비밀번호 찾기에만 쓰고,
// 연결 전이나 번호 변경으로 풀린 동안에도 로그인·권한은 그대로다(MASTER 2026-10-04). 대표자는 쇼핑몰 대표자 CI를 쓰므로 대상이 아니다.
// 시작은 직원 계정당 하루 10회(KST, 건당 비용). 등록한 이름·번호와 입력이 다르면 문자를 보내기 전에 거부한다.

type Meta = { ip?: string | null; userAgent?: string | null; now?: Date };
const OWNER_SCOPE = "staff_link_owner";
export const STAFF_LINK_DAILY_LIMIT = 10;

export type StaffLinkStartResult =
  | { ok: true; verificationId: string; ownerToken: string }
  | {
      ok: false;
      reason:
        | "phone_not_registered"
        | "identity_mismatch"
        | "link_limit_exceeded"
        | "invalid_identity_input"
        | "provider_error"
        | "already_verified"
        | "expired"
        | "failed"
        | "start_in_progress";
    };

async function loadSelf(db: PrismaClient, ctx: TenantContext) {
  // 마스터 대리 조회·대표자는 연결 대상이 아니다
  if (ctx.readOnly || ctx.isOwner || ctx.actorType !== "SELLER_USER") throw forbidden();
  const user = await db.sellerUser.findFirst({ where: { id: ctx.actorId, sellerId: ctx.sellerId, isOwner: false, status: "ACTIVE" } });
  if (!user) throw forbidden();
  return user;
}

const sameName = (a: string | null, b: string) => !!a && cleanText(a, 30) === cleanText(b, 30);

// 연결 상태(화면의 첫 로그인 안내·건너뛰기용)
export async function staffLinkStatus(db: PrismaClient, ctx: TenantContext) {
  const user = await loadSelf(db, ctx);
  return { phoneRegistered: user.phone !== null, linked: user.identityCiHash !== null };
}

// attemptKey(선택, 클라이언트 UUID): 응답이 끊겨 같은 직원·같은 키로 다시 보내면 같은 기록·같은 ownerToken을 돌려주고
// 문자·하루 횟수를 다시 쓰지 않는다(다른 시작 흐름과 같은 방식, identity/attempt.ts). 보내는 중이면 start_in_progress.
export async function startStaffLink(
  db: PrismaClient,
  provider: IdentityProvider,
  ctx: TenantContext,
  rawPerson: unknown,
  meta: Meta & { attemptKey?: unknown } = {},
): Promise<StaffLinkStartResult> {
  const user = await loadSelf(db, ctx);
  const attemptKey = parseAttemptKey(meta.attemptKey);
  if (attemptKey === false) return { ok: false, reason: "invalid_identity_input" };
  const person = parseIdentityPerson(rawPerson);
  if (!person) return { ok: false, reason: "invalid_identity_input" };
  if (!user.phone) return { ok: false, reason: "phone_not_registered" };
  if (person.phone !== user.phone || !sameName(person.name, user.name)) return { ok: false, reason: "identity_mismatch" };
  // 키는 직원별로 나눈다(같은 키를 다른 직원이 써도 다른 기록)
  const keyHash = attemptKey ? scopedAttemptKeyHash("STAFF_LINK", user.id, attemptKey) : null;
  type Started =
    | null
    | { kind: "reused"; verificationId: string; ownerToken: string }
    | { kind: "refused"; reason: "already_verified" | "expired" | "failed" | "start_in_progress" }
    | { kind: "send"; verification: IdentityVerification; ownerToken: string };
  const started = await db.$transaction(async (tx): Promise<Started> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`staff_link:${user.id}`}))`;
    if (keyHash) {
      const same = await tx.identityVerification.findFirst({ where: { purpose: "STAFF_LINK", sellerId: user.sellerId, subjectId: user.id, attemptKeyHash: keyHash } });
      const r = await reuseKeyedAttempt(tx, same, meta.now ?? (await dbNow(tx)));
      if (r?.kind === "reused") return { ...r, ownerToken: keyedOwnerToken(OWNER_SCOPE, attemptKey!, r.verificationId) };
      if (r) return r;
    }
    const [{ count }] = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM "IdentityVerification"
      WHERE "purpose" = 'STAFF_LINK' AND "subjectId" = ${user.id}::uuid
        AND "createdAt" >= (date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul')`;
    if (Number(count) >= STAFF_LINK_DAILY_LIMIT) return null;
    const id = randomUUID();
    const created = await startIdentityVerification(tx, provider, {
      purpose: "STAFF_LINK",
      sellerId: user.sellerId,
      subjectId: user.id,
      person,
      requestIp: meta.ip ?? null,
      attemptKeyHash: keyHash,
      sendStartedAt: keyHash ? (meta.now ?? (await dbNow(tx))) : null,
      id,
      ownerToken: attemptKey ? keyedOwnerToken(OWNER_SCOPE, attemptKey, id) : undefined,
      now: meta.now,
    });
    return { kind: "send", ...created };
  });
  if (!started) return { ok: false, reason: "link_limit_exceeded" };
  if (started.kind === "reused") return { ok: true, verificationId: started.verificationId, ownerToken: started.ownerToken };
  if (started.kind === "refused") return { ok: false, reason: started.reason };
  const sent = await sendFirstIdentityCode(db, provider, started.verification, person, meta.now);
  if (!sent.ok) return { ok: false, reason: sent.reason };
  return { ok: true, verificationId: started.verification.id, ownerToken: started.ownerToken };
}

// 인증번호 확인(공통 confirm) 뒤 연결. 결과 이름·휴대폰이 등록 정보와 같아야 하고, 이 직원이 시작한 본인확인(subjectId)만 쓴다.
// 결과와 상관없이 본인확인은 소진한다. 맞지 않으면 identity_mismatch(연결하지 않음).
export async function linkStaffIdentity(
  db: PrismaClient,
  provider: IdentityProvider,
  ctx: TenantContext,
  input: { verificationId: string; ownerToken: string | undefined },
  meta: Meta = {},
): Promise<{ ok: true } | { ok: false; reason: "pending" | "verification_invalid" | "identity_mismatch" }> {
  const user = await loadSelf(db, ctx);
  const now = meta.now ?? new Date();
  const done = await completeIdentityVerification(db, provider, input.verificationId, { sellerId: user.sellerId, purpose: "STAFF_LINK", ownerToken: input.ownerToken }, now);
  if (!done.ok) return { ok: false, reason: done.reason === "pending" ? "pending" : "verification_invalid" };
  const v = done.verification;
  if (v.subjectId !== user.id || v.consumedAt || !v.ciHash) return { ok: false, reason: "verification_invalid" };
  const matches = !!user.phone && v.phone === user.phone && sameName(v.name, user.name);
  return db.$transaction(async (tx) => {
    const used = await tx.identityVerification.updateMany({ where: { id: v.id, consumedAt: null }, data: { consumedAt: now } });
    if (used.count !== 1) return { ok: false as const, reason: "verification_invalid" as const };
    // 그사이 대표자가 번호를 바꿨으면 연결하지 않는다(같은 번호일 때만 갱신)
    const linked = matches
      ? await tx.sellerUser.updateMany({ where: { id: user.id, phone: user.phone, status: "ACTIVE" }, data: { identityCiHash: v.ciHash, identityLinkedAt: now } })
      : { count: 0 };
    await writeAudit(tx, {
      actorType: "SELLER_USER",
      actorId: user.id,
      sellerId: user.sellerId,
      action: linked.count === 1 ? "seller.staff.identity_linked" : "seller.staff.identity_link_failed",
      targetType: "SellerUser",
      targetId: user.id,
      reason: linked.count === 1 ? undefined : "identity_mismatch",
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return linked.count === 1 ? { ok: true as const } : { ok: false as const, reason: "identity_mismatch" as const };
  });
}
