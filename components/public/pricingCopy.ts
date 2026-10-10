export type PricingStatus = "available" | "unavailable" | "error";

export function pricingIntro(names: string[], status: PricingStatus) {
  if (names.length === 0) {
    return status === "error" ? "요금 정보를 불러오지 못했어요" : "지금 가입할 수 있는 이용권이 없어요";
  }
  return (names.length === 2 ? "두 가지 이용권 · " : "이용권 · ") + names.join("과 ") + " 중에 골라요";
}
