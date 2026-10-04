// 파트너스 회원 목록·상세 응답(GET /api/seller/members, …/{id}). name·phone은 개인정보 열람 권한이 있을 때만 온다.
export type MemberStatus = "ACTIVE" | "DORMANT";
export type MemberRow = {
  id: string;
  broadcastNickname: string | null;
  name?: string;
  phone?: string;
  grade: { id: string; displayName: string } | null;
  status: MemberStatus;
  marketingConsent: boolean;
  createdAt: string;
  lastLoginAt: string | null;
};
export type MemberDetail = MemberRow & { orderCount: number; totalPaid: number; rewardBalance: number };

export const MEMBER_STATUS: Record<MemberStatus, { label: string; cls: string }> = {
  ACTIVE: { label: "활동", cls: "b-done" },
  DORMANT: { label: "휴면", cls: "b-gray" },
};

export const memberDay = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso)) : "-";

// 휴대폰 번호 표시(010-1234-5678). 형식이 다르면 받은 그대로
export const phoneText = (p: string) => p.replace(/^(\d{3})(\d{3,4})(\d{4})$/, "$1-$2-$3");
