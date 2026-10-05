import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// 적립금 쓴 주문 e2e 준비(폐기용 테스트 DB). 쇼핑몰의 적립금 사용을 켜고 구매자에게 잔액을 넣는다.
const open = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });

export async function allowRewardUseInDb(slug: string, loginId: string, balance: number) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const buyer = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, loginId, deletedAt: null } });
    await db.rewardPolicy.upsert({ where: { sellerId: seller.id }, create: { sellerId: seller.id, livePayoutEnabled: true }, update: { livePayoutEnabled: true } });
    await db.rewardBalance.upsert({
      where: { sellerId_buyerMemberId: { sellerId: seller.id, buyerMemberId: buyer.id } },
      create: { sellerId: seller.id, buyerMemberId: buyer.id, balance },
      update: { balance },
    });
  } finally {
    await db.$disconnect();
  }
}

// 무통장 입금 안내에는 파트너스 입금 계좌가 있어야 한다(없으면 bank_account_missing 409). 이미 있으면 그대로 둔다.
export async function ensureBankAccountInDb(slug: string) {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    await db.sellerBankAccount.upsert({
      where: { sellerId: seller.id },
      create: { sellerId: seller.id, bankName: "시험은행", accountNumber: "123-456-789012", accountHolder: "별빛" },
      update: {},
    });
  } finally {
    await db.$disconnect();
  }
}

export async function rewardBalanceInDb(slug: string, loginId: string): Promise<number> {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const buyer = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, loginId, deletedAt: null } });
    return (await db.rewardBalance.findUnique({ where: { sellerId_buyerMemberId: { sellerId: seller.id, buyerMemberId: buyer.id } } }))?.balance ?? 0;
  } finally {
    await db.$disconnect();
  }
}

export async function liveVersionInDb(slug: string): Promise<number> {
  const db = open();
  try {
    return (await db.seller.findUniqueOrThrow({ where: { slug }, select: { liveVersion: true } })).liveVersion;
  } finally {
    await db.$disconnect();
  }
}

// 이 시험이 만든 주문과 딸린 행(결제·주문대기·재고 이동·적립금 원장 포함)을 지운다. 환불까지 간 주문도 지울 수 있다.
export async function deleteOrderInDb(orderId: string) {
  const db = open();
  try {
    const where = { orderId };
    await db.$transaction([
      db.paymentCancel.deleteMany({ where: { payment: { orderId } } }),
      db.orderRefund.deleteMany({ where }),
      db.payment.deleteMany({ where }),
      db.queueItemStatusHistory.deleteMany({ where: { queueItem: { orderId } } }),
      db.hitCard.deleteMany({ where: { queueItem: { orderId } } }),
      db.queueItem.deleteMany({ where }),
      db.stockMovement.deleteMany({ where }),
      db.couponRedemption.deleteMany({ where }),
      db.orderStatusHistory.deleteMany({ where }),
      db.rewardLedger.deleteMany({ where }),
      db.orderConsent.deleteMany({ where }),
      db.orderShippingAddress.deleteMany({ where }),
      db.shipment.deleteMany({ where }),
      db.orderNotification.deleteMany({ where }),
      db.orderItem.deleteMany({ where }),
      db.order.deleteMany({ where: { id: orderId } }),
    ]);
  } finally {
    await db.$disconnect();
  }
}

// 주문의 상품(이름이 맞는 품목)을 개봉한 것으로 만든다: 주문대기를 「완료」로, 개봉 시작 시각을 채운다(개봉 확인 시험용).
export async function markItemOpenedInDb(orderId: string, productName: string) {
  const db = open();
  try {
    const item = await db.orderItem.findFirstOrThrow({ where: { orderId, productNameSnapshot: productName } });
    await db.queueItem.updateMany({ where: { orderItemId: item.id }, data: { status: "DONE", openingStartedAt: new Date(), doneAt: new Date() } });
  } finally {
    await db.$disconnect();
  }
}

// 환불 e2e가 앞선 시험이 남긴 주문(개봉·무통장 등)에 좌우되지 않게, 발송 전·개봉 전·환불 이력 없는 결제 완료 주문 중 최근 건을 결제 수단별로 고른다.
export async function refundableOrderIdInDb(slug: string, paymentMethod: "CARD" | "BANK_TRANSFER"): Promise<string> {
  const db = open();
  try {
    const seller = await db.seller.findUniqueOrThrow({ where: { slug } });
    const order = await db.order.findFirstOrThrow({
      where: { sellerId: seller.id, status: "PAID", paymentMethod, shipment: null, refunds: { none: {} }, refundRequests: { none: { status: "REQUESTED" } }, queueItems: { none: { openingStartedAt: { not: null } } } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return order.id;
  } finally {
    await db.$disconnect();
  }
}

// 구매자 환불 요청을 DB에 바로 만든다(SA-023 환불 요청 처리 시험). 구매자 쪽 화면·API는 따로 시험하고, 여기서는 파트너스 처리만 본다.
export async function createRefundRequestInDb(orderId: string, reason: "CHANGE_OF_MIND" | "OTHER", reasonText = ""): Promise<{ id: string; orderNo: number }> {
  const db = open();
  try {
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { sellerId: true, buyerMemberId: true, orderNo: true } });
    const r = await db.refundRequest.create({ data: { sellerId: order.sellerId, orderId, buyerMemberId: order.buyerMemberId, reason, reasonText }, select: { id: true } });
    return { id: r.id, orderNo: order.orderNo };
  } finally {
    await db.$disconnect();
  }
}

export async function refundRequestInDb(id: string) {
  const db = open();
  try {
    const r = await db.refundRequest.findUniqueOrThrow({ where: { id }, select: { status: true, rejectReason: true, order: { select: { status: true } } } });
    return { status: r.status, rejectReason: r.rejectReason, orderStatus: r.order.status };
  } finally {
    await db.$disconnect();
  }
}

export async function deleteRefundRequestInDb(id: string) {
  const db = open();
  try {
    await db.refundRequest.deleteMany({ where: { id } });
  } finally {
    await db.$disconnect();
  }
}
