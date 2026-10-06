// 목록 필터 기본값 정본(대표님 지시 2026-10-06): 기간 최근 1개월 · 상태 전체(빈 값) · 정렬 최신순 · 쪽 크기 20.
// 쓰는 법(화면 세션): const { applied, draft, setDraft, apply, reset } = useListFilters(listDefaults({ q: "", status: "" }));
//   - 주소에는 기본값과 다른 값만 남는다(useUrlState). 기간·정렬·쪽 크기를 바꾸지 않은 목록은 주소가 깨끗하다.
//   - 기간이 필요 없는 화면은 listDefaults({ …extra }, { period: null }), 다른 기본 기간은 { period: 3 }(개월).
//   - 서버에는 from·to(YYYY-MM-DD, KST)·sort("latest"|"oldest")·size 를 그대로 넘긴다. 이름은 화면마다 따로 짓지 않는다.
import { recentRange } from "./dateInput";

export const DEFAULT_SORT = "latest";
export const DEFAULT_PAGE_SIZE = "20";

export function listDefaults<T extends Record<string, string>>(extra: T, opts: { period?: number | null; now?: Date } = {}) {
  const { period = 1, now } = opts;
  const range = period === null ? ({} as { from?: string; to?: string }) : recentRange(period, now);
  return { ...range, sort: DEFAULT_SORT, size: DEFAULT_PAGE_SIZE, ...extra } as { from: string; to: string; sort: string; size: string } & T;
}
