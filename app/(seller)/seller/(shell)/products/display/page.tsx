"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import { CategoryOrder } from "../../../../../../components/seller/display/CategoryOrder";
import { HomeSections } from "../../../../../../components/seller/display/HomeSections";
import { ListOptions } from "../../../../../../components/seller/display/ListOptions";
import { Recommended } from "../../../../../../components/seller/display/Recommended";
import { LEAVE_ORDER_DIALOG, LEAVE_ORDER_MESSAGE, SAVE_ORDER_DONE, type CategoryNode, type Display, type Track } from "../../../../../../components/seller/display/types";
import { useUnsavedGuard } from "../../../../../../lib/client/navigation";

// SA-016 상품 진열(파트너스 관리자, 상품 › 상품 진열). 홈 진열 영역·목록 기본 정렬과 진열 옵션·추천 상품·카테고리 안 순서를 정한다.
// API: GET /api/seller/display, PUT /display/sections·/display/settings·/display/recommended, GET·PUT /api/seller/categories/[id]/products. 모든 저장 응답은 바뀐 전체를 돌려준다.
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; display: Display; cats: CategoryNode[] };

export default function DisplayPage() {
  const { me } = useSeller();
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

  // 순서 3곳(홈 진열 영역 · 추천 상품 · 카테고리 안)의 바뀐 내용을 모아 아래 「저장」 1회로 저장한다.
  const regs = useRef(new Map<string, { dirty: boolean; save: () => Promise<boolean> }>());
  const [dirtyCount, setDirtyCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const track = useCallback<Track>((name, dirty, save) => {
    regs.current.set(name, { dirty, save });
    setDirtyCount([...regs.current.values()].filter((r) => r.dirty).length);
  }, []);
  useUnsavedGuard(dirtyCount > 0 && !saving, LEAVE_ORDER_MESSAGE, { dialog: LEAVE_ORDER_DIALOG });
  const saveAll = async () => {
    if (savingRef.current || me.readOnly) return;
    savingRef.current = true;
    setSaving(true);
    let ok = true;
    try {
      for (const r of [...regs.current.values()]) {
        if (!r.dirty) continue;
        if (!(await r.save())) { ok = false; break; }
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
    if (ok) notify(SAVE_ORDER_DONE);
  };

  const saved = (display: Display) => setState((s) => (s.kind === "ok" ? { ...s, display } : s));

  return (
    <>
      <Topbar crumb="상품 › 분류 · 진열 › 홈 진열" />
      <main className="main">
        <PageHead
          title="홈 진열"
          actions={
            <>
              <Link className="btn btn-out" href="/seller/products/categories">
                카테고리
              </Link>
              <Link className="btn btn-out" href="/seller/products">
                상품 목록
              </Link>
              <a className="btn btn-out" href={`/shop/${me.shop.slug}`} target="_blank" rel="noreferrer">
                쇼핑몰 홈 보기
              </a>
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
            <HomeSections sections={state.display.sections} cats={state.cats} onSaved={saved} notify={notify} track={track} recommendedCount={state.display.recommended.filter((i) => !i.deleted).length} />
            <ListOptions listSort={state.display.listSort} options={state.display.options} onSaved={saved} notify={notify} />
            <Recommended items={state.display.recommended} onSaved={saved} notify={notify} track={track} />
            <CategoryOrder cats={state.cats} notify={notify} track={track} />
            <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <button className="btn" type="button" disabled={dirtyCount === 0 || saving || me.readOnly} onClick={() => void saveAll()}>
                {saving ? "저장 중" : "저장"}
              </button>
              <span className="t-c1 c-alt">▲▼로 바꾼 순서(홈 진열 영역 · 추천 상품 · 카테고리 안)는 「저장」을 눌러야 홈 · 목록에 반영됩니다 · 저장 전에 나가면 확인 창이 뜹니다</span>
            </div>
          </>
        )}
      </main>
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
