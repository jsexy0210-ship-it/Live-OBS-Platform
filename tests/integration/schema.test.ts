import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createBuyer, createPaidOrderItem, createSeller, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(() => db.$disconnect());

async function queueItemFor(sellerId: string, gradeId: string, position: number) {
  const buyer = await createBuyer(sellerId, gradeId);
  const { order, item } = await createPaidOrderItem(sellerId, buyer.id);
  return db.queueItem.create({
    data: {
      sellerId,
      orderId: order.id,
      orderItemId: item.id,
      position,
      receivedAt: new Date(),
      nicknameSnapshot: buyer.broadcastNickname,
      productLabel: "부스터 팩 1팩",
      quantity: 1,
    },
  });
}

describe("테넌트 격리 (복합 외래키)", () => {
  it("다른 판매자의 주문에 주문 품목을 붙일 수 없다", async () => {
    const a = await createSeller();
    const b = await createSeller();
    const buyerA = await createBuyer(a.seller.id, a.grade.id);
    const { order, product, option } = await createPaidOrderItem(a.seller.id, buyerA.id);

    await expect(
      db.orderItem.create({
        data: {
          sellerId: b.seller.id,
          orderId: order.id,
          productId: product.id,
          optionId: option.id,
          productNameSnapshot: "x",
          optionNameSnapshot: "x",
          unitPrice: 1,
          quantity: 1,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("다른 판매자의 등급으로 회원을 만들 수 없다", async () => {
    const a = await createSeller();
    const b = await createSeller();
    await expect(createBuyer(b.seller.id, a.grade.id)).rejects.toMatchObject({ code: "P2003" });
  });

  it("다른 판매자의 주문 품목으로 주문대기를 만들 수 없다", async () => {
    const a = await createSeller();
    const b = await createSeller();
    const buyerA = await createBuyer(a.seller.id, a.grade.id);
    const { order, item } = await createPaidOrderItem(a.seller.id, buyerA.id);
    await expect(
      db.queueItem.create({
        data: {
          sellerId: b.seller.id,
          orderId: order.id,
          orderItemId: item.id,
          position: 1,
          receivedAt: new Date(),
          nicknameSnapshot: "x",
          productLabel: "x",
          quantity: 1,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });
});

describe("주문대기 제약", () => {
  it("판매자당 「개봉 중」은 1건만 허용", async () => {
    const { seller, grade } = await createSeller();
    const q1 = await queueItemFor(seller.id, grade.id, 1);
    const q2 = await queueItemFor(seller.id, grade.id, 2);
    await db.queueItem.update({ where: { id: q1.id }, data: { status: "OPENING" } });
    await expect(db.queueItem.update({ where: { id: q2.id }, data: { status: "OPENING" } })).rejects.toMatchObject({
      code: "P2002",
    });
  });

  it("다른 판매자는 각자 「개봉 중」 1건을 가질 수 있다", async () => {
    const a = await createSeller();
    const b = await createSeller();
    const qa = await queueItemFor(a.seller.id, a.grade.id, 1);
    const qb = await queueItemFor(b.seller.id, b.grade.id, 1);
    await db.queueItem.update({ where: { id: qa.id }, data: { status: "OPENING" } });
    await expect(db.queueItem.update({ where: { id: qb.id }, data: { status: "OPENING" } })).resolves.toBeTruthy();
  });

  it("같은 주문 품목은 주문대기에 두 번 들어가지 않는다", async () => {
    const { seller, grade } = await createSeller();
    const q = await queueItemFor(seller.id, grade.id, 1);
    await expect(
      db.queueItem.create({
        data: { ...q, id: undefined, position: 2, version: 0 },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("타이머는 0~3600초", async () => {
    const { seller, grade } = await createSeller();
    const q = await queueItemFor(seller.id, grade.id, 1);
    await expect(db.queueItem.update({ where: { id: q.id }, data: { timerSeconds: 3601 } })).rejects.toThrow();
    await expect(db.queueItem.update({ where: { id: q.id }, data: { timerSeconds: 3600 } })).resolves.toBeTruthy();
  });
});

describe("방송 세션 제약", () => {
  it("판매자당 LIVE 방송은 1개", async () => {
    const { seller } = await createSeller();
    await db.broadcastSession.create({ data: { sellerId: seller.id } });
    await expect(db.broadcastSession.create({ data: { sellerId: seller.id } })).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("재고 제약", () => {
  it("재고는 0 아래로 내려가지 않는다", async () => {
    const { seller, grade } = await createSeller();
    const buyer = await createBuyer(seller.id, grade.id);
    const { option } = await createPaidOrderItem(seller.id, buyer.id, 1);
    await expect(db.productOption.update({ where: { id: option.id }, data: { stock: { decrement: 2 } } })).rejects.toThrow();
  });

  it("조건부 차감은 재고가 모자라면 0건을 바꾼다", async () => {
    const { seller, grade } = await createSeller();
    const buyer = await createBuyer(seller.id, grade.id);
    const { option } = await createPaidOrderItem(seller.id, buyer.id, 1);
    const ok = await db.productOption.updateMany({
      where: { id: option.id, sellerId: seller.id, stock: { gte: 1 } },
      data: { stock: { decrement: 1 } },
    });
    const short = await db.productOption.updateMany({
      where: { id: option.id, sellerId: seller.id, stock: { gte: 1 } },
      data: { stock: { decrement: 1 } },
    });
    expect([ok.count, short.count]).toEqual([1, 0]);
  });
});

describe("구매자 회원 제약", () => {
  it("같은 쇼핑몰에서 휴대폰 번호는 중복 가입할 수 없다", async () => {
    const { seller, grade } = await createSeller();
    await createBuyer(seller.id, grade.id, "01011112222");
    await expect(createBuyer(seller.id, grade.id, "01011112222")).rejects.toMatchObject({ code: "P2002" });
  });

  it("다른 쇼핑몰에는 같은 휴대폰 번호로 가입할 수 있다", async () => {
    const a = await createSeller();
    const b = await createSeller();
    await createBuyer(a.seller.id, a.grade.id, "01011112222");
    await expect(createBuyer(b.seller.id, b.grade.id, "01011112222")).resolves.toBeTruthy();
  });

  it("탈퇴한 회원의 휴대폰 번호로 다시 가입할 수 있다", async () => {
    const { seller, grade } = await createSeller();
    const m = await createBuyer(seller.id, grade.id, "01011112222");
    await db.buyerMember.update({ where: { id: m.id }, data: { status: "WITHDRAWN", deletedAt: new Date() } });
    await expect(createBuyer(seller.id, grade.id, "01011112222")).resolves.toBeTruthy();
  });

  it("같은 쇼핑몰에서 본인인증 CI가 같으면 휴대폰·아이디가 달라도 중복 가입할 수 없다", async () => {
    const { seller, grade } = await createSeller();
    await createBuyer(seller.id, grade.id, "01011112222", "same-ci");
    await expect(createBuyer(seller.id, grade.id, "01033334444", "same-ci")).rejects.toMatchObject({ code: "P2002" });
  });

  it("CI가 같아도 다른 쇼핑몰이나 탈퇴 후에는 가입할 수 있다", async () => {
    const a = await createSeller();
    const b = await createSeller();
    const m = await createBuyer(a.seller.id, a.grade.id, undefined, "same-ci");
    await expect(createBuyer(b.seller.id, b.grade.id, undefined, "same-ci")).resolves.toBeTruthy();
    await db.buyerMember.update({ where: { id: m.id }, data: { status: "WITHDRAWN", deletedAt: new Date() } });
    await expect(createBuyer(a.seller.id, a.grade.id, undefined, "same-ci")).resolves.toBeTruthy();
  });

  it("탈퇴 상태와 deletedAt은 함께 기록해야 한다", async () => {
    const { seller, grade } = await createSeller();
    const m = await createBuyer(seller.id, grade.id);
    await expect(db.buyerMember.update({ where: { id: m.id }, data: { status: "WITHDRAWN" } })).rejects.toThrow();
    await expect(db.buyerMember.update({ where: { id: m.id }, data: { deletedAt: new Date() } })).rejects.toThrow();
  });
});

describe("적립금 제약", () => {
  it("같은 멱등 키로 원장을 두 번 기록할 수 없다", async () => {
    const { seller, grade } = await createSeller();
    const buyer = await createBuyer(seller.id, grade.id);
    const data = {
      sellerId: seller.id,
      buyerMemberId: buyer.id,
      type: "EARN" as const,
      amount: 100,
      testMode: true,
      idempotencyKey: "earn:order-1",
    };
    await db.rewardLedger.create({ data });
    await expect(db.rewardLedger.create({ data })).rejects.toMatchObject({ code: "P2002" });
  });

  it("적립금 잔액은 음수가 될 수 없다", async () => {
    const { seller, grade } = await createSeller();
    const buyer = await createBuyer(seller.id, grade.id);
    await expect(
      db.rewardBalance.create({ data: { sellerId: seller.id, buyerMemberId: buyer.id, balance: -1 } }),
    ).rejects.toThrow();
  });

  it("실지급 스위치는 기본 꺼짐", async () => {
    const { seller } = await createSeller();
    const policy = await db.rewardPolicy.create({ data: { sellerId: seller.id } });
    expect(policy.livePayoutEnabled).toBe(false);
    expect(policy.rankingBonusEnabled).toBe(false);
  });
});

describe("판매자 대표자 제약 (대표자 1명당 쇼핑몰 1개)", () => {
  const rep = (slug: string, status: "PENDING" | "ACTIVE" | "CLOSED" | "REJECTED") =>
    db.seller.create({
      data: { slug, shopName: slug, status, representativeCiHash: "rep-ci", representativeVerifiedAt: new Date() },
    });

  it("같은 대표자 CI로 두 번째 쇼핑몰을 만들면 거부", async () => {
    await rep("a", "ACTIVE");
    await expect(rep("b", "PENDING")).rejects.toMatchObject({ code: "P2002" });
  });

  it("해지한 뒤에는 같은 대표자 CI로 쇼핑몰을 다시 만들 수 있다", async () => {
    const first = await rep("a", "ACTIVE");
    await db.seller.update({ where: { id: first.id }, data: { status: "CLOSED" } });
    await expect(rep("b", "PENDING")).resolves.toBeTruthy();
  });

  it("반려된 가입 신청도 세지 않는다", async () => {
    await rep("a", "REJECTED");
    await expect(rep("b", "PENDING")).resolves.toBeTruthy();
  });

  it("대표자 CI 해시와 인증 시각은 함께 기록해야 한다", async () => {
    await expect(db.seller.create({ data: { slug: "x", shopName: "x", representativeCiHash: "c" } })).rejects.toThrow();
  });
});

describe("본인인증 기록", () => {
  it("완료(VERIFIED) 기록에는 CI 해시와 완료 시각이 있어야 한다", async () => {
    const base = { purpose: "BUYER_SIGNUP" as const, provider: "fake", expiresAt: new Date(Date.now() + 600_000) };
    await expect(db.identityVerification.create({ data: { ...base, requestId: "r1", status: "VERIFIED" } })).rejects.toThrow();
    await expect(
      db.identityVerification.create({
        data: { ...base, requestId: "r2", status: "VERIFIED", ciHash: "h", verifiedAt: new Date(), birthDate: new Date("2000-01-01") },
      }),
    ).resolves.toBeTruthy();
  });

  it("같은 공급자의 같은 요청 id는 한 번만 기록", async () => {
    const data = { purpose: "SELLER_REPRESENTATIVE" as const, provider: "fake", requestId: "dup", expiresAt: new Date() };
    await db.identityVerification.create({ data });
    await expect(db.identityVerification.create({ data })).rejects.toMatchObject({ code: "P2002" });
  });
});
