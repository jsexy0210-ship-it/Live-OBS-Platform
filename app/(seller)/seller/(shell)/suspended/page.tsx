"use client";

import Link from "next/link";
import { PageHead } from "../../../../../components/admin-ui";
import { Topbar } from "../../../../../components/seller/SellerShell";

// AU-006 이용 정지 안내. 마스터가 이용을 정지한 파트너스가 로그인하거나 막힌 화면을 열면(서버 403 seller_suspended) 이 안내로 온다.
// 정지 중에도 이미 받은 주문 처리(배송·환불·문의)와 공지·문의하기는 쓸 수 있다(대표님 결정 2026-10-04, 서버 가드 기준).
export default function SuspendedPage() {
  return (
    <>
      <Topbar crumb="이용 정지" />
      <main className="main">
        <PageHead title="이용이 정지되었습니다" />
        <div className="card pad-l col" style={{ gap: 14, maxWidth: 640 }} data-testid="seller-suspended">
          <span className="t-b1">새 판매와 방송, 상품·설정 변경은 멈춰 있습니다. 이미 받은 주문의 처리(배송·환불·구매자 문의)는 계속할 수 있습니다.</span>
          <span className="t-l2 c-alt">정지를 풀려면 「공지 · 문의」에서 문의해 주십시오. 정지한 이유는 플랫폼이 알려 드립니다.</span>
          <div className="row" style={{ gap: 8 }}>
            <Link className="btn" href="/seller/orders">
              주문 처리
            </Link>
            <Link className="btn btn-out" href="/seller/inquiries/new">
              문의하기
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}
