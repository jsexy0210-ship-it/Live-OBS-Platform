import type { Prisma } from "@prisma/client";
import { memberAuditRetention } from "./memberData";

// 탈퇴 회원의 법정 보관 기록 분리(대표님 결정 2026-10-03, PRODUCT_SCOPE 「구매자 탈퇴·재가입」).
// - 주문(받는 사람 스냅숏·결제·환불 포함): 끝난 주문(취소·환불·구매 확정)에 분리 보관 표시(legalHoldAt)와 보관 만료일
//   (legalRetainUntil = 마지막 거래 시각 + 5년)을 단다. 분리된 주문은 판매자·구매자 일반 조회에서 뺀다(orders/read.ts·buyer.ts).
//   배송 완료 뒤 구매 확정 전인 주문은 아직 환불될 수 있어 두고, 구매 확정·환불 때 분리한다(같은 함수).
// - 감사 로그(회원이 행위자·대상인 행): 거래 관련은 분리 보관·기록 시각 + 5년, 거래 무관은 탈퇴 + 3개월까지 회원 id를 둔다
//   (memberData.ts MEMBER_AUDIT_RETENTION). 기간이 지난 뒤 파기·회원 id 비식별은 별도 함수(정기 실행은 인프라 승인 뒤).
export const LEGAL_RETENTION_YEARS = 5;
export const NON_TRANSACTION_AUDIT_RETENTION_MONTHS = 3;

// 탈퇴한 회원의 끝난 주문을 분리한다. 이미 분리했거나 탈퇴하지 않은 회원이면 0건. orderId를 주면 그 주문만 본다.
export async function holdFinishedOrders(tx: Prisma.TransactionClient, sellerId: string, buyerMemberId: string, now: Date, orderId?: string) {
  return tx.$executeRaw`
    UPDATE "Order" o
    SET "legalHoldAt" = ${now},
        "legalRetainUntil" = GREATEST(o."createdAt", o."paidAt", o."cancelledAt", o."refundedAt", o."purchaseConfirmedAt")
          + make_interval(years => ${LEGAL_RETENTION_YEARS}::int)
    WHERE o."sellerId" = ${sellerId}::uuid AND o."buyerMemberId" = ${buyerMemberId}::uuid
      AND o."legalHoldAt" IS NULL
      AND (o."status" IN ('CANCELLED', 'REFUNDED') OR o."purchaseConfirmedAt" IS NOT NULL)
      AND (${orderId ?? null}::uuid IS NULL OR o."id" = ${orderId ?? null}::uuid)
      AND EXISTS (SELECT 1 FROM "BuyerMember" m WHERE m."id" = o."buyerMemberId" AND m."status" = 'WITHDRAWN')`;
}

// 탈퇴 때 그 회원이 행위자(actorType=BUYER)·대상(targetType=BuyerMember)인 감사 로그에 보관 기한을 단다.
// 분류가 없는 행동은 더 긴 거래 관련 기준으로 둔다(누락은 tests/unit/memberData.test.ts가 잡는다).
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
  const nonTransactionRows = nonTransaction.length
    ? await tx.$executeRaw`
        UPDATE "AuditLog"
        SET "retainUntil" = ${now}::timestamptz + make_interval(months => ${NON_TRANSACTION_AUDIT_RETENTION_MONTHS}::int)
        WHERE "sellerId" = ${sellerId}::uuid AND "action" = ANY(${nonTransaction}::text[])
          AND (("actorType" = 'BUYER' AND "actorId" = ${buyerMemberId}::uuid) OR ("targetType" = 'BuyerMember' AND "targetId" = ${buyerMemberId}))`
    : 0;
  const transactionRows = transaction.length
    ? await tx.$executeRaw`
        UPDATE "AuditLog"
        SET "legalHoldAt" = ${now}, "retainUntil" = "createdAt" + make_interval(years => ${LEGAL_RETENTION_YEARS}::int)
        WHERE "sellerId" = ${sellerId}::uuid AND "action" = ANY(${transaction}::text[])
          AND (("actorType" = 'BUYER' AND "actorId" = ${buyerMemberId}::uuid) OR ("targetType" = 'BuyerMember' AND "targetId" = ${buyerMemberId}))`
    : 0;
  return { heldAuditLogs: transactionRows, expiringAuditLogs: nonTransactionRows };
}
