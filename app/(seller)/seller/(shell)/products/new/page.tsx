"use client";

import { ProductForm } from "../../../../../../components/seller/ProductForm";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { Locked, NoPermission } from "../../../../../../components/seller/States";

// SA-012 상품 등록
export default function NewProductPage() {
  const { me, can } = useSeller();
  if (!can("PRODUCT_MANAGE") || me.access === "expired") {
    return (
      <>
        <Topbar crumb="판매 › 상품 › 상품 등록" />
        <main className="main">
          <div className="card">{me.access === "expired" ? <Locked /> : <NoPermission need="상품" />}</div>
        </main>
      </>
    );
  }
  return <ProductForm />;
}
