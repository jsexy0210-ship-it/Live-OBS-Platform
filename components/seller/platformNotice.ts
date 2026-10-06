// 플랫폼 공지(SA-111·112) 화면 공통 값. API: /api/seller/platform-notices
export type NoticeItem = { id: string; title: string; category: "MAINTENANCE" | "POLICY" | "FEATURE" | "GENERAL"; isPinned: boolean; publishedAt: string; read: boolean };

// 분류 이름은 SA-111 정본(점검 · 기능 · 요금 · 정책 · 안내)을 따른다
export const NOTICE_CATEGORY: Record<NoticeItem["category"], { label: string; cls: string }> = {
  MAINTENANCE: { label: "점검", cls: "b-pending" },
  FEATURE: { label: "기능", cls: "b-info" },
  POLICY: { label: "요금 · 정책", cls: "b-info" },
  GENERAL: { label: "안내", cls: "b-gray nodot" },
};
// 분류 필터 칸(정본: 전체 · 점검 · 기능 · 요금 · 정책). 「안내」는 전체에서만 보인다
export const NOTICE_FILTERS: { key: string; label: string }[] = [
  { key: "", label: "전체" },
  { key: "MAINTENANCE", label: "점검" },
  { key: "FEATURE", label: "기능" },
  { key: "POLICY", label: "요금 · 정책" },
];
