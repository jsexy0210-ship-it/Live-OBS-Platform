"use client";

import "../../../../../../styles/seller-stock.css";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api, failMessage, type Product } from "../../../../../../components/seller/api";
import { INT4_MAX, parseAmount } from "../../../../../../components/seller/format";

// SA-014 재고 관리. 옵션마다 「변경 후」 재고를 적어 한 번에 적용하거나, 한 옵션을 사유와 함께 빼고 더한다.
// - 한 번에 적용: 옵션 수정 API에 화면이 본 재고(expectedStock)를 함께 보내, 그사이 주문으로 재고가 바뀌었으면 덮어쓰지 않는다.
// - 빼기·더하기: 재고 증감 API(사유 필수). 그사이 바뀌어도 그 수량만큼만 더하고 빼며, 모자라면 빼지 않는다.
// 재고 이력·CSV·되돌리기는 API가 생기면 붙인다.

type Row = { key: string; productId: string; productName: string; optionId: string; optionName: string; stock: number };
type Filter = "all" | "low" | "out";
const LOW = 5;
const REASONS = ["이벤트 증정", "서비스", "파손", "직접 입력"] as const;

async function loadAllProducts(): Promise<{ ok: true; products: Product[] } | { ok: false; status: number }> {
  const all: Product[] = [];
  let cursor: string | null = null;
  // 재고 화면은 검색·걸러 보기를 화면에서 하므로 모든 상품을 200개씩 이어서 불러온다
  for (let i = 0; i < 100; i++) {
    const r: Awaited<ReturnType<typeof api<{ products: Product[]; nextCursor: string | null }>>> = await api<{ products: Product[]; nextCursor: string | null }>(`/api/seller/products?limit=200${cursor ? `&cursor=${cursor}` : ""}`);
    if (!r.ok) return { ok: false, status: r.status };
    all.push(...r.data.products);
    cursor = r.data.nextCursor;
    if (!cursor) break;
  }
  return { ok: true, products: all };
}

const toRows = (products: Product[]): Row[] =>
  products.flatMap((p) => p.options.map((o) => ({ key: o.id, productId: p.id, productName: p.name, optionId: o.id, optionName: o.name, stock: o.stock })));

function signed(n: number) {
  return n > 0 ? `+${n.toLocaleString("ko-KR")}` : n < 0 ? `−${Math.abs(n).toLocaleString("ko-KR")}` : "—";
}

export default function StockPage() {
  const { can } = useSeller();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok" }>({ kind: "loading" });
  const [rows, setRows] = useState<Row[]>([]);
  const [next, setNext] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDelta, setBulkDelta] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [confirm, setConfirm] = useState(false);
  const [applying, setApplying] = useState(false);
  const [notice, setNotice] = useState<{ kind: "neg" | "cau"; text: string } | null>(null);
  const [sheet, setSheet] = useState<Row | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await loadAllProducts();
    if (!r.ok) return setState({ kind: "error", status: r.status });
    setRows(toRows(r.products));
    setNext({});
    setSelected(new Set());
    setState({ kind: "ok" });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const target = (r: Row) => (next[r.key] === undefined ? r.stock : parseAmount(next[r.key]));
  const rowError = (r: Row): string | null => {
    const t = target(r);
    if (t === null) return "숫자만 입력해 주세요";
    if (t < 0) return "0개 이상으로 적어 주세요";
    if (t > INT4_MAX) return "재고는 21억 개까지 넣을 수 있어요";
    return null;
  };

  const visible = useMemo(() => {
    const q = query.trim().normalize("NFKC").toLowerCase();
    return rows.filter((r) => {
      if (filter === "low" && !(r.stock > 0 && r.stock <= LOW)) return false;
      if (filter === "out" && r.stock !== 0) return false;
      return !q || `${r.productName} ${r.optionName}`.normalize("NFKC").toLowerCase().includes(q);
    });
  }, [rows, query, filter]);

  const changed = rows.filter((r) => next[r.key] !== undefined && target(r) !== r.stock);
  const invalid = changed.filter((r) => rowError(r));
  const valid = changed.filter((r) => !rowError(r));
  const up = valid.reduce((s, r) => s + Math.max(0, target(r)! - r.stock), 0);
  const down = valid.reduce((s, r) => s + Math.max(0, r.stock - target(r)!), 0);
  const unsold = valid.filter((r) => r.stock === 0 && target(r)! > 0).length;

  const applyBulkDelta = () => {
    const d = parseAmount(bulkDelta);
    if (d === null || d === 0 || selected.size === 0) return;
    setNext((m) => {
      const out = { ...m };
      for (const r of rows) if (selected.has(r.key)) out[r.key] = String(Math.max(0, (target(r) ?? r.stock) + d));
      return out;
    });
  };

  const applyChanges = async () => {
    setConfirm(false);
    setApplying(true);
    setNotice(null);
    const conflicts: string[] = [];
    const failed: string[] = [];
    let done = 0;
    for (const r of valid) {
      const res = await api<Product>(`/api/seller/products/${r.productId}/options/${r.optionId}`, {
        method: "PATCH",
        body: { stock: target(r), expectedStock: r.stock },
      });
      if (res.ok) done++;
      else if (res.error === "stock_conflict") conflicts.push(`${r.productName} · ${r.optionName}`);
      else failed.push(`${r.productName} · ${r.optionName}`);
    }
    setApplying(false);
    await load();
    if (done) setToast(`재고 ${done}건을 바꿨어요`);
    if (conflicts.length || failed.length) {
      const parts = [];
      if (conflicts.length) parts.push(`그사이 주문 등으로 재고가 바뀌어 ${conflicts.length}건은 바꾸지 않았어요(${conflicts.join(", ")}). 지금 재고를 보고 다시 적어 주세요.`);
      if (failed.length) parts.push(`${failed.length}건은 저장하지 못했어요(${failed.join(", ")}).`);
      setNotice({ kind: "cau", text: parts.join(" ") });
    }
  };

  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(r.key));
  const toggleAll = () =>
    setSelected((s) => {
      const out = new Set(s);
      if (allVisibleSelected) visible.forEach((r) => out.delete(r.key));
      else visible.forEach((r) => out.add(r.key));
      return out;
    });

  const applyLabel = applying ? "적용하고 있어요" : `변경 ${valid.length}건 적용`;

  if (!can("PRODUCT_MANAGE")) {
    return (
      <>
        <Topbar crumb="판매 › 상품 › 재고 관리" />
        <main className="main">
          <div className="card">
            <NoPermission need="상품" />
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <Topbar crumb="판매 › 상품 › 재고 관리">
        <Link className="btn btn-sm btn-out" href="/seller/products">
          상품 목록
        </Link>
        <button className="btn btn-sm" type="button" disabled={valid.length === 0 || applying} onClick={() => setConfirm(true)}>
          {applyLabel}
        </button>
      </Topbar>
      <main className="main">
        <div className="ph">
          <div className="col" style={{ gap: 4 }}>
            <h1 className="t-t3">재고 관리</h1>
            <span className="t-l2 c-alt">옵션마다 바꿀 재고를 적고 한 번에 적용하거나, 사유와 함께 빼고 더해요.</span>
          </div>
        </div>
        {notice && (
          <div className={`msg msg-${notice.kind}`} role="alert">
            <span>{notice.text}</span>
          </div>
        )}
        {state.kind !== "ok" ? (
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={6} />}
            {state.kind === "error" &&
              (state.status === 403 ? (
                <NoPermission need="상품" />
              ) : state.status === 402 ? (
                <Locked />
              ) : (
                <ErrorState title="재고를 불러오지 못했어요" onRetry={() => void load()} />
              ))}
          </div>
        ) : (
          <div className="form-grid stock-grid">
            <div className="card" style={{ overflow: "hidden" }}>
              <div className="toolbar" style={{ padding: "14px 20px", boxShadow: "inset 0 -1px 0 var(--wds-line-normal-alternative)" }}>
                <div className="search stock-search">
                  <input className="inp inp-sm" type="search" placeholder="상품명 · 옵션명 검색" aria-label="재고 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
                <button className={`chip${filter === "low" ? " on" : ""}`} type="button" aria-pressed={filter === "low"} onClick={() => setFilter(filter === "low" ? "all" : "low")}>
                  재고 {LOW} 이하
                </button>
                <button className={`chip${filter === "out" ? " on" : ""}`} type="button" aria-pressed={filter === "out"} onClick={() => setFilter(filter === "out" ? "all" : "out")}>
                  품절
                </button>
                <div className="row stock-bulk">
                  <span className="t-l2 c-alt">선택한 옵션에</span>
                  <input className="inp inp-sm num" type="text" inputMode="numeric" placeholder="+10" value={bulkDelta} onChange={(e) => setBulkDelta(e.target.value)} aria-label="선택한 옵션에 더하거나 뺄 수량" style={{ width: 80, textAlign: "right" }} />
                  <button className="btn btn-sm btn-out" type="button" onClick={applyBulkDelta} disabled={selected.size === 0 || !parseAmount(bulkDelta)}>
                    한꺼번에 적기
                  </button>
                </div>
              </div>

              {visible.length === 0 ? (
                <div className="st" style={{ boxShadow: "none" }}>
                  <div className="st-ic">?</div>
                  <span className="t">{rows.length === 0 ? "아직 재고를 관리할 상품이 없어요" : "조건에 맞는 옵션이 없어요"}</span>
                  {rows.length > 0 && (
                    <button
                      className="btn btn-sm btn-text"
                      type="button"
                      onClick={() => {
                        setQuery("");
                        setFilter("all");
                      }}
                    >
                      조건 지우기
                    </button>
                  )}
                </div>
              ) : (
                <table className="tbl stock-table">
                  <thead>
                    <tr>
                      <th style={{ width: 44 }}>
                        <input className="cbx" type="checkbox" checked={allVisibleSelected} onChange={toggleAll} aria-label="보이는 옵션 모두 선택" />
                      </th>
                      <th>상품 · 옵션</th>
                      <th className="r" style={{ width: 90 }}>
                        현재
                      </th>
                      <th className="r" style={{ width: 140 }}>
                        변경 후
                      </th>
                      <th className="r" style={{ width: 80 }}>
                        차이
                      </th>
                      <th style={{ width: 100 }}>상태</th>
                      <th style={{ width: 128 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((r) => {
                      const t = target(r);
                      const err = rowError(r);
                      const diff = t === null ? 0 : t - r.stock;
                      const badge = err
                        ? { l: "오류", c: "b-fail" }
                        : t === 0
                          ? { l: "품절", c: "b-fail" }
                          : r.stock === 0 && t! > 0
                            ? { l: "품절 해제", c: "b-info" }
                            : t! <= LOW
                              ? { l: "재고 부족", c: "b-warn" }
                              : { l: "재고 있음", c: "b-done" };
                      return (
                        <tr key={r.key} className={diff === 0 && !err ? "" : "sel"} data-testid="stock-row">
                          <td className="c-check">
                            <input
                              className="cbx"
                              type="checkbox"
                              checked={selected.has(r.key)}
                              onChange={() =>
                                setSelected((s) => {
                                  const out = new Set(s);
                                  if (out.has(r.key)) out.delete(r.key);
                                  else out.add(r.key);
                                  return out;
                                })
                              }
                              aria-label={`${r.productName} ${r.optionName} 선택`}
                            />
                          </td>
                          <td className="c-name">
                            <span className="fw6 ell" style={{ display: "block" }}>
                              {r.productName}
                            </span>
                            <span className="t-c1 c-alt ell" style={{ display: "block" }}>
                              {r.optionName}
                            </span>
                          </td>
                          <td className="r num c-cur">
                            <span className="m-lbl">현재 </span>
                            {r.stock.toLocaleString("ko-KR")}
                          </td>
                          <td className="c-next">
                            <input
                              className={`inp inp-sm num${err ? " is-error" : diff !== 0 ? " is-focus" : ""}`}
                              type="text"
                              inputMode="numeric"
                              value={next[r.key] ?? String(r.stock)}
                              onChange={(e) => setNext((m) => ({ ...m, [r.key]: e.target.value }))}
                              aria-label={`${r.productName} ${r.optionName} 변경 후 재고`}
                              aria-invalid={!!err}
                              title={err ?? undefined}
                              style={{ textAlign: "right" }}
                            />
                          </td>
                          <td className={`r num c-diff ${diff > 0 ? "c-pos fw6" : diff < 0 ? "c-neg fw6" : "c-ast"}`}>{signed(diff)}</td>
                          <td className="c-state">
                            <span className={`bdg ${badge.c}`}>{badge.l}</span>
                          </td>
                          <td className="c-act">
                            <button className="btn btn-sm btn-out" type="button" onClick={() => setSheet(r)} aria-label={`${r.productName} ${r.optionName} 빼기 · 더하기`}>
                              빼기 · 더하기
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              <div className="row between" style={{ padding: "12px 20px", gap: 12, flexWrap: "wrap" }}>
                <span className="t-l2 c-alt">
                  옵션 {rows.length.toLocaleString("ko-KR")}개 중 {changed.length}개 바뀜 · 적용하기 전에는 반영되지 않아요
                </span>
                {invalid.length > 0 && <span className="err">고칠 칸이 {invalid.length}개 있어요. 그 칸은 빼고 적용해요</span>}
              </div>
            </div>

            <aside className="col aside-sticky" style={{ gap: 16 }}>
              <div className="card pad col" style={{ gap: 10 }}>
                <span className="t-hl2">바뀐 내용</span>
                <dl className="kv" style={{ margin: 0 }}>
                  <dt>바꿀 옵션</dt>
                  <dd className="num" data-testid="sum-count">
                    {valid.length}개
                  </dd>
                  <dt>늘어나는 재고</dt>
                  <dd className={`num${up ? " c-pos" : " c-ast"}`}>{signed(up)}</dd>
                  <dt>줄어드는 재고</dt>
                  <dd className={`num${down ? " c-neg" : " c-ast"}`}>{signed(-down)}</dd>
                  <dt>품절 해제</dt>
                  <dd className="num">{unsold}개</dd>
                </dl>
                <button className="btn btn-block" type="button" disabled={valid.length === 0 || applying} onClick={() => setConfirm(true)}>
                  {applyLabel}
                </button>
              </div>
            </aside>
          </div>
        )}
      </main>

      {confirm && (
        <div className="dim dim-fixed" role="dialog" aria-modal="true" aria-labelledby="apply-title">
          <div className="modal">
            <div className="modal-h">
              <h3 id="apply-title" className="t-hl1">
                재고 {valid.length}건을 적용할까요?
              </h3>
              <p className="t-b2 c-neu">
                쇼핑몰에 바로 반영돼요.{invalid.length ? ` 고칠 칸 ${invalid.length}개는 빼고 적용해요.` : ""} 그사이 주문으로 재고가 바뀐 옵션은 바꾸지 않고 알려 드려요.
              </p>
            </div>
            <div className="modal-f">
              <button className="btn btn-out" type="button" onClick={() => setConfirm(false)}>
                취소
              </button>
              <button className="btn" type="button" onClick={() => void applyChanges()}>
                적용
              </button>
            </div>
          </div>
        </div>
      )}
      {sheet && (
        <AdjustSheet
          row={rows.find((r) => r.key === sheet.key) ?? sheet}
          onClose={() => setSheet(null)}
          onDone={(row, stock, text) => {
            setRows((rs) => rs.map((r) => (r.key === row.key ? { ...r, stock } : r)));
            setNext((m) => {
              const out = { ...m };
              delete out[row.key];
              return out;
            });
            setSheet(null);
            setToast(text);
          }}
        />
      )}
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}

// 재고 빼기·더하기 시트: 수량과 사유(필수)를 받아 재고 증감 API로 보낸다
function AdjustSheet({ row, onClose, onDone }: { row: Row; onClose: () => void; onDone: (row: Row, stock: number, text: string) => void }) {
  const [mode, setMode] = useState<"minus" | "plus">("minus");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState<(typeof REASONS)[number] | null>(null);
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const n = parseAmount(qty);
  const qtyError =
    qty.trim() === ""
      ? null
      : n === null
        ? "숫자만 입력해 주세요"
        : n < 1
          ? "1개 이상으로 적어 주세요"
          : mode === "minus" && n > row.stock
            ? `남은 재고보다 많이 뺄 수 없어요 · 지금 ${row.stock.toLocaleString("ko-KR")}개`
            : mode === "plus" && n > INT4_MAX - row.stock
              ? "재고는 21억 개까지 넣을 수 있어요"
              : null;
  const note = reason === "직접 입력" ? memo.trim() : reason;
  const memoError = reason === "직접 입력" && memo.trim().length > 100 ? "사유는 100자까지 쓸 수 있어요" : null;
  const ready = n !== null && n >= 1 && !qtyError && !!note && !memoError;
  const verb = mode === "minus" ? "빼기" : "더하기";

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const r = await api<{ optionId: string; stock: number }>(`/api/seller/products/${row.productId}/options/${row.optionId}/stock-adjust`, {
      method: "POST",
      body: { delta: mode === "minus" ? -n! : n!, reason: note },
    });
    setBusy(false);
    if (!r.ok) return setError(failMessage(r, "재고를 바꾸지 못했어요. 잠시 뒤 다시 시도해 주세요"));
    onDone(row, r.data.stock, `${row.productName} 재고 ${n!.toLocaleString("ko-KR")}개를 ${mode === "minus" ? "뺐어요" : "더했어요"} · 남은 재고 ${r.data.stock.toLocaleString("ko-KR")}`);
  };

  return (
    <div className="dim dim-fixed" role="dialog" aria-modal="true" aria-labelledby="adj-title">
      <div className="modal">
        <div className="modal-h">
          <h3 id="adj-title" className="t-hl1">
            {row.productName} · {row.optionName}
          </h3>
          <p className="t-l2 c-alt">현재 재고 {row.stock.toLocaleString("ko-KR")}개</p>
        </div>
        {error && (
          <div className="msg msg-neg" role="alert">
            {error}
          </div>
        )}
        <div className="seg" role="radiogroup" aria-label="빼기 또는 더하기" style={{ alignSelf: "flex-start" }}>
          <button type="button" role="radio" aria-checked={mode === "minus"} className={mode === "minus" ? "on" : ""} onClick={() => setMode("minus")}>
            빼기
          </button>
          <button type="button" role="radio" aria-checked={mode === "plus"} className={mode === "plus" ? "on" : ""} onClick={() => setMode("plus")}>
            더하기
          </button>
        </div>
        <div className="fld">
          <label htmlFor="adj-qty">수량</label>
          <input
            id="adj-qty"
            className={`inp num${qtyError ? " is-error" : ""}`}
            type="text"
            inputMode="numeric"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            style={{ textAlign: "right", width: 160 }}
            aria-invalid={!!qtyError}
          />
          {qtyError && <span className="err">{qtyError}</span>}
        </div>
        <div className="fld">
          <span className="lbl">사유</span>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }} role="radiogroup" aria-label="사유">
            {REASONS.map((r) => (
              <button key={r} className={`chip${reason === r ? " on" : ""}`} type="button" role="radio" aria-checked={reason === r} onClick={() => setReason(r)}>
                {r}
              </button>
            ))}
          </div>
        </div>
        {reason === "직접 입력" && (
          <div className="fld">
            <label htmlFor="adj-memo">사유 메모</label>
            <input id="adj-memo" className={`inp${memoError ? " is-error" : ""}`} type="text" placeholder="예: 추가 입고" value={memo} onChange={(e) => setMemo(e.target.value)} />
            {memoError && <span className="err">{memoError}</span>}
          </div>
        )}
        <span className="t-c1 c-alt">바꾼 사람·시각과 사유가 함께 기록돼요</span>
        <div className="modal-f">
          <button className="btn btn-out" type="button" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button className="btn" type="button" onClick={() => void submit()} disabled={!ready || busy}>
            {busy ? "바꾸고 있어요" : n && n >= 1 ? `${n.toLocaleString("ko-KR")}개 ${verb}` : verb}
          </button>
        </div>
      </div>
    </div>
  );
}

