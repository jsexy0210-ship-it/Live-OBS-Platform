import { cleanText } from "../text/clean";

// 회원 등급 규칙(순수 함수, SA-044). 서비스(service.ts)가 DB 쓰기 전에 입력을 검사하고 재산정 대상 등급을 정하는 데 쓴다.
export const GRADE_NAME_MAX = 12;
export const GRADES_MAX = 10;
export const MIN_AMOUNT_MAX = 2_000_000_000;
export const WINDOW_MONTHS = [0, 3, 6, 12] as const; // 0 = 누적
export const CADENCES = ["MONTHLY", "WEEKLY", "DAILY"] as const;
export const DEMOTIONS = ["STEP", "IMMEDIATE", "NONE"] as const;
export const OVERRIDE_REASON_MAX = 100;
export type Cadence = (typeof CADENCES)[number];
export type Demotion = (typeof DEMOTIONS)[number];

export type GradeRejection = "invalid_setting" | "invalid_until" | "invalid_reason" | "invalid_grade_name" | "invalid_min_amount" | "invalid_thresholds" | "too_many_grades" | "duplicate_name" | "base_grade_amount" | "invalid_body";

export const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export const parseGradeName = (v: unknown) => cleanText(v, GRADE_NAME_MAX, "name");
export const parseMinAmount = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MIN_AMOUNT_MAX ? v : null);

// 승급 기준액은 등급 순서대로 엄격히 커야 한다(첫 등급은 0)
export function thresholdsIncrease(amountsBySortOrder: number[]): boolean {
  return amountsBySortOrder.every((a, i) => (i === 0 ? a === 0 : a > amountsBySortOrder[i - 1]));
}

// 재산정 목표 등급의 순번: 최근 6개월 결제 금액이 기준액 이상인 가장 높은 등급(기준액은 순서대로 커진다)
export function targetRank(thresholds: number[], amount: number): number {
  let rank = 0;
  for (let i = 0; i < thresholds.length; i++) if (amount >= thresholds[i]) rank = i;
  return rank;
}

// 다음 순번. 승급은 목표까지 한 번에. 강등은 설정에 따라: STEP 한 단계씩, IMMEDIATE 바로 목표까지, NONE 내리지 않음.
export function nextRank(current: number, target: number, demotion: Demotion = "STEP"): number {
  if (target > current) return target;
  if (target === current) return current;
  return demotion === "STEP" ? current - 1 : demotion === "IMMEDIATE" ? target : current;
}

// 설정 입력 검사
export const parseWindowMonths = (v: unknown): number | null => ((WINDOW_MONTHS as readonly unknown[]).includes(v) ? (v as number) : null);
export const parseCadence = (v: unknown): Cadence | null => ((CADENCES as readonly unknown[]).includes(v) ? (v as Cadence) : null);
export const parseDemotion = (v: unknown): Demotion | null => ((DEMOTIONS as readonly unknown[]).includes(v) ? (v as Demotion) : null);
export const parseOverrideReason = (v: unknown): string | null => cleanText(v, OVERRIDE_REASON_MAX, "memo");

// KST 날짜 계산(서버는 UTC로 돌지만 달·주·일 경계는 KST 0시)
const KST_MS = 9 * 3600_000;
const DAY_MS = 86_400_000;
const kstParts = (now: Date) => {
  const k = new Date(now.getTime() + KST_MS);
  return { y: k.getUTCFullYear(), m: k.getUTCMonth(), d: k.getUTCDate(), dow: (k.getUTCDay() + 6) % 7 }; // dow: 월=0
};
const kstMidnight = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d) - KST_MS);
const p2 = (n: number) => String(n).padStart(2, "0");

export function kstMonthKey(now: Date): string {
  return new Date(now.getTime() + KST_MS).toISOString().slice(0, 7);
}
export function nextMonthStart(now: Date): Date {
  const { y, m } = kstParts(now);
  return kstMidnight(y, m + 1, 1);
}

// ISO 주 키(YYYY-Www, 월요일 시작, KST)
function isoWeekKey(now: Date): string {
  const { y, m, d, dow } = kstParts(now);
  const thursday = new Date(Date.UTC(y, m, d) + (3 - dow) * DAY_MS);
  const wy = thursday.getUTCFullYear();
  const jan1 = Date.UTC(wy, 0, 1);
  return `${wy}-W${p2(Math.floor((thursday.getTime() - jan1) / (7 * DAY_MS)) + 1)}`;
}

// 재산정 실행 키: 같은 키로는 한 번만 돈다(월 YYYY-MM · 주 YYYY-Www · 일 YYYY-MM-DD)
export function runKey(cadence: Cadence, now: Date): string {
  if (cadence === "MONTHLY") return kstMonthKey(now);
  if (cadence === "WEEKLY") return isoWeekKey(now);
  const { y, m, d } = kstParts(now);
  return `${y}-${p2(m + 1)}-${p2(d)}`;
}

// 다음 재산정 시각(KST 0시): 매월 1일 · 매주 월요일 · 매일
export function nextRunAt(cadence: Cadence, now: Date): Date {
  const { y, m, d, dow } = kstParts(now);
  if (cadence === "MONTHLY") return kstMidnight(y, m + 1, 1);
  if (cadence === "WEEKLY") return kstMidnight(y, m, d + (7 - dow));
  return kstMidnight(y, m, d + 1);
}

// 기준 기간 시작: 지금부터 n개월 전(0이면 누적)
export function windowStart(now: Date, months = 6): Date {
  if (months === 0) return new Date(0);
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

// 고정 끝나는 날(YYYY-MM-DD, KST)을 그날 끝(다음 날 0시)으로. 오늘 이전이면 null.
export function parseUntilDate(v: unknown, now: Date): Date | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split("-").map(Number);
  const end = kstMidnight(y, m - 1, d + 1);
  const check = new Date(end.getTime() - 1 + KST_MS);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null; // 없는 날짜
  return end.getTime() > now.getTime() ? end : null;
}
