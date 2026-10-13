"use client";

import { useEffect, useState } from "react";
import { call } from "./reviewShared";

// 상품 상세 「쿠폰」 줄(보드 SH-003-IA): 로그인한 구매자에게 받을 수 있는 쿠폰이 있으면 첫 쿠폰과 「쿠폰 받기」.
// GET /coupons?claimable=3 → { claimable: [{ couponId, name, benefitText, ... }] }, POST /coupons/{id}/download. 받을 수 있는 쿠폰이 없거나 비회원이면 줄을 그리지 않는다.
type Claimable = { couponId: string; name: string; benefitText: string };

export default function CouponRow({ slug, loggedIn }: { slug: string; loggedIn: boolean }) {
  const api = `/api/shop/${encodeURIComponent(slug)}/coupons`;
  const [list, setList] = useState<Claimable[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!loggedIn) return;
    let live = true;
    call<{ claimable: Claimable[] }>(`${api}?claimable=3`).then((r) => live && r.ok && setList(r.data.claimable));
    return () => {
      live = false;
    };
  }, [api, loggedIn]);
  if (list.length === 0 && !msg) return null;
  const first = list[0];
  async function take() {
    if (!first || busy) return;
    setBusy(true);
    const r = await call(`${api}/${first.couponId}/download`, { method: "POST" });
    if (r.ok || r.status === 409) {
      setMsg(r.ok ? "쿠폰을 받았어요. 주문서에서 쓸 수 있어요" : (r.message ?? "쿠폰을 받지 못했어요. 잠시 뒤 다시 눌러 주세요"));
      setList((l) => l.slice(1));
    } else setMsg(r.message ?? "쿠폰을 받지 못했어요. 잠시 뒤 다시 해 주세요");
    setBusy(false);
  }
  return (
    <div className="pd-form-row pd-coupon-row">
      <dt>쿠폰</dt>
      <dd>
        {first && (
          <>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void take()}>
              쿠폰 받기
            </button>
            <span className="pd-hint">
              {first.name} · {first.benefitText}
              {list.length > 1 ? ` 외 ${list.length - 1}장` : ""}
            </span>
          </>
        )}
        {msg && (
          <span className="pd-hint" role="status">
            {msg}
          </span>
        )}
      </dd>
    </div>
  );
}
