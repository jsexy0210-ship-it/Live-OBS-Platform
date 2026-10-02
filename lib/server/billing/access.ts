// 판매자 관리자 이용 가능 여부(대표님 결정 2026-10-02).
// 무료 이용(승인 + 3일) 중이거나 결제한 이용 기간 안이면 쓸 수 있다. 그 밖에는 구독·결제 화면과 로그아웃만 열린다.

export type SellerAccess = "trial" | "paid" | "expired";

export type AccessInput = {
  trialEndsAt: Date | null;
  subscription: { status: string; currentPeriodEnd: Date | null } | null;
};

export function sellerAccess({ trialEndsAt, subscription }: AccessInput, now: Date): SellerAccess {
  // 결제 실패(PAST_DUE)·해지(CANCELED)는 남은 기간이 있어도 쓰지 못하게 하지 않는다. 기간 끝이 기준이다.
  if (subscription?.currentPeriodEnd && subscription.currentPeriodEnd > now) return "paid";
  if (trialEndsAt && trialEndsAt > now) return "trial";
  return "expired";
}

// 한 달 뒤 같은 시각. 다음 달에 같은 날이 없으면 그 달 마지막 날로 맞춘다(1월 31일 → 2월 28·29일).
export function addOneMonth(d: Date): Date {
  const r = new Date(d);
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + 1);
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r;
}
