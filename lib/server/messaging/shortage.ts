import type { MessageChannel, MessageShortageReason, Prisma, PrismaClient } from "@prisma/client";

// 충전금 부족·충전 기능 꺼짐으로 건너뛴 일을 남기고 풀어 준다(파트너스 알림 센터 「충전금」 알림, docs/COST_POLICY.md).
// - 같은 판매자·채널·사유는 열린 행 1개로 합쳐 건수·마지막 시각만 올린다(부분 유니크 + ON CONFLICT, 동시에 불러도 한 행). 같은 사건 키(eventKey)를 다시 보내면 아무것도 바꾸지 않는다(멱등).
// - 충전이 성공하면 그 판매자의 잔액 부족 기록을, 같은 채널 차감이 다시 성공하면 그 채널의 기록을 해소한다(resolvedAt). 해소된 알림은 목록에서 사라진다.
// - 기록만 한다: 주문 처리·발송 판단에는 쓰지 않고, 기록이 실패해도 건너뛴 일 자체는 그대로다(부르는 쪽이 같은 트랜잭션이면 함께 롤백).
type Db = PrismaClient | Prisma.TransactionClient;

export async function recordMessageShortage(db: Db, input: { sellerId: string; channel: MessageChannel; reason: MessageShortageReason; eventKey?: string; now?: Date }) {
  const now = input.now ?? new Date();
  const key = input.eventKey ? input.eventKey.slice(0, 200) : null;
  await db.$executeRaw`
    INSERT INTO "MessageShortage" ("sellerId", "channel", "reason", "count", "firstAt", "lastAt", "lastEventKey")
    VALUES (${input.sellerId}::uuid, ${input.channel}::"MessageChannel", ${input.reason}::"MessageShortageReason", 1, ${now}, ${now}, ${key})
    ON CONFLICT ("sellerId", "channel", "reason") WHERE "resolvedAt" IS NULL
    DO UPDATE SET "count" = "MessageShortage"."count" + 1, "lastAt" = GREATEST("MessageShortage"."lastAt", EXCLUDED."lastAt"), "lastEventKey" = EXCLUDED."lastEventKey"
    WHERE EXCLUDED."lastEventKey" IS NULL OR "MessageShortage"."lastEventKey" IS DISTINCT FROM EXCLUDED."lastEventKey"`;
}

// 열린 기록을 해소한다. channel·reasons를 주면 그 범위만. 해소한 행 수를 돌려준다.
export async function resolveMessageShortages(db: Db, input: { sellerId: string; channels?: readonly MessageChannel[]; reasons?: readonly MessageShortageReason[]; now?: Date }) {
  const now = input.now ?? new Date();
  const r = await db.messageShortage.updateMany({
    where: {
      sellerId: input.sellerId,
      resolvedAt: null,
      ...(input.channels ? { channel: { in: [...input.channels] } } : {}),
      ...(input.reasons ? { reason: { in: [...input.reasons] } } : {}),
    },
    data: { resolvedAt: now },
  });
  return r.count;
}

// 알림 문구(파트너스 관리자, 합니다체). 목적격 조사까지 붙여 둔다.
const WHAT: Record<MessageChannel, string> = {
  MAIL_TRANSACTIONAL: "메일 발송을",
  MAIL_BULK: "메일 발송을",
  SMS: "문자 발송을",
  LMS: "문자 발송을",
  ALIMTALK: "알림톡 발송을",
  IDENTITY_VERIFICATION: "구매자 본인확인을",
  DELIVERY_TRACKING: "배송 자동조회를",
  INVOICE_ISSUE: "송장 발급을",
  INVOICE_LABEL: "송장 라벨 발급을",
  CASH_RECEIPT: "현금영수증 발행을",
  TAX_INVOICE: "전자세금계산서 발행을",
};

export function shortageTitle(channel: MessageChannel, reason: MessageShortageReason) {
  return reason === "INSUFFICIENT_BALANCE" ? `충전금이 부족해 ${WHAT[channel]} 건너뛰었습니다` : `지금은 충전금 기능을 쓸 수 없어 ${WHAT[channel]} 건너뛰었습니다`;
}
