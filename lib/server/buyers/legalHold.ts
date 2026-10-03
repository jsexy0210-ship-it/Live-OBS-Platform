import { Prisma } from "@prisma/client";
import { NON_TRANSACTION_AUDIT_RETENTION_MONTHS, TRANSACTION_AUDIT_RETENTION_MONTHS, memberAuditRetention } from "./memberData";

// 법정 보관 기록(대표님 결정 2026-10-03, PRODUCT_SCOPE 「구매자 탈퇴·재가입」·개인정보 처리방침 2-(1)-③).
// - 주문(받는 사람 스냅숏·결제·환불 포함): 끝난 주문(취소·환불·구매 확정)은 회원과 상관없이 보관 만료일
//   legalRetainUntil = 끝난 날(createdAt·paidAt·cancelledAt·refundedAt·purchaseConfirmedAt 중 가장 늦은 때) + 5년을 계산해 둔다.
//   끝나는 일(취소·자동 취소·환불·구매 확정)이 생길 때마다 다시 계산한다(구매 확정 뒤 환불되면 환불 날 기준).
// - 탈퇴하지 않은 회원의 끝난 주문은 회원 서비스(주문 내역, 교환·반품·문의)를 위해 그대로 두고, 분리 보관 표시(legalHoldAt)는
//   탈퇴 때 그 회원의 끝난 주문에, 탈퇴 뒤 끝나는 주문은 끝날 때 단다. 분리된 주문은 판매자·구매자 일반 조회에서 뺀다(orders/read.ts·buyer.ts).
// - 감사 로그(회원이 행위자·대상인 행): 기록할 때 행동 종류별로 retainUntil(거래 관련 + 5년, 거래 무관 + 3개월, audit/log.ts)을 달고,
//   탈퇴 때 거래 관련 행에 분리 보관 표시를 단다. 기간이 지난 뒤 파기·회원 id 비식별은 별도 함수(⑩).
export const LEGAL_RETENTION_YEARS = 5;

// 끝난 주문의 보관 만료일을 다시 계산하고, 회원이 탈퇴했으면 분리 보관 표시를 단다(이미 단 표시는 그대로).
// orderId를 주면 그 주문만, buyerMemberId를 주면 그 회원 주문만. 분리 보관 표시를 새로 단 주문 수를 돌려준다.
export async function refreshOrderRetention(
  tx: Prisma.TransactionClient,
  sellerId: string,
  now: Date,
  scope: { orderId?: string; buyerMemberId?: string },
): Promise<number> {
  const rows = await tx.$queryRaw<{ held: boolean }[]>`
    UPDATE "Order" o
    SET "legalRetainUntil" = GREATEST(o."createdAt", o."paidAt", o."cancelledAt", o."refundedAt", o."purchaseConfirmedAt")
          + make_interval(years => ${LEGAL_RETENTION_YEARS}::int),
        "legalHoldAt" = CASE WHEN m."status" = 'WITHDRAWN' THEN COALESCE(o."legalHoldAt", ${now}) ELSE o."legalHoldAt" END
    FROM "BuyerMember" m
    WHERE m."id" = o."buyerMemberId" AND o."sellerId" = ${sellerId}::uuid
      AND (o."status" IN ('CANCELLED', 'REFUNDED') OR o."purchaseConfirmedAt" IS NOT NULL)
      AND (${scope.orderId ?? null}::uuid IS NULL OR o."id" = ${scope.orderId ?? null}::uuid)
      AND (${scope.buyerMemberId ?? null}::uuid IS NULL OR o."buyerMemberId" = ${scope.buyerMemberId ?? null}::uuid)
    RETURNING (o."legalHoldAt" = ${now}) AS "held"`;
  return rows.filter((r) => r.held).length;
}

// 탈퇴 때 그 회원이 행위자(actorType=BUYER)·대상(targetType=BuyerMember)인 감사 로그 정리: 거래 관련 행(분류 없음 포함)에 분리 보관
// 표시를 달고, 보관 기한이 아직 없는 행(이 기능 전 기록)은 기록 시각 기준으로 채운다(거래 관련 + 5년, 거래 무관 + 3개월).
export async function holdMemberAuditLogs(tx: Prisma.TransactionClient, sellerId: string, buyerMemberId: string, now: Date) {
  const where: Prisma.AuditLogWhereInput = {
    sellerId,
    OR: [
      { actorType: "BUYER", actorId: buyerMemberId },
      { targetType: "BuyerMember", targetId: buyerMemberId },
    ],
  };
  const actions = (await tx.auditLog.findMany({ where, distinct: ["action"], select: { action: true } })).map((r) => r.action);
  const nonTransaction = actions.filter((a) => memberAuditRetention(a) === "non_transaction");
  const transaction = actions.filter((a) => !nonTransaction.includes(a));
  const mine = Prisma.sql`"sellerId" = ${sellerId}::uuid
    AND (("actorType" = 'BUYER' AND "actorId" = ${buyerMemberId}::uuid) OR ("targetType" = 'BuyerMember' AND "targetId" = ${buyerMemberId}))`;
  const heldAuditLogs = transaction.length
    ? await tx.$executeRaw`
        UPDATE "AuditLog"
        SET "legalHoldAt" = COALESCE("legalHoldAt", ${now}),
            "retainUntil" = COALESCE("retainUntil", "createdAt" + make_interval(months => ${TRANSACTION_AUDIT_RETENTION_MONTHS}::int))
        WHERE ${mine} AND "action" = ANY(${transaction}::text[])`
    : 0;
  if (nonTransaction.length) {
    await tx.$executeRaw`
      UPDATE "AuditLog" SET "retainUntil" = "createdAt" + make_interval(months => ${NON_TRANSACTION_AUDIT_RETENTION_MONTHS}::int)
      WHERE ${mine} AND "retainUntil" IS NULL AND "action" = ANY(${nonTransaction}::text[])`;
  }
  return heldAuditLogs;
}
