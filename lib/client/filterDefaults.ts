// 목록 필터 기본값 정본(대표님 지시 2026-10-06): 기간 최근 1개월 · 상태 전체(빈 값) · 정렬 최신순 · 쪽 크기 20.
// 쓰는 법(화면 세션): const { applied, draft, setDraft, apply, reset } = useListFilters(listDefaults({ q: "", status: "" }));
//   - 주소에는 기본값과 다른 값만 남는다(useUrlState). 기간·정렬·쪽 크기를 바꾸지 않은 목록은 주소가 깨끗하다.
//   - 기간이 필요 없는 화면은 listDefaults({ …extra }, { period: null }), 다른 기본 기간은 { period: 3 }(개월).
//   - 서버에는 from·to(YYYY-MM-DD, KST)·sort("latest"|"oldest")·size 를 그대로 넘긴다. 이름은 화면마다 따로 짓지 않는다.
//   - 「전체 기간」(대표님 지시 2026-10-06 MASTER 공통 규칙): 홈 「처리할 일」 같은 업무 큐 링크로 들어올 때는 기간 전체, 일반 진입은 최근 1개월.
//     링크에 `period=all`을 붙인다(`allPeriodHref("/seller/orders", { status: "PAID" })`). useListFilters는 주소 값을 그대로 따르고,
//     화면은 조회할 때 `effectiveRange(applied)`로 from·to를 얻는다(period=all이면 둘 다 빈 값). 사용자가 날짜를 직접 고르면 apply({ ...next, period: "" }).
import { recentRange } from "./dateInput";

export const DEFAULT_SORT = "latest";
export const DEFAULT_PAGE_SIZE = "20";

export const PERIOD_ALL = "all";
export type PeriodFilter = { from?: string; to?: string; period?: string };
// 조회에 쓸 기간. period=all(주소)이면 기간 제한 없음
export function effectiveRange(f: PeriodFilter): { from: string; to: string } {
  return f.period === PERIOD_ALL ? { from: "", to: "" } : { from: f.from ?? "", to: f.to ?? "" };
}
// 업무 큐 링크: 기간 전체 + 필터(빈 값은 뺀다)
export function allPeriodHref(path: string, filters: Record<string, string> = {}): string {
  const q = new URLSearchParams({ period: PERIOD_ALL });
  for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
  return `${path}?${q.toString()}`;
}

export function listDefaults<T extends Record<string, string>>(extra: T, opts: { period?: number | null; now?: Date } = {}) {
  const { period = 1, now } = opts;
  const range = period === null ? ({} as { from?: string; to?: string }) : recentRange(period, now);
  return { ...range, ...(period === null ? {} : { period: "" }), sort: DEFAULT_SORT, size: DEFAULT_PAGE_SIZE, ...extra } as { from: string; to: string; period: string; sort: string; size: string } & T;
}
