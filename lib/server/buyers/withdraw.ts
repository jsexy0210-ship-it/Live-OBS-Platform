import { Prisma, type PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { writeAudit } from "../audit/log";
import { loginErrorBody } from "../auth/messages";
import { hashPassword, verifyPassword } from "../auth/password";
import { lockSellerOrders } from "../orders/overdue";
import { cancelPendingOrderInTx } from "../queue/service";
import { lockBuyerAddresses } from "./addresses";
import { clearCart, lockBuyerCart } from "../shop-cart/service";
import { clearRestock, lockBuyerRestock } from "../shop-restock-alerts/service";
import { clearWish, lockBuyerWish } from "../shop-wish/service";
import { holdMemberAuditLogs, refreshOrderRetention } from "./legalHold";
import { anonymizeMemberEventEntries } from "../events/entries";
import { WITHDRAWN_DISPLAY_NAME } from "./memberData";
import { purgeExpiredRejoinBlocks, recordRejoinBlock } from "./rejoin";
import { purgeSignupVerificationsForShop } from "./signup";
import { deleteUnusedBuyerCoupons } from "../shop-coupons/service";
import { anonymizeMemberReviews } from "../product-reviews/service";
import { anonymizeMemberInquiries } from "../buyer-inquiries/service";
import { deleteMemberGradeData } from "../shop-member-grades/service";
import { deleteMemberMessageData } from "../shop-member-messages/service";
import { clearReturnRefundAccounts, deleteUnattachedReturnImages } from "../shop-returns/hooks";

// 구매자 탈퇴(ARCHITECTURE 「구매자 회원」: WITHDRAWN과 deletedAt을 같은 트랜잭션에서, 개인정보 비식별).
// 기준(MASTER 결정 2026-10-03):
// - 본인 확인으로 비밀번호를 다시 받는다. 틀리면 구매자 로그인 실패와 같은 문구·상태(401 invalid_credentials).
//   같은 회원이 15분 안에 5번 틀리면 429 too_many_attempts로 막는다(buyer.withdraw_failed 감사 로그로 세고,
//   회원별 advisory lock 아래에서 세고·확인하고·기록해 동시 요청에도 한도를 넘지 않는다).
// - 결제 완료 뒤 배송 완료 전 주문(발송 전·배송 중·재고 부족 환불 대기)이 있으면 409 orders_in_progress로 막는다.
//   결제 대기 주문은 막지 않고 탈퇴 트랜잭션 안에서 자동 취소한다(약관 제7조 ①, MASTER 결정 2026-10-03). 판매자 취소와 같은 경로
//   (queue/service.ts cancelPendingOrderInTx: 상태 이력·주문 때 뺀 재고 되돌리기·감사 로그 order.cancel, 사유 member_withdrawn)를 쓴다.
// - 주문·결제·환불 기록과 주문의 받는 사람 스냅숏은 그대로 둔다(전자상거래법 보관 의무).
// - 이름·휴대폰·방송 닉네임·아이디(이메일)를 비식별 값으로 바꾸고 CI 해시·생년월일은 비운다(같은 사람·같은 아이디·닉네임으로 다시 가입 가능).
//   그 회원의 본인확인 기록(이 쇼핑몰에서 이 회원과 이어졌거나 같은 CI 해시)은 행을 두고 식별 항목만 비운다(한도 계산 값 보존).
//   주문·주문대기·히트 카드의 방송 닉네임 스냅숏은 「탈퇴한 회원」으로 바꾸고, 받는 사람 스냅숏 등 법정 거래 기록은 그대로 둔다.
//   표마다 처리 방식은 buyers/memberData.ts MEMBER_DATA_POLICY에 둔다(PRODUCT_SCOPE 「구매자 탈퇴·재가입」).
// - 이름·휴대폰·방송 닉네임·아이디(이메일)를 비식별 값으로 바꾸고 회원 행의 CI 해시는 비운다(같은 아이디·닉네임으로 다시 가입 가능).
//   재가입 제한이 켜진 쇼핑몰이고 가입 때 제한 기간을 안내받은 회원이면 CI 해시 하나만 제한 기간 동안 따로 남겨(buyers/rejoin.ts)
//   그동안 같은 사람의 가입을 막는다.
//   비밀번호는 아무도 모르는 값으로 바꾼다.
// - 남은 적립금은 소멸한다(대표님 결정 2026-10-03, PRODUCT_SCOPE 「구매자 탈퇴·재가입」). 잔액(RewardBalance)이 있으면 그만큼
//   소멸(EXPIRE, 음수, SUCCEEDED) 원장을 남기고 잔액을 0으로 만든다. 아직 처리 전(PENDING)인 이 회원의 원장(지급·회수 대기)은
//   FAILED(member_withdrawn)로 닫아 나중에 잔액에 들어가지 않게 한다. 재가입하면 새 회원이라 되살아나지 않는다.
// - 저장 배송지·구매 제한·세션 행을 지운다.
// - 법정 보관 기록을 분리한다(buyers/legalHold.ts): 이 회원의 끝난 주문에 분리 보관 표시를 달아 일반 조회에서 빼고(보관 만료일은
//   끝난 날 + 5년), 이 회원이 행위자·대상인 거래 관련 감사 로그에도 분리 보관 표시를 단다.

export const WITHDRAW_FAIL_LIMIT = 5;
export const WITHDRAW_FAIL_WINDOW_MS = 15 * 60_000;

export type WithdrawFailure = "invalid_credentials" | "too_many_attempts" | "orders_in_progress" | "not_found";

export const WITHDRAW_MESSAGES: Record<WithdrawFailure, string> = {
  invalid_credentials: loginErrorBody("invalid_credentials", "buyer").message,
  too_many_attempts: "비밀번호를 여러 번 틀렸어요. 잠시 뒤 다시 해 주세요",
  orders_in_progress: "배송 중인 주문이 끝나거나 환불되면 탈퇴할 수 있어요",
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
  // 이 쇼핑몰의 기간이 끝난 재가입 제한 기록을 먼저 지운다(정기 실행 연결 전 파기 경로)
  await purgeExpiredRejoinBlocks(db, now, scope.sellerId);
  await purgeSignupVerificationsForShop(db, scope.sellerId);
  const tag = member.id.replace(/-/g, "").slice(0, 12);
  const result = await db.$transaction(async (tx) => {
    // 같은 회원 행을 잠가 주문 생성(FOR SHARE)·다른 탈퇴 요청과 겹치지 않게 한다. FOR UPDATE가 아닌 이유: 배송지 저장이
    // 배송지 잠금을 쥔 채 외래 키 확인(FOR KEY SHARE)으로 회원 행을 기다리면 아래 배송지 잠금과 교착이 생긴다.
    // 주문 생성·결제·자동 취소와 같은 판매자 주문 잠금을 먼저 잡는다(주문 생성과 같은 순서: 판매자 주문 잠금 → 회원 행)
    await lockSellerOrders(tx, scope.sellerId);
    // 결제 대기 주문 행은 회원 행보다 먼저 잠근다. 입금 확인은 주문 행을 바꾼 뒤 적립 예정 기록에서 회원 행을 FOR SHARE로 잠그므로
    // (rewards/ledger.ts), 회원 행을 쥔 채 주문 행을 기다리면 교착이 생긴다. 판매자 취소·입금 확인은 이 잠금이 아니라 판매자 행 잠금으로
    // 주문을 바꾸므로, 잠근 뒤 지금 상태를 다시 읽어 그사이 취소됐으면 건너뛰고 결제됐으면 진행 중 주문으로 거절한다(500이 나지 않게).
    const listed = await tx.order.findMany({ where: { sellerId: scope.sellerId, buyerMemberId: member.id, status: "PENDING_PAYMENT" }, select: { id: true }, orderBy: { id: "asc" } });
    const pending: string[] = [];
    for (const o of listed) {
      const [cur] = await tx.$queryRaw<{ status: string }[]>`SELECT "status" FROM "Order" WHERE "id" = ${o.id}::uuid FOR UPDATE`;
      if (cur?.status === "CANCELLED") continue;
      if (cur?.status !== "PENDING_PAYMENT") return "orders_in_progress" as const;
      pending.push(o.id);
    }
    // 전역 잠금 순서(주문 → 회원 → 리뷰 → 원장): 아래에서 바꾸는 이 회원의 주문 행(닉네임 비식별·보관 기한 갱신)을 회원 행보다 먼저
    // id 순으로 잠근다(결제 대기 주문 확인 뒤, 회원 행 앞). 상품 리뷰 쓰기는 주문(FOR SHARE) → 회원(FOR SHARE) 순서라, 회원을 쥔 채 주문을 기다리면 교착이 생긴다(product-reviews).
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "sellerId" = ${scope.sellerId}::uuid AND "buyerMemberId" = ${member.id}::uuid ORDER BY "id" FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "BuyerMember" WHERE "id" = ${member.id}::uuid FOR NO KEY UPDATE`;
    // 재가입 제한은 지금 동의 상태로 정한다(PRODUCT_SCOPE, 개인정보 보호법 제37조). 잠금 전에 읽은 값은 그사이 철회됐을 수 있다.
    const { rejoinRestrictionDaysAgreed } = await tx.buyerMember.findUniqueOrThrow({ where: { id: member.id }, select: { rejoinRestrictionDaysAgreed: true } });
    // 배송지 저장·수정과 같은 잠금을 잡아, 겹쳐 저장된 배송지가 탈퇴 뒤에 남지 않게 한다
    await lockBuyerAddresses(tx, scope);
    // 장바구니 담기·수량 변경과 같은 잠금을 잡아, 겹쳐 담긴 줄이 탈퇴 뒤에 남지 않게 한다(shop-cart)
    await lockBuyerCart(tx, scope);
    await lockBuyerWish(tx, scope);
    await lockBuyerRestock(tx, scope);
    const busy = await tx.order.count({
      where: {
        sellerId: scope.sellerId,
        buyerMemberId: member.id,
        status: "PAID",
        OR: [{ shipment: null }, { shipment: { status: { not: "DELIVERED" } } }],
      },
    });
    if (busy > 0) return "orders_in_progress" as const;
    for (const orderId of pending) {
      await cancelPendingOrderInTx(tx, { sellerId: scope.sellerId, orderId, now, actorType: "BUYER", actorId: member.id, reason: "member_withdrawn" });
    }
    const moved = await tx.buyerMember.updateMany({
      where: { id: member.id, sellerId: scope.sellerId, deletedAt: null },
      data: {
        status: "WITHDRAWN",
        deletedAt: now,
        name: WITHDRAWN_DISPLAY_NAME,
        phone: `withdrawn-${tag}`,
        broadcastNickname: `탈퇴회원-${tag}`,
        loginId: `withdrawn-${tag}@withdrawn.invalid`,
        ciHash: "",
        birthDate: null,
        passwordHash: unusable,
        marketingConsentAt: null,
        marketingConsentVersion: null,
        marketingWithdrawnAt: null,
        // 동의 기록(필수·선택 동의 문서 버전·시각, 재가입 제한 보관 동의 스냅숏)도 비운다. 재가입 제한 기록은 아래
        // recordRejoinBlock이 탈퇴 전에 읽은 member 값으로 만든다.
        signupConsent: Prisma.DbNull,
        rejoinRestrictionDaysAgreed: null,
        rejoinRetentionAgreedAt: null,
        rejoinRetentionVersion: null,
        rejoinRetentionWithdrawnAt: null,
      },
    });
    if (moved.count !== 1) return "not_found" as const;
    await anonymizeMemberEventEntries(tx, scope, now);
    const forfeited = await forfeitRewards(tx, scope.sellerId, member.id, now);
    // 본인확인 기록은 행을 지우지 않고 식별 항목만 비운다(미가입 기록 정리와 같은 기준, buyers/signup.ts). 쇼핑몰·상태·요청 시각·요청 IP는
    // 체험 한도(VERIFIED 건수)·같은 IP 하루 횟수 계산에 남긴다(지우면 가입·탈퇴를 되풀이해 유료 문자를 다시 받는 남용, MASTER 결정 2026-10-03).
    const identities = await tx.$executeRaw`
      UPDATE "IdentityVerification"
      SET "name" = NULL, "phone" = NULL, "requestedPhone" = NULL, "birthDate" = NULL, "ciHash" = NULL, "subjectId" = NULL,
          "signupConsent" = NULL, "ownerTokenHash" = NULL, "requestId" = 'anonymized:' || gen_random_uuid()::text, "anonymizedAt" = ${now}
      WHERE "sellerId" = ${scope.sellerId}::uuid AND "anonymizedAt" IS NULL
        AND ("subjectId" = ${member.id}::uuid OR (${member.ciHash || null}::text IS NOT NULL AND "ciHash" = ${member.ciHash || null}::text))`;
    // 방송 화면·주문 목록에 남는 닉네임 스냅숏(주문·주문대기·히트 카드). 받는 사람 스냅숏은 법정 보관이라 그대로.
    const orders = await tx.order.updateMany({ where: { sellerId: scope.sellerId, buyerMemberId: member.id }, data: { broadcastNicknameSnapshot: WITHDRAWN_DISPLAY_NAME } });
    const queueItems = await tx.queueItem.updateMany({
      where: { sellerId: scope.sellerId, order: { buyerMemberId: member.id } },
      data: { nicknameSnapshot: WITHDRAWN_DISPLAY_NAME },
    });
    const hitCards = await tx.hitCard.updateMany({ where: { sellerId: scope.sellerId, buyerMemberId: member.id }, data: { nicknameSnapshot: WITHDRAWN_DISPLAY_NAME } });
    const memo = await tx.memberMemo.deleteMany({ where: { sellerId: scope.sellerId, buyerMemberId: member.id } });
    const restrictions = await tx.buyerPurchaseRestriction.deleteMany({ where: { sellerId: scope.sellerId, buyerMemberId: member.id } });
    const rejoinBlockedUntil = await recordRejoinBlock(tx, scope.sellerId, { ciHash: member.ciHash, rejoinRestrictionDaysAgreed }, now);
    const addresses = await tx.buyerAddress.deleteMany({ where: { sellerId: scope.sellerId, buyerMemberId: member.id } });
    await clearCart(tx, { sellerId: scope.sellerId, buyerMemberId: member.id });
    await clearWish(tx, { sellerId: scope.sellerId, buyerMemberId: member.id });
    await clearRestock(tx, { sellerId: scope.sellerId, buyerMemberId: member.id });
    await tx.buyerNotificationPref.deleteMany({ where: { sellerId: scope.sellerId, buyerMemberId: member.id } });
    // 쓰지 않은 쿠폰 삭제(결제 대기 주문을 위에서 취소해 되돌린 쿠폰은 주문 기록과 이어져 남는다, shop-coupons)
    const deletedCoupons = await deleteUnusedBuyerCoupons(tx, { sellerId: scope.sellerId, buyerMemberId: member.id });
    // 상품 리뷰는 남기고 작성자 표시만 「탈퇴 회원」으로, 신고·붙지 않은 사진은 지운다(product-reviews)
    const reviews = await anonymizeMemberReviews(tx, { sellerId: scope.sellerId, buyerMemberId: member.id });
    // 구매자 문의는 남기고 작성자 표시만 「탈퇴한 회원」으로, 사진은 모두 지운다(buyer-inquiries)
    const inquiries = await anonymizeMemberInquiries(tx, { sellerId: scope.sellerId, buyerMemberId: member.id });
    // 교환·반품 신청에 붙지 않은 사진은 지운다(신청에 붙은 사진은 신청과 함께 법정 보관, shop-returns)
    await deleteUnattachedReturnImages(tx, { sellerId: scope.sellerId, buyerMemberId: member.id });
    // 신청에 남은 무통장 환불 계좌는 비운다(shop-returns)
    await clearReturnRefundAccounts(tx, { sellerId: scope.sellerId, buyerMemberId: member.id });
    // 회원 등급 고정 표시·변경 기록 삭제(shop-member-grades)
    await deleteMemberGradeData(tx, { sellerId: scope.sellerId, buyerMemberId: member.id });
    // 회원 대상 발송의 받는 사람 기록 삭제(shop-member-messages)
    await deleteMemberMessageData(tx, { sellerId: scope.sellerId, buyerMemberId: member.id });
    const sessions = await tx.buyerSession.deleteMany({ where: { buyerMemberId: member.id } });
    // 적립금 소멸 안내 기록(잔액을 위에서 0으로 만들어 더 안내할 일이 없다, 개인정보 없음)
    const expiryNotices = await tx.rewardExpiryNotice.deleteMany({ where: { sellerId: scope.sellerId, buyerMemberId: member.id } });
    const heldOrders = await refreshOrderRetention(tx, scope.sellerId, now, { buyerMemberId: member.id });
    await writeAudit(tx, {
      actorType: "BUYER",
      actorId: member.id,
      sellerId: scope.sellerId,
      action: "buyer.withdraw",
      targetType: "BuyerMember",
      targetId: member.id,
      ip: input.meta?.ip,
      userAgent: input.meta?.userAgent,
      after: { status: "WITHDRAWN", deletedAddresses: addresses.count, deletedSessions: sessions.count, deletedRewardExpiryNotices: expiryNotices.count, anonymizedVerifications: identities, anonymizedOrders: orders.count, anonymizedQueueItems: queueItems.count, anonymizedHitCards: hitCards.count, deletedRestrictions: restrictions.count, deletedMemos: memo.count, cancelledPendingOrders: pending.length, heldOrders, rejoinBlockedUntil, ...forfeited, deletedCoupons, reviews, inquiries },
    });
    // 방금 남긴 탈퇴 기록까지 포함해 기한을 단다
    await holdMemberAuditLogs(tx, scope.sellerId, member.id, now);
    return null;
  });
  return result ? { ok: false, reason: result } : { ok: true };
}

// 탈퇴 회원의 적립금 소멸. 잔액 행을 잠그고(FOR UPDATE) 남은 만큼 EXPIRE 원장을 남긴 뒤 0으로 만든다.
async function forfeitRewards(tx: Prisma.TransactionClient, sellerId: string, buyerMemberId: string, now: Date) {
  const [row] = await tx.$queryRaw<{ balance: number }[]>`
    SELECT "balance" FROM "RewardBalance" WHERE "sellerId" = ${sellerId}::uuid AND "buyerMemberId" = ${buyerMemberId}::uuid FOR UPDATE`;
  const expiredPoints = row?.balance ?? 0;
  if (expiredPoints > 0) {
    await tx.rewardLedger.create({
      data: {
        sellerId,
        buyerMemberId,
        type: "EXPIRE",
        amount: -expiredPoints,
        status: "SUCCEEDED",
        testMode: false,
        failureReason: null,
        idempotencyKey: `expire:withdraw:${buyerMemberId}`,
        createdAt: now,
        processedAt: now,
      },
    });
    await tx.rewardBalance.update({ where: { sellerId_buyerMemberId: { sellerId, buyerMemberId } }, data: { balance: 0 } });
  }
  const closed = await tx.rewardLedger.updateMany({
    where: { sellerId, buyerMemberId, status: "PENDING" },
    data: { status: "FAILED", failureReason: "member_withdrawn", processedAt: now },
  });
  return { expiredPoints, closedPendingRewards: closed.count };
}
