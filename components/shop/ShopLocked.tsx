"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { call } from "./reviewShared";

// SH-041 쇼핑몰 잠금(보드 FINAL v320): 구독 만료·이용 권한 없음 등으로 잠긴 쇼핑몰은 홈·상품·장바구니 주소로 들어와도 이 화면만 보인다(판매자 사정은 적지 않는다).
// 로그인한 구매자는 「주문 조회」·「문의하기」(이미 주문한 건에 대해서만)를, 로그인 전에는 「로그인하기」를 본다. 주문 조회·문의 작성·답변 보기만 열려 있고 장바구니·결제는 닫힌다.
export default function ShopLocked({ slug }: { slug: string }) {
  const base = `/shop/${encodeURIComponent(slug)}`;
  const [who, setWho] = useState<"loading" | "in" | "out">("loading");
  useEffect(() => {
    let live = true;
    call(`/api/shop/${encodeURIComponent(slug)}/orders?limit=1`).then((r) => live && setWho(r.ok ? "in" : r.status === 401 ? "out" : "in"));
    return () => {
      live = false;
    };
  }, [slug]);
  return (
    <section className="card shop-card shop-state shop-locked" role="status">
      <span className="shop-state-ico is-text" aria-hidden>
        !
      </span>
      <h1 id="shop-state-title" className="t-h1" tabIndex={-1}>
        지금은 쇼핑몰을 이용할 수 없어요
      </h1>
      <p className="t-l1 c-alt">이미 주문한 내역은 확인할 수 있어요.</p>
      {who === "out" ? (
        <>
          <p className="t-l2 c-alt">주문 조회는 로그인 후 볼 수 있어요</p>
          <Link className="btn" href={`${base}/login?next=${encodeURIComponent(`${base}/orders`)}`}>
            로그인하기
          </Link>
        </>
      ) : (
        <>
          <div className="shop-locked-btns">
            <Link className="btn" href={`${base}/orders`}>
              주문 조회
            </Link>
            <Link className="btn btn-out" href={`${base}/me/inquiries`}>
              문의하기
            </Link>
          </div>
          <p className="t-l2 c-alt">문의는 이미 주문한 건에 대해서만 할 수 있어요 · 배송 · 환불을 물어봐 주세요</p>
        </>
      )}
    </section>
  );
}
