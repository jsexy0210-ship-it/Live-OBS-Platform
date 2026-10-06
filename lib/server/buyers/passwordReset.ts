import type { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { writeAudit } from "../audit/log";
import { dbNow } from "../billing/subscription";
import { normalizeEmail } from "../auth/login";
import { hashPassword } from "../auth/password";
import { isAcceptableBuyerPassword } from "./passwordPolicy";
import { generateToken, hashToken } from "../auth/token";
import { sendMail, type MailSender } from "../mail/quota";

// 구매자 「비밀번호를 잊었어요」(SH-012). 가입한 이메일(= 로그인 아이디)로 일회용 재설정 링크를 보낸다(2026-10-06 MASTER 결정).
// - 요청: 가입된 이메일인지와 상관없이 같은 응답. 링크는 30분, 한 번 쓰면 무효, 새로 요청하면 이전 링크는 무효.
//   한도: 같은 쇼핑몰·같은 이메일 1시간 3번, 같은 접속 IP 1시간 20번(없는 이메일도 똑같이 센다). 넘으면 메일 없이 too_many_requests.
// - 확인: 새 비밀번호 규칙은 가입과 같다(8~200자). 바꾸면 그 회원의 모든 로그인 세션을 무효화한다. 자동 로그인은 하지 않는다.
// - 메일은 거래 메일이라 쇼핑몰(파트너스)의 월 제공량으로 센다(mail/quota.ts, docs/COST_POLICY.md). 제공량·충전 잔액이 없어 못 보내도
//   응답은 같고, 로그 추적에만 남긴다. 메일 공급자가 없으면(운영 승인 전) mail_unavailable(계정과 무관한 서버 상태).

export const RESET_LINK_TTL_MS = 30 * 60_000;
export const RESET_REQUEST_WINDOW_MS = 60 * 60_000;
export const RESET_LIMIT_PER_ACCOUNT = 3;
export const RESET_LIMIT_PER_IP = 20;
export const MAX_PASSWORD_LENGTH = 200;

const REQUEST_ACTION = "auth.buyer.password_reset.request";
const hashKey = (sellerId: string, loginId: string) => createHash("sha256").update(`${sellerId}\0${loginId}`).digest("hex").slice(0, 32);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

type Meta = { ip?: string | null; userAgent?: string | null; now?: Date };

// 링크 경로(SH-012 화면 소유 세션이 이 경로로 새 비밀번호 화면을 만든다). 토큰은 쿼리 token.
export const buyerResetPath = (slug: string, token: string) => `/shop/${slug}/password-reset?token=${encodeURIComponent(token)}`;

export type RequestResult = { ok: true } | { ok: false; reason: "too_many_requests" | "mail_unavailable" };

export async function requestBuyerPasswordReset(
  db: PrismaClient,
  sender: MailSender | null,
  // origin: 링크의 서버 주소(라우트가 공개 주소 설정 또는 개발 요청 주소로 정한다)
  input: { sellerId: string; shopSlug: string; shopName: string; loginId: string; origin: string },
  meta: Meta = {},
): Promise<RequestResult> {
  if (!sender) return { ok: false, reason: "mail_unavailable" };
  const loginId = normalizeEmail(input.loginId);
  const key = hashKey(input.sellerId, loginId);
  const ip = meta.ip ?? null;
  const now = meta.now ?? (await dbNow(db));
  const since = new Date(now.getTime() - RESET_REQUEST_WINDOW_MS);

  // 한도 확인과 요청 기록을 같은 잠금 안에서 한다(동시에 보내도 한도를 넘지 않는다). 계정이 있든 없든 똑같이 기록한다.
  const allowed = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`bpr_key:${key}`}))`;
    if (ip) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`bpr_ip:${ip}`}))`;
    const byAccount = await tx.auditLog.count({ where: { action: REQUEST_ACTION, targetId: key, createdAt: { gte: since } } });
    const byIp = ip ? await tx.auditLog.count({ where: { action: REQUEST_ACTION, ip, createdAt: { gte: since } } }) : 0;
    const ok = byAccount < RESET_LIMIT_PER_ACCOUNT && byIp < RESET_LIMIT_PER_IP;
    await writeAudit(tx, {
      actorType: "BUYER",
      sellerId: input.sellerId,
      action: ok ? REQUEST_ACTION : "auth.buyer.password_reset.limited",
      targetType: "BuyerPasswordResetRequest",
      targetId: key,
      reason: ok ? undefined : byAccount >= RESET_LIMIT_PER_ACCOUNT ? "account_limit" : "ip_limit",
      ip,
      userAgent: meta.userAgent,
    });
    return ok;
  });
  if (!allowed) return { ok: false, reason: "too_many_requests" };

  const member = await db.buyerMember.findFirst({ where: { sellerId: input.sellerId, loginId, deletedAt: null, status: "ACTIVE" }, select: { id: true, name: true } });
  if (!member) return { ok: true };

  const token = generateToken();
  await db.$transaction([
    // 이전에 보낸 링크는 쓸 수 없게 한다(가장 최근 링크 하나만 유효)
    db.buyerPasswordReset.deleteMany({ where: { sellerId: input.sellerId, buyerMemberId: member.id, usedAt: null } }),
    db.buyerPasswordReset.create({ data: { sellerId: input.sellerId, buyerMemberId: member.id, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + RESET_LINK_TTL_MS), createdAt: now } }),
  ]);

  const link = `${input.origin}${buyerResetPath(input.shopSlug, token)}`;
  const shop = esc(input.shopName);
  const sent = await sendMail(db, sender, {
    sellerId: input.sellerId,
    kind: "buyer.password_reset",
    refId: member.id,
    message: {
      to: loginId,
      subject: `[${input.shopName}] 비밀번호 재설정 링크예요`,
      text: `${input.shopName} 비밀번호를 다시 정할 수 있어요.\n아래 링크는 30분 동안 한 번만 쓸 수 있어요.\n${link}\n\n요청하지 않았다면 이 메일은 무시해 주세요. 비밀번호는 그대로예요.`,
      html: `<p>${shop} 비밀번호를 다시 정할 수 있어요.</p><p>아래 링크는 30분 동안 한 번만 쓸 수 있어요.</p><p><a href="${esc(link)}">비밀번호 다시 정하기</a></p><p>요청하지 않았다면 이 메일은 무시해 주세요. 비밀번호는 그대로예요.</p>`,
    },
  });
  // 메일이 못 나가도(제공량·잔액·공급자 오류) 응답은 같다. 결과만 로그 추적에 남긴다.
  await writeAudit(db, {
    actorType: "BUYER",
    actorId: member.id,
    sellerId: input.sellerId,
    action: "auth.buyer.password_reset.mail",
    targetType: "BuyerMember",
    targetId: member.id,
    after: { mail: sent.status },
    ip,
    userAgent: meta.userAgent,
  });
  return { ok: true };
}

export type ConfirmResult = { ok: true } | { ok: false; reason: "weak_password" | "token_invalid" | "token_expired" };

export async function confirmBuyerPasswordReset(
  db: PrismaClient,
  input: { sellerId: string; token: string; password: string },
  meta: Meta = {},
): Promise<ConfirmResult> {
  if (!isAcceptableBuyerPassword(input.password)) return { ok: false, reason: "weak_password" };
  if (typeof input.token !== "string" || input.token.length === 0 || input.token.length > 200) return { ok: false, reason: "token_invalid" };
  const now = meta.now ?? (await dbNow(db));
  const tokenHash = hashToken(input.token);
  const fail = (reason: "token_invalid" | "token_expired", memberId: string | null = null) =>
    writeAudit(db, { actorType: "BUYER", actorId: memberId, sellerId: input.sellerId, action: "auth.buyer.password_reset.failed", reason, ip: meta.ip, userAgent: meta.userAgent }).then(() => ({ ok: false as const, reason }));

  // 쓸 수 없는 링크는 해시 계산(느림) 전에 거른다
  const row = await db.buyerPasswordReset.findUnique({ where: { tokenHash } });
  if (!row || row.sellerId !== input.sellerId || row.usedAt) return fail("token_invalid", row?.sellerId === input.sellerId ? row.buyerMemberId : null);
  if (row.expiresAt <= now) return fail("token_expired", row.buyerMemberId);
  const passwordHash = await hashPassword(input.password);

  const done = await db.$transaction(async (tx) => {
    // 회원 행을 잠그고 아직 쓸 수 있는 회원인지 본다(탈퇴·정지와 겹치면 바꾸지 않는다)
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "BuyerMember" WHERE "id" = ${row.buyerMemberId}::uuid AND "sellerId" = ${input.sellerId}::uuid AND "status" = 'ACTIVE' AND "deletedAt" IS NULL FOR NO KEY UPDATE`;
    if (locked.length === 0) return false;
    // 링크 소진: 조건부 갱신이라 동시에 두 번 보내도 한 번만 통과한다
    const used = await tx.buyerPasswordReset.updateMany({ where: { id: row.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (used.count !== 1) return false;
    await tx.buyerMember.update({ where: { id: row.buyerMemberId }, data: { passwordHash } });
    // 이 회원의 모든 로그인 세션 무효화, 남은 다른 링크도 쓸 수 없게 한다
    const revoked = await tx.buyerSession.updateMany({ where: { buyerMemberId: row.buyerMemberId, revokedAt: null }, data: { revokedAt: now } });
    await tx.buyerPasswordReset.deleteMany({ where: { buyerMemberId: row.buyerMemberId, usedAt: null } });
    await writeAudit(tx, {
      actorType: "BUYER",
      actorId: row.buyerMemberId,
      sellerId: input.sellerId,
      action: "auth.buyer.password_reset",
      targetType: "BuyerMember",
      targetId: row.buyerMemberId,
      after: { revokedSessions: revoked.count },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return true;
  });
  if (!done) return fail("token_invalid", row.buyerMemberId);
  return { ok: true };
}
