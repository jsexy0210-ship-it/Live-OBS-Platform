// 통계 기간 해석. 화면은 KST 날짜(YYYY-MM-DD)로 시작·끝(포함)을 보내고, 서버는 KST 0시 경계의 [start, end) 시각으로 바꾼다.
// 비교 기간은 바로 앞의 같은 일수다(예: 10/1~10/7 → 9/24~9/30).
// 큰 기간은 DB 집계라도 부담이 커서 최대 366일(1년)로 막는다.

export const STATS_MAX_DAYS = 366;
export const STATS_UNITS = ["day", "week", "month"] as const;
export type StatsUnit = (typeof STATS_UNITS)[number];

export type StatsRange = {
  from: string;
  to: string;
  days: number;
  unit: StatsUnit;
  start: Date;
  end: Date;
  prev: { from: string; to: string; start: Date; end: Date };
};

const KST_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const KST_MS = 9 * 3600_000;

// KST 날짜의 0시(UTC 시각). 없는 날짜(2월 30일 등)면 null.
function kstDayStart(s: string): Date | null {
  const m = KST_DATE.exec(s);
  if (!m) return null;
  const d = new Date(`${s}T00:00:00+09:00`);
  if (Number.isNaN(d.getTime())) return null;
  const back = new Date(d.getTime() + KST_MS);
  if (back.getUTCFullYear() !== Number(m[1]) || back.getUTCMonth() + 1 !== Number(m[2]) || back.getUTCDate() !== Number(m[3])) return null;
  return d;
}

// UTC 시각 → 그 시각의 KST 날짜(YYYY-MM-DD)
export function kstDate(d: Date): string {
  return new Date(d.getTime() + KST_MS).toISOString().slice(0, 10);
}

export function parseStatsRange(q: { from?: string | null; to?: string | null; unit?: string | null }): StatsRange | null {
  if (!q.from || !q.to) return null;
  const start = kstDayStart(q.from);
  const toStart = kstDayStart(q.to);
  if (!start || !toStart || toStart < start) return null;
  const days = Math.round((toStart.getTime() - start.getTime()) / DAY_MS) + 1;
  if (days > STATS_MAX_DAYS) return null;
  const unit = (q.unit ?? "day") as StatsUnit;
  if (!STATS_UNITS.includes(unit)) return null;
  const end = new Date(toStart.getTime() + DAY_MS);
  const prevStart = new Date(start.getTime() - days * DAY_MS);
  return {
    from: q.from,
    to: q.to,
    days,
    unit,
    start,
    end,
    prev: { from: kstDate(prevStart), to: kstDate(new Date(start.getTime() - DAY_MS)), start: prevStart, end: start },
  };
}

// 비율(소수 넷째 자리). 분모가 0이면 null(화면은 「—」).
export const ratio = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10_000) / 10_000 : null);

// 홈의 「어제 같은 시각 대비」. 일반 통계의 완료된 날짜 범위는 그대로 두고 오늘 하루 요청에만 적용한다.
export function elapsedDayRange(range: StatsRange, at: Date): StatsRange | null {
  if (range.days !== 1 || range.from !== kstDate(at)) return null;
  return { ...range, end: at, prev: { ...range.prev, end: new Date(at.getTime() - DAY_MS) } };
}
