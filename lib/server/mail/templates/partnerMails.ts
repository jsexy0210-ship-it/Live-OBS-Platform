import { type Block, type MailBody, dateOnly, renderMail, won } from "./layout";

// 파트너스(판매자) 가입 안내 메일 2종(디자인 EM-101 가입 승인 · EM-102 가입 반려·보완 요청). 해요체. 헤더는 ONQ 파트너스 고정(쇼핑몰 색 아님).
// 플랫폼 사업자 정보(바닥글)는 부르는 쪽이 넘긴다(저장 위치가 정해지면 한 곳에서 읽는다 — 아직 없음).
export type PlatformInfo = { name: string; representative: string; businessNumber: string; address: string; phone: string; url: string };

const BRAND_COLOR = "#5b3df6";
const brandOf = (p: PlatformInfo) => ({ name: "ONQ 파트너스", mark: "ONQ", color: BRAND_COLOR, site: p.url });
const footerOf = (p: PlatformInfo) => ({
  title: "ONQ",
  lines: [`상호 ${p.name} · 대표 ${p.representative} · 사업자등록번호 ${p.businessNumber} · ${p.address} · 고객센터 ${p.phone}`, "이 메일은 발신 전용이에요 · 문의는 파트너스 관리자 「공지 · 문의」로 남겨 주세요"],
});
const make = (p: PlatformInfo, subject: string, blocks: Block[]): MailBody => renderMail({ subject: `[ONQ] ${subject}`, brand: brandOf(p), blocks, footer: footerOf(p) });

const STEPS = "시작하기 네 단계(쇼핑몰 정보 → PG 연결 → 첫 상품 → 방송 화면 주소)";

// ─── EM-101 가입 승인 ───
export type PartnerApprovedInput = {
  platform: PlatformInfo;
  representative: string;
  shopName: string;
  shopUrl: string; // 쇼핑몰 주소 표기
  adminUrl: string; // 파트너스 관리자 주소(로그인 화면)
  loginEmail: string;
} & (
  | { plan: "TRIAL"; trialDays: number; trialEndsAt: Date } // 체험 있음
  | { plan: "INTEGRATED"; launchMonthly: number; regularMonthly: number } // 쇼핑몰 통합: 체험 없음, 구독 결제로 시작
);

export function partnerApprovedMail(i: PartnerApprovedInput): MailBody {
  const trial = i.plan === "TRIAL";
  return make(i.platform, "가입이 승인됐어요", [
    { t: "h1", text: "가입이 승인됐어요" },
    { t: "p", text: `${i.representative}님, ${i.shopName}의 파트너스 가입이 승인됐어요. ${trial ? "아래 주소에서 로그인해 시작해 주세요." : "쇼핑몰 통합은 체험 없이 구독 결제로 시작해요."}` },
    {
      t: "box",
      accent: true,
      rows: [["관리자 주소", i.adminUrl], ["로그인 이메일", i.loginEmail], ["비밀번호", "가입 신청 때 정한 비밀번호예요"]],
      muted: "비밀번호를 잊었다면 로그인 화면의 「비밀번호를 잊었어요」에서 휴대폰 본인확인으로 찾을 수 있어요",
    },
    i.plan === "TRIAL"
      ? { t: "box", accent: true, title: `오늘부터 ${i.trialDays}일 동안 체험해 보세요`, lines: [`${dateOnly(i.trialEndsAt)}까지 체험할 수 있어요 · 그 뒤에는 구독을 결제해야 계속 쓸 수 있어요`] }
      : { t: "box", accent: true, title: "구독을 시작하면 바로 스토어가 열려요", lines: [`관리자 주소에서 로그인한 뒤 「구독 · 결제」에서 카드를 등록해 주세요. 런칭 할인가 월 ${won(i.launchMonthly)}(부가세 포함) · 정가 ${won(i.regularMonthly)} · 할인이 끝나는 날짜는 30일 전에 알려 드려요.`] },
    {
      t: "box",
      title: "다음 할 일",
      lines: trial
        ? ["1. 관리자 주소에서 로그인해요", `2. ${STEPS}를 따라 준비해요`, "3. 체험 기간 안에 구독을 시작하면 끊기지 않아요"]
        : ["1. 관리자 주소에서 로그인해요", "2. 구독을 시작해요", `3. ${STEPS}를 따라 준비해요`],
    },
    { t: "p", text: `쇼핑몰 주소는 ${i.shopUrl}예요. 구매자에게는 첫 상품을 올린 뒤에 보여요.`, muted: true },
    { t: "buttons", buttons: [{ label: "파트너스 관리자로 가기", url: i.adminUrl.startsWith("http") ? i.adminUrl : `https://${i.adminUrl}` }] },
  ]);
}

// ─── EM-102 가입 반려 · 보완 요청 ───
export type PartnerRejectedInput = {
  platform: PlatformInfo;
  representative: string;
  shopName: string;
  statusUrl: string; // 신청 상태 화면
} & (
  | { kind: "REJECTED"; reason: string; note?: string | null; reapplyUrl: string }
  | { kind: "SUPPLEMENT"; reason: string; daysLeft: number } // 보완 요청(반려 전)
);

export function partnerRejectedMail(i: PartnerRejectedInput): MailBody {
  if (i.kind === "SUPPLEMENT") {
    return make(i.platform, "서류를 보완해 주세요", [
      { t: "h1", text: "서류를 보완해 주세요" },
      { t: "p", text: `${i.representative}님, ${i.shopName}의 가입 신청에 보완이 필요해요.` },
      { t: "box", accent: true, title: "보완할 내용", lines: [i.reason], muted: `${Math.max(1, Math.round(i.daysLeft))}일 안에 올리지 않으면 신청이 취소돼요` },
      { t: "p", text: "궁금한 점은 답장 대신 신청 상태 화면의 「문의하기」로 남겨 주세요.", muted: true },
      { t: "buttons", buttons: [{ label: "신청 상태 보기", url: i.statusUrl }] },
    ]);
  }
  return make(i.platform, "가입 신청을 승인하지 못했어요", [
    { t: "h1", text: "가입 신청을 승인하지 못했어요" },
    { t: "p", text: `${i.representative}님, ${i.shopName}의 가입 신청을 확인했지만 이번에는 승인하지 못했어요.` },
    { t: "box", accent: true, title: "승인하지 못한 이유", lines: [i.reason, ...(i.note ? [`담당자 메모: ${i.note}`] : [])] },
    { t: "p", text: "다시 신청하려면 위 이유를 고친 뒤 아래 버튼으로 다시 신청해 주세요. 앞서 적은 내용은 그대로 불러와요." },
    { t: "p", text: "궁금한 점은 답장 대신 신청 상태 화면의 「문의하기」로 남겨 주세요.", muted: true },
    { t: "buttons", buttons: [{ label: "고쳐서 다시 신청하기", url: i.reapplyUrl }, { label: "신청 상태 보기", url: i.statusUrl, secondary: true }] },
  ]);
}
