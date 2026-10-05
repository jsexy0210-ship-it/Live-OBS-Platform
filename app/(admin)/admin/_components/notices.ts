// 플랫폼 공지 응답과 표시 문구(GET·POST·PUT·DELETE /api/admin/platform-notices, MA-053·054)
export type NoticeCategory = "MAINTENANCE" | "POLICY" | "FEATURE" | "GENERAL";
export type NoticeAudience = "PARTNERS" | "PUBLIC" | "ALL";
export type NoticeStatus = "draft" | "published";
export type Notice = {
  id: string;
  title: string;
  body: string;
  category: NoticeCategory;
  audience: NoticeAudience;
  isPinned: boolean;
  status: NoticeStatus;
  publishedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};
export const NOTICE_TITLE_MAX = 100;
export const NOTICE_BODY_MAX = 10_000;
export const NOTICE_CATEGORY: Record<NoticeCategory, { label: string; cls: string }> = {
  MAINTENANCE: { label: "점검", cls: "b-warn" },
  POLICY: { label: "요금·정책", cls: "b-info" },
  FEATURE: { label: "기능", cls: "b-info" },
  GENERAL: { label: "안내", cls: "b-gray" },
};
export const NOTICE_AUDIENCE: Record<NoticeAudience, string> = { PARTNERS: "파트너스", PUBLIC: "공개", ALL: "파트너스·공개" };
export const NOTICE_STATUS: Record<NoticeStatus, { label: string; cls: string }> = {
  published: { label: "게시 중", cls: "b-done" },
  draft: { label: "임시 저장", cls: "b-gray" },
};
