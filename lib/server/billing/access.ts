// 판매자 관리자 이용 가능 여부(대표님 결정 2026-10-02, MASTER 결정 2026-10-03).
// 체험하기 중, 결제한 이용 기간 안, 예약된 결제를 기다리는 중, 자동결제 실패 뒤 유예(7일) 중에는 쓸 수 있다.
// 그 밖에는 잠금: 새 판매(주문 생성·오버레이·방송 시작·상품 등록·도메인 연결)를 막는다.

export type SellerAccess = "trial" | "paid" | "charging" | "grace" | "expired";

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
  if (s?.status === "PAST_DUE" && !s.cancelAtPeriodEnd && s.graceUntil && s.graceUntil > now) return "grace";
  // 카드를 등록해 두었고 결제 시각이 지났지만 예약 실행이 아직 처리하지 않았으면 열어 둔다.
  // 우리 쪽 지연으로 판매자를 잠그지 않는다(MASTER 결정 2026-10-03, 시간 제한 없음).
  if (s?.status === "ACTIVE" && !s.cancelAtPeriodEnd && s.nextChargeAt && s.nextChargeAt <= now) return "charging";
  return "expired";
}

// 잠기기 시작한 시각(이용 가능했던 마지막 시각). 잠금 30일 뒤 자동 해지 판단에 쓴다.
// 체험하기 끝, 결제한 기간 끝, 유예 끝 중 가장 늦은 시각. 하나도 없으면 null.
export function lockedSince({ trialEndsAt, subscription: s }: AccessInput): Date | null {
  const candidates: (Date | null)[] = [trialEndsAt, s?.currentPeriodEnd ?? null];
  if (s?.status === "PAST_DUE") candidates.push(s.graceUntil);
  return candidates.reduce<Date | null>((a, b) => (b && (!a || b > a) ? b : a), null);
}

// ───────────── 기간 계산 (KST, 기준일 고정) ─────────────

const KST_MS = 9 * 60 * 60 * 1000;

// anchor로부터 k개월 뒤의 같은 KST 날짜·시각. 그 달에 같은 날이 없으면 말일(1/31 → 2/28 → 3/31).
export function addMonthsKst(anchor: Date, k: number): Date {
  const t = new Date(anchor.getTime() + KST_MS);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth() + k;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(t.getUTCDate(), lastDay);
  return new Date(Date.UTC(y, m, day, t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds(), t.getUTCMilliseconds()) - KST_MS);
}

// start 다음에 오는 첫 기준일(anchor + k개월, k ≥ 1). 기간 끝으로 쓴다.
export function nextPeriodEnd(anchor: Date, start: Date): Date {
  let k = 1;
  while (addMonthsKst(anchor, k) <= start) k++;
  return addMonthsKst(anchor, k);
}
