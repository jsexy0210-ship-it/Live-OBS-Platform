"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PageHead } from "../../../../../../components/admin-ui";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import { CategoryOrder } from "../../../../../../components/seller/display/CategoryOrder";
import { HomeSections } from "../../../../../../components/seller/display/HomeSections";
import { ListOptions } from "../../../../../../components/seller/display/ListOptions";
import { Recommended } from "../../../../../../components/seller/display/Recommended";
import type { CategoryNode, Display } from "../../../../../../components/seller/display/types";

// SA-016 상품 진열(파트너스 관리자, 상품 › 상품 진열). 홈 진열 영역·목록 기본 정렬과 진열 옵션·추천 상품·카테고리 안 순서를 정한다.
// API: GET /api/seller/display, PUT /display/sections·/display/settings·/display/recommended, GET·PUT /api/seller/categories/[id]/products. 모든 저장 응답은 바뀐 전체를 돌려준다.
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; display: Display; cats: CategoryNode[] };

export default function DisplayPage() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const notify = useCallback((text: string, neg?: boolean) => setToast({ text, neg }), []);

  const load = useCallback(async () => {
    const [d, c] = await Promise.all([api<Display>("/api/seller/display"), api<{ categories: CategoryNode[] }>("/api/seller/categories")]);
    if (!d.ok) return setState({ kind: "error", status: d.status });
    if (!c.ok) return setState({ kind: "error", status: c.status });
    setState({ kind: "ok", display: d.data, cats: c.data.categories });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const saved = (display: Display) => setState((s) => (s.kind === "ok" ? { ...s, display } : s));

  return (
    <>
      <Topbar crumb="상품 › 상품 진열" />
      <main className="main">
        <PageHead
          title="상품 진열"
          actions={
            <>
              <Link className="btn btn-out" href="/seller/products/categories">
                카테고리
              </Link>
              <Link className="btn btn-out" href="/seller/products">
                상품 목록
              </Link>
            </>
          }
        />
        {state.kind === "loading" && (
          <div className="card">
            <LoadingRows rows={6} />
          </div>
        )}
        {state.kind === "error" && (
          <div className="card">
            {state.status === 403 ? <NoPermission need="상품" /> : state.status === 402 ? <Locked /> : <ErrorState title="진열 설정을 불러오지 못했습니다" onRetry={() => void load()} />}
          </div>
        )}
        {state.kind === "ok" && (
          <>
            <HomeSections sections={state.display.sections} cats={state.cats} onSaved={saved} notify={notify} />
            <ListOptions listSort={state.display.listSort} options={state.display.options} onSaved={saved} notify={notify} />
            <Recommended items={state.display.recommended} onSaved={saved} notify={notify} />
            <CategoryOrder cats={state.cats} notify={notify} />
          </>
        )}
      </main>
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
