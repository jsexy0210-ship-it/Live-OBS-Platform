// 외부 서비스 업체 비교(MA-087, GET /api/admin/service-vendors). 서버는 키만 내리고 이름은 화면이 붙인다(lib/server/admin/serviceVendors.ts).
export type VendorCategory = "PG" | "SHIPPING" | "TRACKING";
export type Vendor = {
  id: string;
  category: VendorCategory;
  name: string;
  features: string[];
  referenceFee: string | null;
  memo: string | null;
  ratings: Record<string, number>;
  ratedCount: number;
  score: number | null;
  active: boolean;
  logoUrl: string | null;
  recommended: boolean;
  selected: boolean;
};
export type VendorBoard = {
  category: VendorCategory;
  criteria: { key: string; weight: number }[];
  featureKeys: string[];
  recommendedVendorId: string | null;
  selectedVendorId: string | null;
  vendors: Vendor[];
};

export const VENDOR_CATEGORY_LABEL: Record<VendorCategory, string> = { PG: "카드 결제", SHIPPING: "배송·송장", TRACKING: "배송조회" };
export const VENDOR_CATEGORIES: VendorCategory[] = ["PG", "SHIPPING", "TRACKING"];

export const CRITERION_LABEL: Record<string, string> = {
  fee: "수수료",
  setupFee: "초기·고정비",
  recurring: "자동 반복 결제",
  methods: "결제수단",
  api: "연결하기 쉬운 정도",
  stability: "안정성",
  settlement: "정산 받는 주기",
  invoiceIssue: "송장 발급",
  invoicePrint: "송장 출력",
  tracking: "배송 추적",
  carrierCoverage: "택배사 범위",
  returns: "반품 자동 연결",
  cost: "비용",
};
// 배송 분야의 「API」는 「API 품질」로 쓴다(시안)
export const criterionLabel = (cat: VendorCategory, key: string) => (cat !== "PG" && key === "api" ? "API 품질" : CRITERION_LABEL[key] ?? "이름 없는 항목");

export const FEATURE_LABEL: Record<string, string> = {
  card: "카드",
  bankTransfer: "계좌이체",
  virtualAccount: "가상계좌",
  easyPay: "간편결제",
  recurring: "정기결제",
  escrow: "안전결제(에스크로)",
  cashReceipt: "현금영수증",
  invoiceIssue: "송장 발급",
  invoicePrint: "송장 출력",
  tracking: "배송 추적",
  returns: "반품 자동 연결",
  multiCarrier: "여러 택배사",
  apiSandbox: "테스트 기능 있음",
  linkOnly: "조회 링크만 제공",
};
