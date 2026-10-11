export type PublicCompanyInfo = Partial<Record<"name" | "representative" | "businessNumber" | "mailOrderNumber" | "address" | "phone", string | null>>;
const COMPANY_FIELDS = [
  ["상호", "name"],
  ["대표", "representative"],
  ["사업자등록번호", "businessNumber"],
  ["통신판매업 신고", "mailOrderNumber"],
  ["주소", "address"],
  ["고객센터", "phone"],
] as const;

export function publicCompanyParts(companyInfo?: PublicCompanyInfo | null): string[] {
  return COMPANY_FIELDS.flatMap(([label, key]) => {
    const value = companyInfo?.[key]?.trim();
    return value ? [`${label} ${value}`] : [];
  });
}

