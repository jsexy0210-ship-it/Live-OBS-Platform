"use client";

import { useConfirm } from "../admin-ui/ConfirmDialog";
import { useState } from "react";

export default function MyLogoutButton({ slug }: { slug: string }) {
  const { confirm } = useConfirm();
  const [failed, setFailed] = useState(false);
  async function logout() {
    if (!(await confirm({ tone: "shop", title: "로그아웃할까요?", body: "이 기기에서 로그아웃돼요.", confirmLabel: "로그아웃" }))) return;
    try {
      const response = await fetch(`/api/shop/${encodeURIComponent(slug)}/auth/logout`, { method: "POST" });
      if (!response.ok) throw new Error("logout failed");
      window.location.assign(`/shop/${encodeURIComponent(slug)}`);
    } catch { setFailed(true); }
  }
  return <><button type="button" className="shop-my-logout" onClick={() => void logout()}>로그아웃</button>{failed && <p role="alert">로그아웃하지 못했어요. 다시 시도해 주세요.</p>}</>;
}
