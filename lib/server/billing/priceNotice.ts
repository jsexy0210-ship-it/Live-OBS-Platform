import type { SubscriptionPriceNotice } from "@prisma/client";

type Receipt = Pick<SubscriptionPriceNotice, "channel" | "status" | "completedAt" | "deliveryReference">;
const CHANNELS = ["MAIL", "ALIMTALK", "PARTNERS_NOTICE"] as const;

// 완료 기록을 읽을 뿐 발송 성공을 만들지 않는다. 공급자 연결 전에는 기록 없음 = 적용 대기다.
export function priceNoticeCompletedAt(changedAt: Date, receipts: Receipt[], observedAt: Date): Date | null {
  const times = CHANNELS.map((channel) => {
    const receipt = receipts.find((r) => r.channel === channel);
    if (!receipt || receipt.status !== "SENT" || !receipt.deliveryReference?.trim() || !receipt.completedAt) return null;
    const time = receipt.completedAt.getTime();
    return time >= changedAt.getTime() && time <= observedAt.getTime() ? time : null;
  });
  if (times.some((time) => time === null)) return null;
  return new Date(Math.max(...(times as number[])));
}
