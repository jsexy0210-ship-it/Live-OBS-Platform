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

// ───────────── 구독 판정(순수 함수: 서버 처리와 파트너스 화면이 같은 기준을 쓴다) ─────────────

type EndState = { status: string; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean };

// 해지된 구독인지: CANCELED이거나, 해지 예약한 기간이 이미 끝남(예약 실행이 아직 CANCELED로 바꾸기 전).
export function isEndedSubscription(sub: EndState | null, now: Date): boolean {
  if (!sub) return true;
  return sub.status === "CANCELED" || (sub.cancelAtPeriodEnd && !!sub.currentPeriodEnd && sub.currentPeriodEnd <= now);
}

// 해지할 수 있는지(cancelSubscription과 같은 기준). 결제 진행 중(PENDING 청구)인지는 따로 본다.
export function canCancelSubscription(sub: { status: string; cancelAtPeriodEnd: boolean } | null): boolean {
  return !!sub && sub.status !== "CANCELED" && !sub.cancelAtPeriodEnd;
}

// 해지를 예약해 두고 아직 이용 중인 구독인지. 이때는 플랜을 바꿀 수 없다(바꿔도 해지로 끝나 적용되지 않음).
// 카드를 다시 등록하면 해지 예약이 풀린다(registerCardAndPay).
export function isCancelScheduled(sub: EndState | null, now: Date): boolean {
  return !!sub && sub.cancelAtPeriodEnd && !isEndedSubscription(sub, now);
}

// 카드를 등록(교체)하면 바로 결제하는지(registerCardAndPay와 같은 기준).
// 결제한 기간이 남았거나, 결제 실패가 아닌 체험 중이면 카드만 등록한다. 그 밖(잠김·결제 실패·첫 결제 전)은 바로 결제한다.
export function cardRegistrationCharges(trialEndsAt: Date | null, sub: { status: string; currentPeriodEnd: Date | null } | null, now: Date): boolean {
  const inTrial = !!trialEndsAt && trialEndsAt > now;
  const paidActive = sub?.status === "ACTIVE" && !!sub.currentPeriodEnd && sub.currentPeriodEnd > now;
  return !(paidActive || (inTrial && sub?.status !== "PAST_DUE"));
}

// 플랜 변경 때의 결제 상태(changePlan과 같은 기준).
// paidActive: 결제한 기간 중 · pastDue: 끝나지 않은 결제 실패 구독(유예가 끝났어도) · inTrial: 결제한 기간 없이 체험 중
export function planChangeState(
  trialEndsAt: Date | null,
  sub: (EndState & { currentPeriodStart: Date | null }) | null,
  now: Date,
): { paidActive: boolean; pastDue: boolean; inTrial: boolean } {
  const active = !!sub && !isEndedSubscription(sub, now);
  const paidActive = active && sub!.status === "ACTIVE" && !!sub!.currentPeriodEnd && sub!.currentPeriodEnd > now && !!sub!.currentPeriodStart;
  const pastDue = active && sub!.status === "PAST_DUE";
  const inTrial = !!trialEndsAt && trialEndsAt > now && !paidActive;
  return { paidActive, pastDue, inTrial };
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

// 계정의 첫 런칭가 결제 성공부터 KST 달력 3개월. 미사용 계정은 첫 결제 전까지 혜택이 만료되지 않는다.
export function launchDiscountEndsAt(usedAt: Date | null): Date | null {
  return usedAt ? addMonthsKst(usedAt, 3) : null;
}

export function launchDiscountEligible(usedAt: Date | null, at: Date): boolean {
  const endsAt = launchDiscountEndsAt(usedAt);
  return !endsAt || at < endsAt;
}
