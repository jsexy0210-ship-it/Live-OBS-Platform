"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FormRow, FormSection, ListTable, PageHead, useConfirm } from "../admin-ui";
import { Topbar, useSeller } from "./SellerShell";
import { QuickPrice, QuickStatus, QuickStock, type QuickDone, type QuickUndo } from "./ProductQuick";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "./States";
import { api, type Product, type ProductStatus } from "./api";
import { statusBadge, totalStock, won } from "./format";

type BulkResult = { updated: string[]; skipped: { productId: string; reason: string }[] };
const SKIP_REASON: Record<string, string> = { not_found: "찾을 수 없음", no_sellable_option: "판매할 수 있는 선택 항목이 없음(상품 수정에서 추가해 주십시오)" };
const STATUS_TO: Record<string, string> = { ON_SALE: "판매 중으로", HIDDEN: "숨김으로", SOLD_OUT: "품절로", DRAFT: "임시 저장으로" };

// 목록은 조회·선택·이동만 담당한다. 변경과 되돌리기는 실제 작업 상세에서만 실행한다.
export function ProductOperations({ ids, single = false }: { ids: string[]; single?: boolean }) {
  const { can, me } = useSeller();
  const { confirm } = useConfirm();
  const canManage = can("PRODUCT_MANAGE") && !me.readOnly;
  const requestKey = ids.join(",");
  const requestIds = useMemo(() => [...new Set(requestKey.split(",").map((id) => id.toLowerCase()))], [requestKey]);
  const validIds = requestIds.length > 0 && requestIds.length <= 200 && requestIds.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  const [items, setItems] = useState<Product[]>([]);
  const [state, setState] = useState<{ kind: "loading" } | { kind: "ok" } | { kind: "error"; status: number }>({ kind: "loading" });
  const [toast, setToast] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [undo, setUndo] = useState<{ text: string; prev: { id: string; status: ProductStatus }[] } | null>(null);
  const selected = new Set(items.map((item) => item.id));
  const load = useCallback(async () => {
    if (!canManage || !validIds) return;
    setState({ kind: "loading" });
    const responses = await Promise.all(requestIds.map((id) => api<Product>(`/api/seller/products/${id}`)));
    const error = responses.find((response) => !response.ok);
    if (error && !error.ok) return setState({ kind: "error", status: error.status });
    setItems(responses.flatMap((response) => response.ok ? [response.data] : []));
    setState({ kind: "ok" });
  }, [canManage, validIds, requestIds]);
  useEffect(() => { void load(); }, [load]);
  const skippedText = (r: BulkResult) => (r.skipped.length === 0 ? "" : ` ${r.skipped.length}개는 바꾸지 못했습니다(${[...new Set(r.skipped.map((s) => SKIP_REASON[s.reason] ?? "바꿀 수 없는 상품임"))].join(" · ")})`);

  // 상세 값은 서버 응답을 받은 뒤에만 바뀌고, 되돌릴 수 있는 변경은 기존 되돌리기를 제공한다.
  const [quickUndo, setQuickUndo] = useState<{ text: string; run: QuickUndo } | null>(null);
  const quickDone: QuickDone = (p, text, undo) => {
    setItems((items) => items.map((x) => x.id === p.id ? { ...x, status: p.status, options: p.options, price: p.price ?? x.price } : x));
    if (!text) return;
    if (undo) {
      setToast(null);
      setQuickUndo({ text, run: undo });
    } else setToast(text);
  };
  const quickFail = (text: string) => setToast(text);
  const bulkStatus = async (status: ProductStatus) => {
    const ids = [...selected];
    if (!(await confirm({ title: `선택한 상품 ${ids.length}개를 ${STATUS_TO[status] ?? "선택한 상태로"} 바꾸시겠습니까?`, body: "쇼핑몰에 바로 반영됩니다.", confirmLabel: "바꾸기" }))) return;
    const prev = items.filter((p) => selected.has(p.id)).map((p) => ({ id: p.id, status: p.status }));
    setBulkBusy(true);
    const r = await api<BulkResult>("/api/seller/products/bulk", { method: "POST", body: { action: "status", status, productIds: ids } });
    setBulkBusy(false);
    if (!r.ok) return setToast(r.message ?? "상태를 바꾸지 못했습니다. 다시 시도해 주십시오");
    const done = new Set(r.data.updated);
    void load();
    setUndo({ text: `선택한 ${r.data.updated.length}개 상품을 ${STATUS_TO[status] ?? "선택한 상태로"} 바꿨습니다.${skippedText(r.data)}`, prev: prev.filter((p) => done.has(p.id) && p.status !== status) });
  };

  const undoBulk = async () => {
    if (!undo) return;
    const groups = new Map<ProductStatus, string[]>();
    for (const p of undo.prev) groups.set(p.status, [...(groups.get(p.status) ?? []), p.id]);
    setUndo(null);
    setBulkBusy(true);
    let failed = 0;
    for (const [status, ids] of groups) {
      const r = await api<BulkResult>("/api/seller/products/bulk", { method: "POST", body: { action: "status", status, productIds: ids } });
      if (!r.ok) failed += ids.length;
      else failed += r.data.skipped.length;
    }
    setBulkBusy(false);
    void load();
    setToast(failed ? `되돌리지 못한 상품이 ${failed}개 있습니다` : "되돌렸습니다");
  };

  const bulkDelete = async () => {
    const ids = [...selected];
    setBulkBusy(true);
    const r = await api<BulkResult>("/api/seller/products/bulk", { method: "POST", body: { action: "delete", productIds: ids } });
    setBulkBusy(false);
    setConfirmDelete(false);
    if (!r.ok) return setToast(r.message ?? "삭제하지 못했습니다. 다시 시도해 주십시오");
    setItems((items) => items.filter((item) => !r.data.updated.includes(item.id)));
    setToast(`상품 ${r.data.updated.length}개를 삭제했습니다.${skippedText(r.data)}`);
  };


  const product = single ? items[0] : null;
  return <>
    <Topbar crumb="상품 › 작업 상세" />
    <main className="main">
      <PageHead title={single ? "상품 작업 상세" : "선택 상품 작업 상세"} description="가격·재고·판매 상태를 확인하고 상세에서 바꿔요." back="/seller/products" />
      {!canManage ? <NoPermission need="상품 관리" /> : !validIds ? <div className="card"><p>작업할 상품을 목록에서 다시 골라 주세요.</p><Link href="/seller/products" className="btn btn-out">상품 목록으로</Link></div> : state.kind === "loading" ? <div className="card"><LoadingRows rows={3} /></div> : state.kind === "error" ? state.status === 403 ? <NoPermission need="상품 관리" /> : state.status === 402 ? <Locked /> : <div className="card"><ErrorState title="상품을 불러오지 못했어요." onRetry={() => void load()} /></div> : <>
        {product ? <section data-testid="product-detail-operations" aria-label="상품 변경">
          <FormSection title={product.name}>
            <FormRow label="상품 코드"><span>{product.code}</span></FormRow>
            <FormRow label="판매가"><QuickPrice product={product} onDone={quickDone} onFail={quickFail} /></FormRow>
            <FormRow label="재고">{product.options.length === 1 ? <QuickStock product={product} onDone={quickDone} onFail={quickFail} /> : <><span>{totalStock(product).toLocaleString("ko-KR")}</span><Link href={`/seller/products/${product.id}`}>상품 수정에서 옵션별로 변경</Link></>}</FormRow>
            <FormRow label="판매 상태"><span className={`bdg ${statusBadge(product).cls}`}>{statusBadge(product).label}</span><QuickStatus product={product} onDone={quickDone} onFail={quickFail} /></FormRow>
            <FormRow label="쇼핑몰 노출"><span>{product.status === "ON_SALE" || product.status === "SOLD_OUT" ? "보임" : "안 보임"}</span></FormRow>
          </FormSection>
          <Link className="btn btn-out" href={`/seller/products/${product.id}`}>상품 내용 수정</Link>
        </section> : <section className="au-list-section" aria-label="선택한 상품">
          <p>선택한 상품 {items.length}개에만 적용해요.</p>
          <ListTable aria-label="선택 상품 표"><table className="tbl"><thead><tr><th>상품</th><th>판매가</th><th>재고</th><th>판매 상태</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><Link href={`/seller/products/${item.id}`}>{item.name}</Link></td><td>{won(item.price)}</td><td>{totalStock(item).toLocaleString("ko-KR")}</td><td>{statusBadge(item).label}</td></tr>)}</tbody></table></ListTable>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-out" type="button" disabled={!items.length || bulkBusy} onClick={() => void bulkStatus("ON_SALE")}>선택 판매 중</button>
            <button className="btn btn-out" type="button" disabled={!items.length || bulkBusy} onClick={() => void bulkStatus("HIDDEN")}>선택 숨김</button>
            <button className="btn btn-neg" type="button" disabled={!items.length || bulkBusy} onClick={() => setConfirmDelete(true)}>선택 삭제</button>
          </div>
        </section>}
      </>}
    </main>
      {confirmDelete && (
        <div className="dim dim-fixed" role="dialog" aria-modal="true" aria-labelledby="bulk-del-title">
          <div className="modal">
            <div className="modal-h">
              <h3 id="bulk-del-title" className="t-hl1 c-neg">
                선택한 상품 {selected.size}개를 삭제하시겠습니까?
              </h3>
              <p className="t-b2 c-neu">삭제한 상품은 쇼핑몰과 주문대기에서 바로 빠집니다. 이미 들어온 주문은 그대로 처리됩니다. 삭제한 상품은 되살릴 수 없습니다.</p>
            </div>
            <div className="modal-f">
              <button className="btn btn-out" type="button" onClick={() => setConfirmDelete(false)} disabled={bulkBusy}>
                취소
              </button>
              <button className="btn btn-neg" type="button" onClick={() => void bulkDelete()} disabled={bulkBusy}>
                삭제
              </button>
            </div>
          </div>
        </div>
      )}
      {quickUndo && (
        <UndoToast
          text={quickUndo.text}
          canUndo
          onUndo={() => {
            const run = quickUndo.run;
            setQuickUndo(null);
            void run();
          }}
          onDone={() => setQuickUndo(null)}
        />
      )}
      {undo && <UndoToast text={undo.text} canUndo={undo.prev.length > 0} onUndo={() => void undoBulk()} onDone={() => setUndo(null)} />}
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
  </>;
}

// 일괄 처리 결과 알림: 몇 초 동안 「되돌리기」를 누를 수 있다
function UndoToast({ text, canUndo, onUndo, onDone }: { text: string; canUndo: boolean; onUndo: () => void; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 8000);
    return () => clearTimeout(t);
  }, [text]);
  return (
    <div className="toast-wrap" role="status">
      <div className="toast">
        <span className="tdot" />
        {text}
        {canUndo && (
          <button className="btn btn-sm btn-text" type="button" onClick={onUndo} style={{ marginLeft: 8 }}>
            되돌리기
          </button>
        )}
      </div>
    </div>
  );
}
