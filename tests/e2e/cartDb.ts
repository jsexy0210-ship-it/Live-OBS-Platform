import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 장바구니 e2e 준비·정리(폐기용 테스트 DB). 데모 구매자의 장바구니를 비우고 상품 이름으로 고른 첫 옵션을 담는다.
// 품절 줄은 API가 담기를 막으므로 DB에 바로 넣는다.
const open = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });

export async function resetCartInDb(slug: string, loginId: string, lines: { productName: string; quantity: number }[]) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const buyer = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, loginId, deletedAt: null } });
    await db.cartItem.deleteMany({ where: { sellerId: seller.id, buyerMemberId: buyer.id } });
    for (const l of lines) {
      const option = await db.productOption.findFirstOrThrow({ where: { sellerId: seller.id, deletedAt: null, product: { name: l.productName, deletedAt: null } }, orderBy: { createdAt: "asc" } });
      await db.cartItem.create({ data: { sellerId: seller.id, buyerMemberId: buyer.id, optionId: option.id, quantity: l.quantity } });
    }
  } finally {
    await db.$disconnect();
  }
}

// 주문서 e2e가 만든 주문 정리: 데모 구매자가 since 이후에 만든 주문과 딸린 행을 지운다(재고 이동·알림 포함).
export async function deleteBuyerOrdersSince(slug: string, loginId: string, since: Date) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const buyer = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, loginId, deletedAt: null } });
    const orders = await db.order.findMany({ where: { sellerId: seller.id, buyerMemberId: buyer.id, createdAt: { gte: since } }, select: { id: true } });
    const orderId = { in: orders.map((o) => o.id) };
    await db.$transaction([
      db.refundRequest.deleteMany({ where: { orderId } }),
      db.stockMovement.deleteMany({ where: { orderId } }),
      db.couponRedemption.deleteMany({ where: { orderId } }),
      db.orderStatusHistory.deleteMany({ where: { orderId } }),
      db.queueItem.deleteMany({ where: { orderId } }),
      db.rewardLedger.deleteMany({ where: { orderId } }),
      db.orderConsent.deleteMany({ where: { orderId } }),
      db.orderShippingAddress.deleteMany({ where: { orderId } }),
      db.shipment.deleteMany({ where: { orderId } }),
      db.orderNotification.deleteMany({ where: { orderId } }),
      db.orderItem.deleteMany({ where: { orderId } }),
      db.order.deleteMany({ where: { id: orderId } }),
    ]);
  } finally {
    await db.$disconnect();
  }
}

// 찜 e2e 준비·정리: 데모 구매자의 찜을 비우고 상품 이름으로 고른 상품을 넣는다(품절 상품도 DB에 바로 넣는다).
export async function resetWishlistInDb(slug: string, loginId: string, productNames: string[]) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const buyer = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, loginId, deletedAt: null } });
    await db.wishItem.deleteMany({ where: { sellerId: seller.id, buyerMemberId: buyer.id } });
    for (const name of productNames) {
      const product = await db.product.findFirstOrThrow({ where: { sellerId: seller.id, name, deletedAt: null } });
      await db.wishItem.create({ data: { sellerId: seller.id, buyerMemberId: buyer.id, productId: product.id } });
    }
  } finally {
    await db.$disconnect();
  }
}

// 상품 상세 e2e: 옵션 재고를 바꾸고 이전 값을 돌려준다(옵션 일부 품절 시험용)
export async function setOptionStockInDb(slug: string, productName: string, optionName: string, stock: number) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const option = await db.productOption.findFirstOrThrow({ where: { sellerId: seller.id, deletedAt: null, name: optionName, product: { name: productName, deletedAt: null } } });
    await db.productOption.update({ where: { id: option.id }, data: { stock } });
    return option.stock;
  } finally {
    await db.$disconnect();
  }
}

// 주문 닉네임 e2e: 주문에 남은 방송 닉네임 스냅숏을 읽는다
export async function orderNicknameInDb(orderId: string) {
  const db = open();
  try {
    return (await db.order.findFirstOrThrow({ where: { id: orderId }, select: { broadcastNicknameSnapshot: true } })).broadcastNicknameSnapshot;
  } finally {
    await db.$disconnect();
  }
}

// 적립금 사용 e2e: 판매자의 적립금 사용 스위치와 구매자 잔액을 정하고, 이전 값을 돌려준다(끝에 restoreRewardUse로 되돌림)
export type RewardSnapshot = { policy: { livePayoutEnabled: boolean } | null; balance: number | null };
export async function setRewardUseInDb(slug: string, loginId: string, enabled: boolean, balance: number): Promise<RewardSnapshot> {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const buyer = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, loginId, deletedAt: null } });
    const prevPolicy = await db.rewardPolicy.findUnique({ where: { sellerId: seller.id }, select: { livePayoutEnabled: true } });
    const prevBalance = await db.rewardBalance.findUnique({ where: { sellerId_buyerMemberId: { sellerId: seller.id, buyerMemberId: buyer.id } }, select: { balance: true } });
    await db.rewardPolicy.upsert({ where: { sellerId: seller.id }, create: { sellerId: seller.id, livePayoutEnabled: enabled }, update: { livePayoutEnabled: enabled } });
    await db.rewardBalance.upsert({
      where: { sellerId_buyerMemberId: { sellerId: seller.id, buyerMemberId: buyer.id } },
      create: { sellerId: seller.id, buyerMemberId: buyer.id, balance },
      update: { balance },
    });
    return { policy: prevPolicy, balance: prevBalance?.balance ?? null };
  } finally {
    await db.$disconnect();
  }
}
export async function restoreRewardUse(slug: string, loginId: string, prev: RewardSnapshot) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const buyer = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, loginId, deletedAt: null } });
    if (prev.policy) await db.rewardPolicy.update({ where: { sellerId: seller.id }, data: { livePayoutEnabled: prev.policy.livePayoutEnabled } });
    else await db.rewardPolicy.deleteMany({ where: { sellerId: seller.id } });
    const key = { sellerId_buyerMemberId: { sellerId: seller.id, buyerMemberId: buyer.id } };
    if (prev.balance === null) await db.rewardBalance.deleteMany({ where: { sellerId: seller.id, buyerMemberId: buyer.id } });
    else await db.rewardBalance.update({ where: key, data: { balance: prev.balance } });
  } finally {
    await db.$disconnect();
  }
}
export async function orderRewardInDb(orderId: string) {
  const db = open();
  try {
    return await db.order.findFirstOrThrow({ where: { id: orderId }, select: { rewardUsedAmount: true, totalAmount: true } });
  } finally {
    await db.$disconnect();
  }
}
export async function rewardBalanceInDb(slug: string, loginId: string) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const buyer = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, loginId, deletedAt: null } });
    return (await db.rewardBalance.findUnique({ where: { sellerId_buyerMemberId: { sellerId: seller.id, buyerMemberId: buyer.id } }, select: { balance: true } }))?.balance ?? 0;
  } finally {
    await db.$disconnect();
  }
}

// 환불(취소) 요청 e2e: 만든 주문을 결제 완료로 바꾸고, 진행 중인 요청을 판매자가 거절한 것처럼 바꾼다
export async function markOrderPaidInDb(orderId: string) {
  const db = open();
  try {
    await db.order.update({ where: { id: orderId }, data: { status: "PAID", paidAt: new Date() } });
  } finally {
    await db.$disconnect();
  }
}
export async function rejectRefundRequestInDb(orderId: string, rejectReason: string) {
  const db = open();
  try {
    await db.refundRequest.updateMany({ where: { orderId, status: "REQUESTED" }, data: { status: "REJECTED", rejectReason, decidedAt: new Date() } });
  } finally {
    await db.$disconnect();
  }
}

// 장바구니 가격 변경 e2e: 옵션 추가금(priceDelta)을 바꾸고 이전 값을 돌려준다(원래 값으로 되돌리는 데 쓴다)
export async function setOptionPriceDeltaInDb(slug: string, productName: string, optionName: string, priceDelta: number) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const option = await db.productOption.findFirstOrThrow({ where: { sellerId: seller.id, deletedAt: null, name: optionName, product: { name: productName, deletedAt: null } } });
    await db.productOption.update({ where: { id: option.id }, data: { priceDelta } });
    return option.priceDelta;
  } finally {
    await db.$disconnect();
  }
}

// 주문 내역 e2e: 만든 주문을 취소한 상태로 바꾼다(다시 담기 버튼 확인용)
export async function markOrderCancelledInDb(orderId: string) {
  const db = open();
  try {
    await db.order.update({ where: { id: orderId }, data: { status: "CANCELLED", cancelledAt: new Date() } });
  } finally {
    await db.$disconnect();
  }
}

// 쇼핑몰 운영 상태(OPEN·PREPARING·PAUSED) 바꾸기. 시험이 끝나면 OPEN으로 되돌린다.
export async function setOperatingState(slug: string, state: "OPEN" | "PREPARING" | "PAUSED") {
  const db = open();
  try {
    await db.seller.update({ where: { slug }, data: { operatingState: state } });
  } finally {
    await db.$disconnect();
  }
}

// 쇼핑몰 이용안내 글(SA-060 shopUsageGuide) 바꾸기. 바꾸기 전 값을 돌려준다.
export async function setUsageGuide(slug: string, text: string | null) {
  const db = open();
  try {
    const prev = await db.seller.findUniqueOrThrow({ where: { slug }, select: { shopUsageGuide: true } });
    await db.seller.update({ where: { slug }, data: { shopUsageGuide: text } });
    return prev.shopUsageGuide;
  } finally {
    await db.$disconnect();
  }
}

// 상품 목록 쪽 이동 시험용: 판매 중 상품 n개를 더하고(이름 「채움상품 NN」, 옵션 1개씩), 끝나면 지운다.
export async function addFillerProducts(slug: string, n: number) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    for (let i = 1; i <= n; i += 1) {
      const p = await db.product.create({ data: { sellerId: seller.id, name: `채움상품 ${String(i).padStart(2, "0")}`, price: 1000 + i, status: "ON_SALE" } });
      await db.productOption.create({ data: { sellerId: seller.id, productId: p.id, name: "기본", stock: 10 } });
    }
  } finally {
    await db.$disconnect();
  }
}
export async function removeFillerProducts(slug: string) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const ids = (await db.product.findMany({ where: { sellerId: seller.id, name: { startsWith: "채움상품 " } }, select: { id: true } })).map((p) => p.id);
    await db.productOption.deleteMany({ where: { sellerId: seller.id, productId: { in: ids } } });
    await db.product.deleteMany({ where: { sellerId: seller.id, id: { in: ids } } });
  } finally {
    await db.$disconnect();
  }
}

// 배송지 e2e 준비: 데모 구매자의 저장 배송지를 지우고 n개(첫째가 기본, 이름 「집」「회사」「부모님 댁」…)를 넣는다. 끝나면 n=0으로 비운다.
export async function resetAddressesInDb(slug: string, loginId: string, n: number) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const buyer = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, loginId, deletedAt: null } });
    await db.buyerAddress.deleteMany({ where: { sellerId: seller.id, buyerMemberId: buyer.id } });
    const labels = ["집", "회사", "부모님 댁"];
    for (let i = 0; i < n; i += 1) {
      await db.buyerAddress.create({
        data: {
          sellerId: seller.id,
          buyerMemberId: buyer.id,
          label: labels[i] ?? `배송지 ${i + 1}`,
          recipientName: i === 2 ? "김은하" : "김별빛",
          phone: "01012345678",
          zipCode: String(6000 + i).padStart(5, "0"),
          address1: `서울 강남구 테스트로 ${i + 1}`,
          address2: i === 0 ? "101동 1001호" : null,
          isDefault: i === 0,
          createdAt: new Date(Date.now() - i * 60_000),
        },
      });
    }
  } finally {
    await db.$disconnect();
  }
}
