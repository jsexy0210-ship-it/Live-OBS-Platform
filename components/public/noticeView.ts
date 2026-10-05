// PF-005·006 공지 표시 값. 분류 이름·색은 마스터 관리자 공지 화면과 같게 둔다.
export type PublicNoticeCategory = "MAINTENANCE" | "POLICY" | "FEATURE" | "GENERAL";
export const PUBLIC_NOTICE_CATEGORY: Record<PublicNoticeCategory, { label: string; cls: string }> = {
  MAINTENANCE: { label: "점검", cls: "b-warn" },
  POLICY: { label: "요금·정책", cls: "b-info" },
  FEATURE: { label: "기능", cls: "b-info" },
  GENERAL: { label: "안내", cls: "b-gray" },
};
const DATE = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" });
export const noticeDate = (d: Date | string) => DATE.format(new Date(d));
