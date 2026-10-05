// 구매자 주문 화면 공통 표기. 옵션이 기본이면 수량만 쓴다.
export function qtyText(optionName: string, quantity: number): string {
  const opt = optionName.trim();
  return !opt || opt === "기본" ? `${quantity}개` : `옵션: ${opt} · 수량 ${quantity}개`;
}
