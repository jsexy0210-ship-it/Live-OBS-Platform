// 공통 날짜 선택(DatePicker)용 순수 도우미. 값은 모두 「YYYY-MM-DD」 문자열(기존 input type=date와 같은 모양)이라 화면 상태를 바꾸지 않는다.
// 화면 표시는 「2026.10.05」(lib/client/format.ts와 같은 연.월.일). 모든 날짜는 한국 시간(KST) 기준이다.

const pad = (n: number) => String(n).padStart(2, "0");
export const toIso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

// 「2026-10-05」「2026.10.05」「2026/10/5」「20261005」를 읽는다. 실제 있는 날짜가 아니면 null
export function parseDateInput(text: string): string | null {
  const t = text.trim();
  const m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})\.?$/.exec(t) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? toIso(y, mo, d) : null;
}
// 「2026-10-05」 → 「2026.10.05」(잘못된 값은 빈 문자열)
export const formatDateInput = (iso: string): string => (parseDateInput(iso) ?? "").replace(/-/g, ".");

// 한국 시간 오늘(YYYY-MM-DD)
export function todayKst(now: Date = new Date()): string {
  const k = new Date(now.getTime() + 9 * 3600_000);
  return toIso(k.getUTCFullYear(), k.getUTCMonth() + 1, k.getUTCDate());
}
export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return toIso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
// 달 단위 이동: 말일을 넘으면 그 달 말일로(1월 31일 +1달 = 2월 28일)
export function addMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return toIso(first.getUTCFullYear(), first.getUTCMonth() + 1, Math.min(d, last));
}
export function daysBetween(from: string, to: string): number {
  const a = parseDateInput(from);
  const b = parseDateInput(to);
  if (!a || !b) return 0;
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

// 달력 한 달(일요일 시작, 6주 고정). inMonth=false는 이번 달 밖(흐리게)
export type DayCell = { iso: string; day: number; inMonth: boolean };
export function monthGrid(year: number, month: number): DayCell[][] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const start = new Date(Date.UTC(year, month - 1, 1 - first.getUTCDay()));
  const weeks: DayCell[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: DayCell[] = [];
    for (let i = 0; i < 7; i++) {
      const t = new Date(start.getTime() + (w * 7 + i) * 86_400_000);
      row.push({ iso: toIso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()), day: t.getUTCDate(), inMonth: t.getUTCMonth() === month - 1 });
    }
    weeks.push(row);
  }
  return weeks;
}

// 검색 필터 기본 기간 「최근 N개월」(오늘 포함, 시작일은 N개월 전 다음 날): 최근 1개월 = 오늘이 10/05면 09/06 ~ 10/05
export function recentRange(months: number, now: Date = new Date()): { from: string; to: string } {
  const to = todayKst(now);
  return { from: addDays(addMonths(to, -months), 1), to };
}
// 빠른 선택(오늘·7일·1개월·3개월·전체). 전체는 빈 기간
export const QUICK_RANGES = [
  { key: "today", label: "오늘" },
  { key: "7d", label: "7일" },
  { key: "1m", label: "1개월" },
  { key: "3m", label: "3개월" },
  { key: "all", label: "전체" },
] as const;
export type QuickKey = (typeof QUICK_RANGES)[number]["key"];
export function quickRange(key: QuickKey, now: Date = new Date()): { from: string; to: string } {
  const today = todayKst(now);
  if (key === "today") return { from: today, to: today };
  if (key === "7d") return { from: addDays(today, -6), to: today };
  if (key === "1m") return recentRange(1, now);
  if (key === "3m") return recentRange(3, now);
  return { from: "", to: "" };
}
// 지금 기간이 어느 빠른 선택과 같은지(없으면 null)
export function activeQuick(range: { from: string; to: string }, now: Date = new Date()): QuickKey | null {
  for (const q of QUICK_RANGES) {
    const r = quickRange(q.key, now);
    if (r.from === range.from && r.to === range.to) return q.key;
  }
  return null;
}

// 시각 「HH:mm」 입력: 「2225」「22:25」「9:5」를 읽는다. 아니면 null
export function parseTimeInput(text: string): string | null {
  const t = text.trim();
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(t) ?? /^(\d{2})(\d{2})$/.exec(t);
  if (!m) return null;
  const [h, mi] = [Number(m[1]), Number(m[2])];
  return h < 24 && mi < 60 ? `${pad(h)}:${pad(mi)}` : null;
}
