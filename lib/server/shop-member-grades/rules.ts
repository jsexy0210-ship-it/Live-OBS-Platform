import { cleanText } from "../text/clean";

// 회원 등급 규칙(순수 함수, SA-044). 서비스(service.ts)가 DB 쓰기 전에 입력을 검사하고 재산정 대상 등급을 정하는 데 쓴다.
export const GRADE_NAME_MAX = 12;
export const GRADES_MAX = 10;
export const MIN_AMOUNT_MAX = 2_000_000_000;
export const RECALC_MONTHS = 6;

export type GradeRejection = "invalid_grade_name" | "invalid_min_amount" | "invalid_thresholds" | "too_many_grades" | "duplicate_name" | "base_grade_amount" | "invalid_body";

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

// 다음 순번: 승급은 목표까지 한 번에, 강등은 한 단계씩(PRODUCT_SCOPE·IA SA-044)
export function nextRank(current: number, target: number): number {
  return target > current ? target : target < current ? current - 1 : current;
}

// KST 달 키(YYYY-MM)와 다음 달 1일 0시(KST)
const KST_MS = 9 * 3600_000;
export function kstMonthKey(now: Date): string {
  return new Date(now.getTime() + KST_MS).toISOString().slice(0, 7);
}
export function nextMonthStart(now: Date): Date {
  const k = new Date(now.getTime() + KST_MS);
  return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth() + 1, 1) - KST_MS);
}
// 재산정 기준 기간 시작: 지금부터 6개월 전
export function windowStart(now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - RECALC_MONTHS);
  return d;
}
