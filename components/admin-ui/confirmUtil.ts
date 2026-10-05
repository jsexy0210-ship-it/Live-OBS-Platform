// 공통 확인 창(ConfirmDialog)의 순수 도우미. 시험하기 쉽게 화면 부품과 나눈다.

// 금액·이름 다시 입력 비교: 공백·쉼표·「원」을 빼고 비교한다(「24,000원」과 「24000」은 같은 입력)
export function normalizeRetype(s: string): string {
  return s.replace(/[\s,원]/g, "");
}
export function retypeMatches(input: string, expected: string): boolean {
  const e = normalizeRetype(expected);
  return e !== "" && normalizeRetype(input) === e;
}

// 버튼 폭: 같은 폭(--btn-w-md 96), 실행 이름이 길면 두 버튼 모두 120(--btn-w-lg)
export function confirmButtonWidth(cancelLabel: string, confirmLabel: string): "btn-w-md" | "btn-w-lg" {
  return Math.max(cancelLabel.length, confirmLabel.length) > 6 ? "btn-w-lg" : "btn-w-md";
}
