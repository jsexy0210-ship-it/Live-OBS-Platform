"use client";

import { createContext, useContext } from "react";

// 쇼핑몰 틀(ShopFrame)이 서버에서 확인한 구매자 로그인 상태를 화면 안 클라이언트 부품에 넘긴다(머리의 로그인·로그아웃 표시와 같은 기준).
const ShopSessionContext = createContext(false);

export function ShopSessionProvider({ loggedIn, children }: { loggedIn: boolean; children: React.ReactNode }) {
  return <ShopSessionContext.Provider value={loggedIn}>{children}</ShopSessionContext.Provider>;
}

export const useShopLoggedIn = () => useContext(ShopSessionContext);
