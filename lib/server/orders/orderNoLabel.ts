// 사람이 읽는 주문번호(디자인 SA-022 「20261002-0409」): 주문 생성일(KST) yyyyMMdd + 「-」 + 판매자별 orderNo를 4자리로 0 채움(9999를 넘으면 자릿수가 늘어난다).
// 주문 식별은 계속 id·orderNo로 하고, 이 문자열은 화면 표시와 검색 입력에만 쓴다.
const KST_MS = 9 * 3_600_000;
const DAY_MS = 86_400_000;
const pad2 = (n: number) => String(n).padStart(2, "0");

export function orderNoLabel(createdAt: Date, orderNo: number): string {
  const d = new Date(createdAt.getTime() + KST_MS);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}-${String(orderNo).padStart(4, "0")}`;
}

// 「20261005-0004」를 읽어 주문번호와 그날(KST) 범위를 준다. 형식이 아니거나 없는 날짜(20261305 등)면 null.
export function parseOrderNoLabel(q: string): { orderNo: number; from: Date; to: Date } | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{1,9})$/.exec(q.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = Date.UTC(y, mo - 1, d);
  const back = new Date(utc);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  const from = new Date(utc - KST_MS);
  return { orderNo: Number(m[4]), from, to: new Date(from.getTime() + DAY_MS) };
}
