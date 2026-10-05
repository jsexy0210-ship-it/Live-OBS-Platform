// 화면을 옮겨도 남아야 하는 처리 결과 안내 한 줄(예: 상세에서 승인하고 다음 건으로 넘어갈 때). 다음 화면이 열리면 takeFlash로 꺼내 토스트로 보인다.
let message: string | null = null;
export const setFlash = (text: string) => {
  message = text;
};
export const takeFlash = (): string | null => {
  const m = message;
  message = null;
  return m;
};
