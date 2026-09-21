/** 천 단위 콤마 */
export function formatNumber(value: number, maximumFractionDigits = 0) {
  if (!Number.isFinite(value)) return "-";
  return value.toLocaleString("ko-KR", { maximumFractionDigits });
}

/** 원화 표기: 100만원 이상은 만원 단위 절사, 미만은 원 단위 */
export function formatWon(value: number) {
  if (!Number.isFinite(value)) return "-";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}${formatNumber(Math.floor(abs / 10_000))}만원`;
  return `${sign}${formatNumber(Math.round(abs))}원`;
}

/** 입력 문자열에서 숫자만 추출 */
export function parseDigits(text: string) {
  const digits = text.replace(/[^\d]/g, "");
  return digits === "" ? 0 : Number(digits);
}

/** 정수 범위 옵션 */
export function range(from: number, to: number, step = 1) {
  const out: number[] = [];
  const dir = from <= to ? 1 : -1;
  for (let value = from; dir > 0 ? value <= to + 1e-9 : value >= to - 1e-9; value += step * dir) {
    out.push(Math.round(value * 100) / 100);
  }
  return out;
}
