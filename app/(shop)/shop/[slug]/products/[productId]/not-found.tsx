"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import ShopState from "../../../../../../components/shop/ShopState";

// UX-12 없는 상품 주소. 쇼핑몰 틀은 그대로 두고 상품 단위로 알려 준다.
export default function ProductNotFound() {
  const path = usePathname() ?? "";
  const list = path.replace(/\/products\/[^/]*$/, "/products");
  return (
    <>
      <ShopState title="판매가 끝난 상품이에요" body="비슷한 상품을 보여 드릴게요" />
      <p className="shop-state-act">
        <Link className="btn btn-lg" href={list}>
          상품 목록
        </Link>
      </p>
    </>
  );
}
