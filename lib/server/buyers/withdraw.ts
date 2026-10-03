import type { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { writeAudit } from "../audit/log";
import { loginErrorBody } from "../auth/messages";
import { hashPassword, verifyPassword } from "../auth/password";
import { lockBuyerAddresses } from "./addresses";

// 구매자 탈퇴(ARCHITECTURE 「구매자 회원」: WITHDRAWN과 deletedAt을 같은 트랜잭션에서, 개인정보 비식별).
// 기준(MASTER 결정 2026-10-03):
// - 본인 확인으로 비밀번호를 다시 받는다. 틀리면 구매자 로그인 실패와 같은 문구·상태(401 invalid_credentials).
//   같은 회원이 15분 안에 5번 틀리면 429 too_many_attempts로 막는다(buyer.withdraw_failed 감사 로그로 세고,
//   회원별 advisory lock 아래에서 세고·확인하고·기록해 동시 요청에도 한도를 넘지 않는다).
// - 진행 중인 주문(결제 대기, 결제 완료 뒤 배송 완료 전 = 발송 전·배송 중·재고 부족 환불 대기)이 있으면 막는다.
// - 주문·결제·환불 기록과 주문의 받는 사람 스냅숏은 그대로 둔다(전자상거래법 보관 의무).
// - 이름·휴대폰·방송 닉네임·아이디(이메일)를 비식별 값으로 바꾸고 CI 해시는 비운다(같은 사람·같은 아이디·닉네임으로 다시 가입 가능).
//   비밀번호는 아무도 모르는 값으로 바꾼다.
// - 적립금 잔액은 건드리지 않는다(처리 규칙은 대표님 결정 대기).
// - 저장 배송지를 지우고, 이 회원의 세션을 모두 폐기한다.

export const WITHDRAW_FAIL_LIMIT = 5;
export const WITHDRAW_FAIL_WINDOW_MS = 15 * 60_000;

export type WithdrawFailure = "invalid_credentials" | "too_many_attempts" | "orders_in_progress" | "not_found";

export const WITHDRAW_MESSAGES: Record<WithdrawFailure, string> = {
  invalid_credentials: loginErrorBody("invalid_credentials", "buyer").message,
  too_many_attempts: "비밀번호를 여러 번 틀렸어요. 잠시 뒤 다시 해 주세요",
  orders_in_progress: "진행 중인 주문이 끝나면 탈퇴할 수 있어요",
  not_found: "회원 정보를 찾을 수 없어요",
};
export const WITHDRAW_STATUS: Record<WithdrawFailure, number> = { invalid_credentials: 401, too_many_attempts: 429, orders_in_progress: 409, not_found: 404 };

export async function withdrawBuyer(
  db: PrismaClient,
  scope: { sellerId: string; buyerMemberId: string },
  input: { password: string; meta?: { ip?: string | null; userAgent?: string | null }; now?: Date },
): Promise<{ ok: true } | { ok: false; reason: WithdrawFailure }> {
  const now = input.now ?? new Date();
  const member = await db.buyerMember.findFirst({ where: { id: scope.buyerMemberId, sellerId: scope.sellerId, deletedAt: null } });
  if (!member) return { ok: false, reason: "not_found" };
  const checked = await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`buyer_withdraw:${member.id}`}))`;
      const since = new Date(now.getTime() - WITHDRAW_FAIL_WINDOW_MS);
      const fails = await tx.auditLog.count({ where: { action: "buyer.withdraw_failed", actorId: member.id, createdAt: { gte: since } } });
      if (fails >= WITHDRAW_FAIL_LIMIT) return "too_many_attempts" as const;
      if (await verifyPassword(member.passwordHash, input.password)) return null;
      await writeAudit(tx, { actorType: "BUYER", actorId: member.id, sellerId: scope.sellerId, action: "buyer.withdraw_failed", reason: "wrong_password", ip: input.meta?.ip, userAgent: input.meta?.userAgent });
      return "invalid_credentials" as const;
    },
    { timeout: 15_000 },
  );
  if (checked) return { ok: false, reason: checked };
  const unusable = await hashPassword(randomBytes(32).toString("hex"));
  const tag = member.id.replace(/-/g, "").slice(0, 12);
  const result = await db.$transaction(async (tx) => {
    // 같은 회원 행을 잠가 주문 생성(FOR SHARE)·다른 탈퇴 요청과 겹치지 않게 한다. FOR UPDATE가 아닌 이유: 배송지 저장이
    // 배송지 잠금을 쥔 채 외래 키 확인(FOR KEY SHARE)으로 회원 행을 기다리면 아래 배송지 잠금과 교착이 생긴다.
    await tx.$queryRaw`SELECT "id" FROM "BuyerMember" WHERE "id" = ${member.id}::uuid FOR NO KEY UPDATE`;
    // 배송지 저장·수정과 같은 잠금을 잡아, 겹쳐 저장된 배송지가 탈퇴 뒤에 남지 않게 한다
    await lockBuyerAddresses(tx, scope);
    const busy = await tx.order.count({
      where: {
        sellerId: scope.sellerId,
        buyerMemberId: member.id,
        OR: [{ status: "PENDING_PAYMENT" }, { status: "PAID", OR: [{ shipment: null }, { shipment: { status: { not: "DELIVERED" } } }] }],
      },
    });
    if (busy > 0) return "orders_in_progress" as const;
    const moved = await tx.buyerMember.updateMany({
      where: { id: member.id, sellerId: scope.sellerId, deletedAt: null },
      data: {
        status: "WITHDRAWN",
        deletedAt: now,
        name: "탈퇴한 회원",
        phone: `withdrawn-${tag}`,
        broadcastNickname: `탈퇴회원-${tag}`,
        loginId: `withdrawn-${tag}@withdrawn.invalid`,
        ciHash: "",
        passwordHash: unusable,
        marketingConsentAt: null,
      },
    });
    if (moved.count !== 1) return "not_found" as const;
    const addresses = await tx.buyerAddress.deleteMany({ where: { sellerId: scope.sellerId, buyerMemberId: member.id } });
    const sessions = await tx.buyerSession.updateMany({ where: { buyerMemberId: member.id, revokedAt: null }, data: { revokedAt: now } });
    await writeAudit(tx, {
      actorType: "BUYER",
      actorId: member.id,
      sellerId: scope.sellerId,
      action: "buyer.withdraw",
      targetType: "BuyerMember",
      targetId: member.id,
      ip: input.meta?.ip,
      userAgent: input.meta?.userAgent,
      after: { status: "WITHDRAWN", deletedAddresses: addresses.count, revokedSessions: sessions.count },
    });
    return null;
  });
  return result ? { ok: false, reason: result } : { ok: true };
}
