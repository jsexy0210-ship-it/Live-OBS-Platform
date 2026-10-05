// 공통 확인 창(ConfirmDialog)의 순수 도우미. 시험하기 쉽게 화면 부품과 나눈다.

// 다시 입력 비교. 금액(amount)은 공백·쉼표·「원」을 빼고(「24,000원」=「24000」), 이름(text)은 공백만 뺀다(「박원」과 「박」은 다르다)
export type RetypeMode = "amount" | "text";
export function normalizeRetype(s: string, mode: RetypeMode = "amount"): string {
  return mode === "amount" ? s.replace(/[\s,원]/g, "") : s.replace(/\s/g, "");
}
export function retypeMatches(input: string, expected: string, mode: RetypeMode = "amount"): boolean {
  const e = normalizeRetype(expected, mode);
  return e !== "" && normalizeRetype(input, mode) === e;
}

// 버튼 폭: 같은 폭(--btn-w-md 96), 실행 이름이 길면 두 버튼 모두 120(--btn-w-lg)
export function confirmButtonWidth(cancelLabel: string, confirmLabel: string): "btn-w-md" | "btn-w-lg" {
  return Math.max(cancelLabel.length, confirmLabel.length) > 6 ? "btn-w-lg" : "btn-w-md";
}
