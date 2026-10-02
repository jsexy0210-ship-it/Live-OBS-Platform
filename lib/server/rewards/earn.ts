import type { PaymentMethod } from "@prisma/client";

// 적립금 지급액 계산(ARCHITECTURE 4.7). rates: { [등급 id]: { card: 퍼센트, bankTransfer: 퍼센트 } }
// 지급 시작 시각 전이거나 정책·적립률이 없으면 0. 원 단위 내림.
export type RewardRates = Record<string, { card?: number; bankTransfer?: number }>;

export function earnAmount(input: {
  rates: unknown;
  earnStartsAt: Date | null;
  gradeId: string;
  paymentMethod: PaymentMethod | null;
  base: number;
  now: Date;
}): number {
  if (input.earnStartsAt && input.earnStartsAt > input.now) return 0;
  if (!input.paymentMethod || input.base <= 0) return 0;
  const rates = (input.rates && typeof input.rates === "object" ? input.rates : {}) as RewardRates;
  const rate = input.paymentMethod === "CARD" ? rates[input.gradeId]?.card : rates[input.gradeId]?.bankTransfer;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || rate > 100) return 0;
  return Math.floor((input.base * rate) / 100);
}
