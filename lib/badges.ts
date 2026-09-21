export type BadgeTone = "neutral" | "watch" | "danger" | "critical";

export type ResultBadge = {
  fact: string;
  impact: string;
  tone: BadgeTone;
};

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value));
}

export function depletionBadge(remainingPercent: number): ResultBadge {
  const value = clampPercent(remainingPercent);

  if (value < 5) return { fact: "잔량 5% 미만", impact: "한계 구간", tone: "critical" };
  if (value < 10) return { fact: "잔량 10% 미만", impact: "종료 임박", tone: "critical" };
  if (value < 25) return { fact: "잔량 25% 미만", impact: "막판 진입", tone: "danger" };
  if (value < 50) return { fact: "잔량 절반 이하", impact: "중반 소진", tone: "watch" };
  if (value < 75) return { fact: "잔량 50%+", impact: "아직 여유", tone: "neutral" };
  return { fact: "잔량 75%+", impact: "초반 구간", tone: "neutral" };
}

export function commuteBadge(remainingPercent: number): ResultBadge {
  const value = clampPercent(remainingPercent);

  if (value < 5) return { fact: "출근 잔량 5% 미만", impact: "출근 종료 임박", tone: "critical" };
  if (value < 10) return { fact: "출근 잔량 10% 미만", impact: "출근 카운트다운", tone: "critical" };
  if (value < 25) return { fact: "출근 잔량 25% 미만", impact: "퇴직 가시권", tone: "danger" };
  if (value < 50) return { fact: "출근 잔량 절반 이하", impact: "절반 소진", tone: "watch" };
  if (value < 75) return { fact: "출근 잔량 50%+", impact: "출근 중반", tone: "neutral" };
  return { fact: "출근 잔량 75%+", impact: "출근 초반", tone: "neutral" };
}

export function salaryBadge(remainingPercent: number): ResultBadge {
  const value = clampPercent(remainingPercent);

  if (value < 5) return { fact: "급여 잔량 5% 미만", impact: "월급 종료 임박", tone: "critical" };
  if (value < 10) return { fact: "급여 잔량 10% 미만", impact: "마지막 월급권", tone: "critical" };
  if (value < 25) return { fact: "급여 잔량 25% 미만", impact: "월급 막판", tone: "danger" };
  if (value < 50) return { fact: "급여 잔량 절반 이하", impact: "급여 절반 소진", tone: "watch" };
  if (value < 75) return { fact: "급여 잔량 50%+", impact: "급여 중반", tone: "neutral" };
  return { fact: "급여 잔량 75%+", impact: "급여 초반", tone: "neutral" };
}

export function weekendBadge(remainingPercent: number): ResultBadge {
  const value = clampPercent(remainingPercent);

  if (value < 5) return { fact: "주말 잔량 5% 미만", impact: "주말 잔량 바닥", tone: "critical" };
  if (value < 10) return { fact: "주말 잔량 10% 미만", impact: "주말 희소 구간", tone: "critical" };
  if (value < 25) return { fact: "주말 잔량 25% 미만", impact: "주말 막판", tone: "danger" };
  if (value < 50) return { fact: "주말 잔량 절반 이하", impact: "주말 절반 소진", tone: "watch" };
  if (value < 75) return { fact: "주말 잔량 50%+", impact: "주말 중반", tone: "neutral" };
  return { fact: "주말 잔량 75%+", impact: "주말 초반", tone: "neutral" };
}

export function workTimeBadge(totalHours: number): ResultBadge {
  const years = Math.max(0, totalHours) / (24 * 365.2425);

  if (years >= 3) return { fact: "누적 3년+", impact: "회사 인생 대량 소모", tone: "critical" };
  if (years >= 2) return { fact: "누적 2년+", impact: "회사 2년급", tone: "danger" };
  if (years >= 1) return { fact: "누적 1년+", impact: "회사 1년급", tone: "watch" };
  if (years >= 0.5) return { fact: "누적 6개월+", impact: "개월 단위 소모", tone: "neutral" };
  return { fact: "누적 6개월 미만", impact: "시간 누적", tone: "neutral" };
}

export function survivalBadge(months: number): ResultBadge {
  if (!Number.isFinite(months)) {
    return { fact: "순소모 0원 이하", impact: "현금 잔량 유지", tone: "neutral" };
  }
  if (months < 1) return { fact: "생존 1개월 미만", impact: "현금 바닥 임박", tone: "critical" };
  if (months < 3) return { fact: "생존 3개월 미만", impact: "생존 압박", tone: "danger" };
  if (months < 6) return { fact: "생존 6개월 미만", impact: "단기 방어", tone: "watch" };
  if (months < 12) return { fact: "생존 12개월 미만", impact: "완충 구간", tone: "neutral" };
  return { fact: "생존 12개월+", impact: "현금 방어 충분", tone: "neutral" };
}

export function subscriptionBadge(annualSpend: number): ResultBadge {
  if (annualSpend >= 3_000_000) {
    return { fact: "연 300만원+", impact: "구독비 고정비화", tone: "critical" };
  }
  if (annualSpend >= 1_000_000) {
    return { fact: "연 100만원+", impact: "구독 누적", tone: "danger" };
  }
  if (annualSpend >= 500_000) {
    return { fact: "연 50만원+", impact: "정기지출 확대", tone: "watch" };
  }
  return { fact: "연 50만원 미만", impact: "정기지출 구간", tone: "neutral" };
}
