// 플랫폼 공지(SA-111·112) 화면 공통 값. API: /api/seller/platform-notices
export type NoticeItem = { id: string; title: string; category: "MAINTENANCE" | "POLICY" | "FEATURE" | "GENERAL"; isPinned: boolean; publishedAt: string };

export const NOTICE_CATEGORY: Record<NoticeItem["category"], { label: string; cls: string }> = {
  MAINTENANCE: { label: "점검", cls: "b-pending" },
  POLICY: { label: "정책", cls: "b-info" },
  FEATURE: { label: "기능", cls: "b-done" },
  GENERAL: { label: "일반", cls: "b-gray nodot" },
};
