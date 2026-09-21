export type BadgeTone = "neutral" | "watch" | "danger" | "critical";

export type ResultBadge = {
  fact: string;
  impact: string;
  tone: BadgeTone;
};

export function depletionBadge(remainingPercent: number): ResultBadge {
  const value = Math.max(0, Math.min(100, remainingPercent));

  if (value < 5) return { fact: "잔량 5% 미만", impact: "한계 구간", tone: "critical" };
  if (value < 10) return { fact: "잔량 10% 미만", impact: "종료 임박", tone: "critical" };
  if (value < 25) return { fact: "잔량 25% 미만", impact: "막판 진입", tone: "danger" };
  if (value < 50) return { fact: "잔량 절반 이하", impact: "중반 소진", tone: "watch" };
  if (value < 75) return { fact: "잔량 50%+", impact: "아직 여유", tone: "neutral" };
  return { fact: "잔량 75%+", impact: "초반 구간", tone: "neutral" };
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
