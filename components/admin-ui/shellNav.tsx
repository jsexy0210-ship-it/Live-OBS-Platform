"use client";

import { createContext, useContext } from "react";

// 셸(파트너스·마스터 관리자 틀)이 PageHead에 넘기는 화면 이동 정보.
// backHref: 화면 ← 버튼이 갈 부모 주소(없으면 ← 없음 = 메뉴로 바로 여는 화면·홈). tabs: 이전 호출 호환용이며 화면 이동은 사이드 메뉴가 담당한다.
export type ShellTab = { label: string; href: string; on: boolean };
export const PARTNER_NAV_ITEMS = [
  ["info", "기본정보"], ["shop", "쇼핑몰"], ["subscription", "구독"], ["pg", "결제 연결"],
  ["broadcasts", "방송 이력"], ["orders", "주문 현황"], ["rewards", "적립금 설정"], ["notes", "메모"], ["activity", "활동 기록"],
] as const;
export type PartnerNavIndicators = { sellerId: string; noteCount: number; pgError: boolean };
export type ShellNav = { backHref: string | null; tabs: ShellTab[]; setPartnerIndicators?: (value: PartnerNavIndicators | null) => void };

const ShellNavCtx = createContext<ShellNav>({ backHref: null, tabs: [] });
export const ShellNavProvider = ShellNavCtx.Provider;
export const useShellNav = (): ShellNav => useContext(ShellNavCtx);
