"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ProductForm } from "../../../../../../components/seller/ProductForm";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission } from "../../../../../../components/seller/States";
import { api, type Product } from "../../../../../../components/seller/api";

// SA-012-E 상품 수정
export default function EditProductPage() {
  const { productId } = useParams<{ productId: string }>();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; product: Product }>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await api<Product>(`/api/seller/products/${productId}`);
    setState(r.ok ? { kind: "ok", product: r.data } : { kind: "error", status: r.status });
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === "ok") return <ProductForm key={state.product.id} initial={state.product} />;
  return (
    <>
      <Topbar crumb="판매 › 상품" />
      <main className="main">
        <div className="card">
          {state.kind === "loading" && <LoadingRows rows={6} />}
          {state.kind === "error" &&
            (state.status === 404 ? (
              <div className="st" style={{ boxShadow: "none" }}>
                <div className="st-ic">?</div>
                <span className="t">상품을 찾을 수 없습니다</span>
                <span className="s">이미 삭제된 상품일 수 있습니다.</span>
                <Link className="btn btn-sm" href="/seller/products">
                  상품 목록으로
                </Link>
              </div>
            ) : state.status === 403 ? (
              <NoPermission need="상품" />
            ) : state.status === 402 ? (
              <Locked />
            ) : (
              <ErrorState title="상품을 불러오지 못했습니다" onRetry={() => void load()} />
            ))}
        </div>
      </main>
    </>
  );
}
