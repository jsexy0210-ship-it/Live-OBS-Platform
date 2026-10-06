// PF-005·006 공지 표시 값. 분류 이름·색은 마스터 관리자 공지 화면과 같게 둔다.
export type PublicNoticeCategory = "MAINTENANCE" | "POLICY" | "FEATURE" | "GENERAL";
export const PUBLIC_NOTICE_CATEGORY: Record<PublicNoticeCategory, { label: string; cls: string }> = {
  MAINTENANCE: { label: "점검", cls: "b-warn" },
  POLICY: { label: "정책", cls: "b-gray nodot" },
  FEATURE: { label: "새 기능", cls: "b-info nodot" },
  GENERAL: { label: "안내", cls: "b-gray nodot" },
};

export type NoticeListState = { category?: string | null; page?: number; pageSize?: number; cursor?: string | null };
export const noticeListHref = (state: NoticeListState = {}) => {
  const params = new URLSearchParams();
  if (state.category) params.set("category", state.category);
  if (state.cursor) params.set("cursor", state.cursor);
  else {
    if (state.page && state.page > 1) params.set("page", String(state.page));
    if (state.pageSize && state.pageSize !== 5) params.set("pageSize", String(state.pageSize));
  }
  const query = params.toString();
  return query ? `/notices?${query}` : "/notices";
};

export const noticeDetailHref = (id: string, state: NoticeListState = {}) => {
  const listHref = noticeListHref(state);
  const queryAt = listHref.indexOf("?");
  return `/notices/${id}${queryAt < 0 ? "" : listHref.slice(queryAt)}`;
};

export type NoticeNeighbor = { id: string; title: string; category: PublicNoticeCategory; publishedAt: Date | string } | null;
// 정본 PF-005·006: 올해 글은 「10월 2일」, 지난해 이전은 연도를 붙인다
const DATE = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric" });
const DATE_Y = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" });
const YEAR = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", year: "numeric" });
export const noticeDate = (d: Date | string) => {
  const t = new Date(d);
  return YEAR.format(t) === YEAR.format(new Date()) ? DATE.format(t) : DATE_Y.format(t);
};
