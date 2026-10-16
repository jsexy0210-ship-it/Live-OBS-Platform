"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { call } from "./reviewShared";

// SH-040 쇼핑몰 준비 중 · 일시 정지 안내. 운영 상태가 OPEN이 아니면 로그인·비밀번호 찾기 · 주문 내역/상세 · 약관 · 고객센터 · 기존 문의 조회 외 주소는 모두 이 안내를 보여 준다(판매자 사정은 적지 않는다).
// 서버(#748)도 새 주문·장바구니·가입은 막는다. 이미 만든 결제 대기 주문의 결제는 열려 있어 주문 상세에서 이어서 할 수 있다.
type State = "OPEN" | "PREPARING" | "PAUSED";
type Orders = { orders: { id: string }[]; counts: { pending: number } };
// 마지막 글자에 받침이 있으면 「이」, 없으면 「가」(한글이 아니면 「이(가)」)
const iGa = (name: string) => {
  const c = name.trim().charCodeAt(name.trim().length - 1);
  return c >= 0xac00 && c <= 0xd7a3 ? ((c - 0xac00) % 28 === 0 ? "가" : "이") : "이(가)";
};
const OPEN_PATH = /^\/(login|password-reset|orders|terms|privacy|help)(\/|$)|^\/me\/inquiries(?:\/|$)/;

export default function ShopClosedGate({ slug, shopName, state, children }: { slug: string; shopName: string; state: State; children: React.ReactNode }) {
  const base = `/shop/${encodeURIComponent(slug)}`;
  const path = usePathname() ?? "";
  const rest = path.startsWith(base) ? path.slice(base.length) : path;
  const closed = state !== "OPEN" && !OPEN_PATH.test(rest);
  const [who, setWho] = useState<{ kind: "loading" } | { kind: "out" } | { kind: "in"; pending: number; first: string | null }>({ kind: "loading" });

  useEffect(() => {
    if (!closed) return;
    let live = true;
    call<Orders>(`/api/shop/${encodeURIComponent(slug)}/orders?tab=pending&limit=1`).then((r) => {
      if (!live) return;
      if (r.ok) setWho({ kind: "in", pending: r.data.counts.pending, first: r.data.orders[0]?.id ?? null });
      else setWho(r.status === 401 ? { kind: "out" } : { kind: "in", pending: 0, first: null });
    });
    return () => {
      live = false;
    };
  }, [closed, slug]);

  if (!closed) return <>{children}</>;
  const preparing = state === "PREPARING";
  return (
    <div className="shop-wrap shop-closed">
      <section className="card shop-card shop-state" role="status">
        <span className="shop-state-ico is-text" aria-hidden>
          {preparing ? "별" : "!"}
        </span>
        <h1 id="shop-state-title" className="t-h1" tabIndex={-1}>
          {preparing ? "곧 문을 열어요" : "지금은 잠시 쉬고 있어요"}
        </h1>
        <p className="t-l1 c-alt">
          {preparing ? `${shopName}${iGa(shopName)} 문 열 준비를 하고 있어요.` : null}
          {preparing ? <br /> : null}
          이미 주문한 내역은 확인할 수 있어요.
          {preparing ? null : (
            <>
              <br />
              진행 중인 주문은 그대로 처리돼요.
            </>
          )}
        </p>
        {who.kind === "out" ? (
          <>
            <p className="t-l2 c-alt">내 주문은 로그인한 뒤 볼 수 있어요</p>
            <Link className="btn" href={`${base}/login?next=${encodeURIComponent(`${base}/orders`)}`}>
              로그인하기
            </Link>
          </>
        ) : (
          <Link className="btn" href={`${base}/orders`}>
            내 주문 보기
          </Link>
        )}
        {who.kind === "in" && who.pending > 0 && (
          <>
            <p className="cart-msg" role="status">
              결제를 기다리는 주문이 {who.pending}건 있어요. 쉬는 동안에도 결제는 이어서 할 수 있어요.
            </p>
            <Link className="btn btn-out" href={who.pending === 1 && who.first ? `${base}/orders/${who.first}` : `${base}/orders`}>
              결제 이어하기
            </Link>
          </>
        )}
        <p className="t-l2 c-alt">새 주문 · 장바구니 · 회원가입은 {preparing ? "문을 열면" : "다시 열면"} 할 수 있어요</p>
      </section>
    </div>
  );
}
