import type { SubscriptionPriceNotice } from "@prisma/client";

type Receipt = Pick<SubscriptionPriceNotice, "channel" | "status" | "completedAt" | "deliveryReference">;
// 고지 완료의 필수 채널은 메일과 파트너스 공지 두 개다(대표님 승인 2026-10-16). 알림톡은 연결된 발송 경로가 있을 때만 선택으로 기록하며,
// 있어도 없어도 완료 판정과 30일 시각에 영향을 주지 않는다(발송 경로가 없는 채널을 필수로 두면 고지가 영영 끝나지 않기 때문).
export const REQUIRED_PRICE_NOTICE_CHANNELS = ["MAIL", "PARTNERS_NOTICE"] as const;

// 완료 기록을 읽을 뿐 발송 성공을 만들지 않는다. 공급자 연결 전에는 기록 없음 = 적용 대기다.
export function priceNoticeCompletedAt(changedAt: Date, receipts: Receipt[], observedAt: Date): Date | null {
  const times = REQUIRED_PRICE_NOTICE_CHANNELS.map((channel) => {
    const receipt = receipts.find((r) => r.channel === channel);
    if (!receipt || receipt.status !== "SENT" || !receipt.deliveryReference?.trim() || !receipt.completedAt) return null;
    const time = receipt.completedAt.getTime();
    return time >= changedAt.getTime() && time <= observedAt.getTime() ? time : null;
  });
  if (times.some((time) => time === null)) return null;
  return new Date(Math.max(...(times as number[])));
}
