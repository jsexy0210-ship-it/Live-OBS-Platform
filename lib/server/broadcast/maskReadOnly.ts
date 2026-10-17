// 대신 보기(읽기 전용)에서는 방송 응답의 금액(매출·평균 매출·주문 금액·단가·환불액)을 null로 가린다. 대기열 금액 가림과 같은 정책.
type Json = Record<string, unknown>;
const nullKeys = (o: unknown, keys: string[]): void => {
  if (o && typeof o === "object") for (const k of keys) if (k in (o as Json)) (o as Json)[k] = null;
};
export function maskBroadcastSummary<T>(v: T): T {
  nullKeys((v as Json | null)?.summary, ["sales"]);
  return v;
}
export function maskBroadcastHistory<T>(v: T): T {
  const r = v as Json;
  nullKeys(r.monthSummary, ["avgSales"]);
  for (const it of (r.items as Json[] | undefined) ?? []) nullKeys(it.summary, ["sales"]);
  return v;
}
export function maskBroadcastDetail<T>(v: T): T {
  const r = v as Json;
  nullKeys(r.summary, ["sales"]);
  for (const o of (r.orders as Json[] | undefined) ?? []) {
    nullKeys(o, ["totalAmount", "refundAmount"]);
    for (const i of (o.items as Json[] | undefined) ?? []) nullKeys(i, ["unitPrice"]);
  }
  return v;
}
