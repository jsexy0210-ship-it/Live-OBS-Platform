import type { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { writeAudit } from "../audit/log";
import { hashPassword, verifyPassword } from "../auth/password";

// 구매자 탈퇴(ARCHITECTURE 「구매자 회원」: WITHDRAWN과 deletedAt을 같은 트랜잭션에서, 개인정보 비식별).
// - 본인 확인으로 비밀번호를 다시 받는다.
// - 진행 중인 주문(결제 대기, 결제 완료 뒤 구매 확정 전)이 있으면 막는다. 환불·배송 문의를 이어 갈 수 있게 하려는 것.
// - 이름·휴대폰·방송 닉네임·아이디(이메일)를 비식별 값으로 바꾸고, 비밀번호는 아무도 모르는 값으로 바꾼다.
//   CI 해시는 남긴다(원문이 아닌 HMAC 값, 재가입은 부분 유니크 인덱스가 deletedAt IS NULL만 보므로 막히지 않음).
// - 저장 배송지를 지우고, 이 회원의 세션을 모두 폐기한다. 주문·적립 원장은 회원 id로 남는다.

export type WithdrawFailure = "wrong_password" | "orders_in_progress" | "not_found";

export const WITHDRAW_MESSAGES: Record<WithdrawFailure, string> = {
  wrong_password: "비밀번호가 맞지 않아요",
  orders_in_progress: "진행 중인 주문이 있어서 지금은 탈퇴할 수 없어요. 주문이 끝난 뒤 다시 해 주세요",
  not_found: "회원 정보를 찾을 수 없어요",
};

export async function withdrawBuyer(
  db: PrismaClient,
  scope: { sellerId: string; buyerMemberId: string },
  input: { password: string; meta?: { ip?: string | null; userAgent?: string | null }; now?: Date },
): Promise<{ ok: true } | { ok: false; reason: WithdrawFailure }> {
  const now = input.now ?? new Date();
  const member = await db.buyerMember.findFirst({ where: { id: scope.buyerMemberId, sellerId: scope.sellerId, deletedAt: null } });
  if (!member) return { ok: false, reason: "not_found" };
  if (!(await verifyPassword(member.passwordHash, input.password))) {
    await writeAudit(db, { actorType: "BUYER", actorId: member.id, sellerId: scope.sellerId, action: "buyer.withdraw_failed", reason: "wrong_password", ip: input.meta?.ip, userAgent: input.meta?.userAgent });
    return { ok: false, reason: "wrong_password" };
  }
  const unusable = await hashPassword(randomBytes(32).toString("hex"));
  const tag = member.id.replace(/-/g, "").slice(0, 12);
  const result = await db.$transaction(async (tx) => {
    // 같은 회원 행을 잠가 주문 생성·다른 탈퇴 요청과 겹치지 않게 한다
    await tx.$queryRaw`SELECT "id" FROM "BuyerMember" WHERE "id" = ${member.id}::uuid FOR UPDATE`;
    const busy = await tx.order.count({
      where: {
        sellerId: scope.sellerId,
        buyerMemberId: member.id,
        OR: [{ status: "PENDING_PAYMENT" }, { status: "PAID", purchaseConfirmedAt: null }],
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
