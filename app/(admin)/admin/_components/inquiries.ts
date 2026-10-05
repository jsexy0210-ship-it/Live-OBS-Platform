import { INQUIRY_CATEGORY, INQUIRY_STATUS, type InquiryCategory, type InquiryStatus } from "../../../../components/seller/platformInquiry";

// 파트너스 문의(MA-051·052) 응답과 표시 문구(GET /api/admin/platform-inquiries, …/{id}, …/reply·close). 문구 표는 파트너스 화면(SA-113~115)과 같은 것을 쓴다.
export { INQUIRY_CATEGORY, INQUIRY_STATUS, type InquiryCategory, type InquiryStatus };
export const INQUIRY_TABS: (InquiryStatus | "")[] = ["", "OPEN", "ANSWERED", "CLOSED"];
export const REPLY_MAX = 5000;

export type InquiryRow = {
  id: string;
  sellerId: string;
  shopName: string;
  slug: string;
  authorName: string | null;
  category: InquiryCategory;
  title: string;
  status: InquiryStatus;
  createdAt: string;
  lastMessageAt: string;
  lastAdminMessageAt: string | null;
  closedAt: string | null;
  version: number;
};
export type InquiryMessage = {
  id: string;
  author: "PARTNER" | "PLATFORM";
  authorName: string | null;
  adminId: string | null;
  body: string;
  createdAt: string;
  images: { id: string; width: number; height: number; url: string }[];
};
export type InquiryDetail = InquiryRow & { closedByAdminName: string | null; notice: { id: string; title: string } | null; messages: InquiryMessage[] };
export type InquiryCounts = Record<InquiryStatus, number>;
