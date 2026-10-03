import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../lib/server/db";
import { createBuyer, createPaidOrderItem, createSeller, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

// 이 기능 배포 전에 탈퇴한 회원의 정리 마이그레이션을 같은 SQL로 다시 실행해 본다(다시 실행해도 같은 결과)
const SQL = readFileSync("prisma/migrations/20261004020500_withdrawn_member_backfill/migration.sql", "utf8");
async function runBackfill() {
  const statements = SQL.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
  for (const s of statements) await db.$executeRawUnsafe(s);
}

describe("이미 탈퇴한 회원 정리 마이그레이션", () => {
  it("탈퇴 회원의 생년월일·동의 기록·본인확인 식별 항목을 비우고 끝난 주문·거래 감사 로그에 분리 보관 표시를 단다. 탈퇴 안 한 회원·다른 쇼핑몰은 그대로", async () => {
    const { seller, grade } = await createSeller();
    const other = await createSeller();
    const gone = await createBuyer(seller.id, grade.id);
    const live = await createBuyer(seller.id, grade.id);
    const deletedAt = new Date("2026-09-30T00:00:00Z");
    // 예전 탈퇴 처리: 상태·deletedAt·CI 해시만 바뀌고 생년월일·동의·본인확인 기록은 남아 있다
    await db.buyerMember.update({
      where: { id: gone.id },
      data: { status: "WITHDRAWN", deletedAt, ciHash: "", marketingConsentAt: new Date(), signupConsent: { termsVersion: "t" }, rejoinRestrictionDaysAgreed: 30, rejoinRetentionVersion: "r" },
    });
    const idv = (sellerId: string, subjectId: string | null, ciHash: string | null) =>
      db.identityVerification.create({
        data: { purpose: "BUYER_SIGNUP", sellerId, subjectId, provider: "fake", method: "SMS", requestId: `req-${Math.random()}`, requestedPhone: "01012345678", name: "김구매", phone: "01012345678", ciHash, status: "VERIFIED", verifiedAt: new Date(), ownerTokenHash: "h", expiresAt: new Date(), consumedAt: new Date() },
      });
    const goneIdv = await idv(seller.id, gone.id, "ci-gone");
    // 같은 사람의 다른 시도(회원과 이어지지 않음). 회원 행 CI는 예전 탈퇴 처리로 ''라서 이어진 기록의 CI로 찾아야 한다
    const goneRetry = await idv(seller.id, null, "ci-gone");
    const liveIdv = await idv(seller.id, live.id, live.ciHash);
    const otherIdv = await idv(other.seller.id, null, "ci-gone");
    let no = 0;
    const order = (buyerMemberId: string, status: "PAID" | "CANCELLED" | "REFUNDED", purchaseConfirmedAt: Date | null = null) =>
      db.order.create({ data: { sellerId: seller.id, orderNo: ++no, buyerMemberId, broadcastNicknameSnapshot: "닉", totalAmount: 1000, status, purchaseConfirmedAt } });
    const goneDone = await order(gone.id, "REFUNDED");
    const goneConfirmed = await order(gone.id, "PAID", new Date());
    const goneOpen = await order(gone.id, "PAID");
    const liveDone = await order(live.id, "CANCELLED");
    const txLog = await db.auditLog.create({ data: { actorType: "BUYER", actorId: gone.id, sellerId: seller.id, action: "order.create" } });
    const loginLog = await db.auditLog.create({ data: { actorType: "BUYER", actorId: gone.id, sellerId: seller.id, action: "auth.buyer.login" } });
    // 방송 화면·주문 목록에 남은 닉네임, 세션·구매 제한·저장 배송지
    const paid = await createPaidOrderItem(seller.id, gone.id);
    const queue = await db.queueItem.create({ data: { sellerId: seller.id, orderId: paid.order.id, orderItemId: paid.item.id, position: 1, receivedAt: new Date(), nicknameSnapshot: "닉네임", productLabel: "부스터", quantity: 1 } });
    const hit = await db.hitCard.create({ data: { sellerId: seller.id, buyerMemberId: gone.id, nicknameSnapshot: "닉네임", cardName: "레어" } });
    const liveHit = await db.hitCard.create({ data: { sellerId: seller.id, buyerMemberId: live.id, nicknameSnapshot: "살아있음", cardName: "레어" } });
    await db.buyerSession.create({ data: { sellerId: seller.id, buyerMemberId: gone.id, tokenHash: "t-gone", expiresAt: new Date(), revokedAt: new Date() } });
    await db.buyerSession.create({ data: { sellerId: seller.id, buyerMemberId: live.id, tokenHash: "t-live", expiresAt: new Date() } });
    await db.buyerPurchaseRestriction.create({ data: { sellerId: seller.id, buyerMemberId: gone.id, reason: "unpaid", startsAt: new Date(), endsAt: new Date() } });

    await runBackfill();
    await runBackfill();

    expect(await db.buyerMember.findUniqueOrThrow({ where: { id: gone.id } })).toMatchObject({
      birthDate: null, signupConsent: null, marketingConsentAt: null, rejoinRestrictionDaysAgreed: null, rejoinRetentionVersion: null,
    });
    expect((await db.buyerMember.findUniqueOrThrow({ where: { id: live.id } })).birthDate).not.toBeNull();
    const g = await db.identityVerification.findUniqueOrThrow({ where: { id: goneIdv.id } });
    expect(g).toMatchObject({ name: null, phone: null, ciHash: null, subjectId: null, status: "VERIFIED", anonymizedAt: deletedAt });
    expect(g.requestId).toMatch(/^anonymized:/);
    expect(await db.identityVerification.findUniqueOrThrow({ where: { id: goneRetry.id } })).toMatchObject({ name: null, ciHash: null, anonymizedAt: deletedAt });
    for (const id of [liveIdv.id, otherIdv.id]) expect((await db.identityVerification.findUniqueOrThrow({ where: { id } })).anonymizedAt).toBeNull();
    const held = async (id: string) => (await db.order.findUniqueOrThrow({ where: { id } })).legalHoldAt;
    expect(await held(goneDone.id)).toEqual(deletedAt);
    expect(await held(goneConfirmed.id)).toEqual(deletedAt);
    expect(await held(goneOpen.id)).toBeNull();
    expect(await held(liveDone.id)).toBeNull();
    expect((await db.auditLog.findUniqueOrThrow({ where: { id: txLog.id } })).legalHoldAt).toEqual(deletedAt);
    expect((await db.auditLog.findUniqueOrThrow({ where: { id: loginLog.id } })).legalHoldAt).toBeNull();
    expect((await db.order.findUniqueOrThrow({ where: { id: paid.order.id } })).broadcastNicknameSnapshot).toBe("탈퇴한 회원");
    expect((await db.queueItem.findUniqueOrThrow({ where: { id: queue.id } })).nicknameSnapshot).toBe("탈퇴한 회원");
    expect((await db.hitCard.findUniqueOrThrow({ where: { id: hit.id } })).nicknameSnapshot).toBe("탈퇴한 회원");
    expect((await db.hitCard.findUniqueOrThrow({ where: { id: liveHit.id } })).nicknameSnapshot).toBe("살아있음");
    expect((await db.buyerSession.findMany()).map((x) => x.tokenHash)).toEqual(["t-live"]);
    expect(await db.buyerPurchaseRestriction.count()).toBe(0);
  });
});
