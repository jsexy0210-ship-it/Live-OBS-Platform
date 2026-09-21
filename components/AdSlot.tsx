"use client";

import { useEffect, useRef } from "react";
import { ADSENSE_CLIENT, AD_SLOTS, type AdSlotKey } from "@/lib/ads";

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

export function AdSlot({ slot }: { slot: AdSlotKey }) {
  const slotId = AD_SLOTS[slot];
  const pushed = useRef(false);

  useEffect(() => {
    if (!slotId || pushed.current) return;
    pushed.current = true;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      // 광고 차단 환경에서도 페이지 기능 유지
    }
  }, [slotId]);

  if (!slotId) return null;

  return (
    <aside className="adSlot" aria-label="광고">
      <span className="adLabel">AD</span>
      <ins
        className="adsbygoogle"
        style={{ display: "block" }}
        data-ad-client={ADSENSE_CLIENT}
        data-ad-slot={slotId}
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </aside>
  );
}
