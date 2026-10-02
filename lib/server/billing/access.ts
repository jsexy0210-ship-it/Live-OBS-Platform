// 판매자 관리자 이용 가능 여부(대표님 결정 2026-10-02, MASTER 결정 2026-10-03).
// 체험하기(승인 + 3일) 중, 결제한 이용 기간 안, 예약된 결제를 기다리는 중, 자동결제 실패 뒤 유예(7일) 중에는 쓸 수 있다.
// 그 밖에는 구독·결제 화면과 로그아웃만 열린다(오버레이 공개 주소도 막힘).

export type SellerAccess = "trial" | "paid" | "charging" | "grace" | "expired";

// 예약 결제 시각이 지난 뒤에도 예약 실행이 처리할 때까지 끊기지 않게 기다리는 시간
export const CHARGE_WAIT_MS = 24 * 60 * 60 * 1000;

export type AccessInput = {
  trialEndsAt: Date | null;
  subscription: {
    status: string;
    currentPeriodEnd: Date | null;
    nextChargeAt: Date | null;
    graceUntil: Date | null;
    cancelAtPeriodEnd: boolean;
  } | null;
};

export function sellerAccess({ trialEndsAt, subscription: s }: AccessInput, now: Date): SellerAccess {
  // 결제 실패(PAST_DUE)·해지 예약이어도 결제한 기간 끝까지는 쓸 수 있다.
  if (s?.currentPeriodEnd && s.currentPeriodEnd > now) return "paid";
  if (trialEndsAt && trialEndsAt > now) return "trial";
  if (s?.status === "PAST_DUE" && s.graceUntil && s.graceUntil > now) return "grace";
  // 카드를 등록해 두었고 결제 시각이 막 지났으면(예약 실행 대기) 끊지 않는다.
  if (s?.status === "ACTIVE" && !s.cancelAtPeriodEnd && s.nextChargeAt && now.getTime() < s.nextChargeAt.getTime() + CHARGE_WAIT_MS) {
    return "charging";
  }
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
