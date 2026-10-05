import { bizInfoUrl } from "../../lib/server/shop-legal/notice";

// 쇼핑몰 바닥글 법정 표시 행(SA-062 「사업자 정보·고지」에서 파트너스가 입력한 값). 입력한 항목만 행으로 만든다(없으면 줄을 뺌).
// 호스팅 제공자: 플랫폼 운영사 상호가 마스터 관리자 설정으로 정해지기 전까지는 서비스 이름을 쓴다(FEATURE_GAP L-1 「ONQ 표기」).
export const HOSTING_PROVIDER = "ONQ";

export type FootRow = { label: string; value: string; href?: string };
type Notice = { address: string; csPhone: string; csEmail: string; csHours: string; escrowKind: "none" | "escrow" | "insurance"; escrowProvider: string; escrowUrl: string };

const ESCROW_TEXT = { escrow: "에스크로 가입", insurance: "소비자피해보상보험 가입" } as const;

export function noticeRows(businessNumber: string | null, n: Notice): FootRow[] {
  const rows: FootRow[] = [];
  if (n.address) rows.push({ label: "주소", value: n.address });
  const cs = [n.csPhone, n.csHours].filter(Boolean).join(" · ");
  if (cs) rows.push({ label: "고객센터", value: cs });
  if (n.csEmail) rows.push({ label: "이메일", value: n.csEmail });
  const biz = bizInfoUrl(businessNumber);
  if (biz) rows.push({ label: "사업자정보", value: "확인하기", href: biz });
  rows.push({ label: "호스팅 제공", value: HOSTING_PROVIDER });
  if (n.escrowKind !== "none" && n.escrowProvider) {
    rows.push({ label: "구매안전서비스", value: `${ESCROW_TEXT[n.escrowKind]} · ${n.escrowProvider}`, href: n.escrowUrl || undefined });
  }
  return rows;
}
