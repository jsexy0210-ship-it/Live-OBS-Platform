"use client";

import "../../../../../../styles/seller-stock.css";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";
import { INT4_MAX, MAX_SEARCH_LENGTH, parseAmount, textLength } from "../../../../../../components/seller/format";
import { cleanText } from "../../../../../../lib/server/text/clean";
import { Modal } from "../../../../../../components/admin-ui";

// SA-014 재고 관리. 옵션마다 「변경 후」 재고를 적어 한 번에 적용하거나, 한 옵션을 사유와 함께 빼고 더한다.
// - 한 번에 적용: 재고 증감 API에 화면이 본 재고(expectedStock)와 사유를 함께 보내, 그사이 주문으로 재고가 바뀌었으면 덮어쓰지 않는다.
// - 빼기·더하기: 재고 증감 API(사유 필수). 그사이 바뀌어도 그 수량만큼만 더하고 빼며, 모자라면 빼지 않는다.
// CSV·되돌리기는 API가 생기면 붙인다.

type Row = { key: string; productId: string; productName: string; optionId: string; optionName: string; stock: number };
type Filter = "all" | "low" | "out";
const LOW = 5;
const REASONS = ["이벤트 증정", "서비스", "파손", "직접 입력"] as const;
// 한 번에 적용할 때 고르는 사유(목표 재고로 맞추는 경우가 많아 입고·재고 조사를 앞에 둔다)
const BULK_REASONS = ["재고 조사", "입고", "파손", "직접 입력"] as const;

// 직접 쓴 사유 검사: 실제로 보내는 값(앞뒤 공백을 뺀 메모)을 서버(stock-adjust)와 같은 cleanText(NFKC, 코드포인트 100자) 기준으로 본다
function memoError(memo: string): string | null {
  const sent = memo.trim();
  if (sent === "") return null;
  if (textLength(sent.normalize("NFKC").trim()) > 100) return "사유는 100자까지 입력할 수 있습니다";
  return cleanText(sent, 100, "name") ? null : "사용할 수 없는 글자가 있습니다";
}

// 옵션 단위 재고 목록(GET /api/seller/products/options)을 200개씩 불러온다. 검색(q: 상품·옵션 이름, 대소문자 무시)과
// 재고 조건(stock: out=0, low=1~5, 옵션마다)은 서버에서 거르고, 다음 쪽은 「옵션 더 불러오기」로 이어 붙인다.
type OptionStock = { productId: string; productName: string; optionId: string; optionName: string; stock: number };
type Page = { options: OptionStock[]; nextCursor: string | null };
const OPTION_PAGE = 200;
const fetchOptions = (q: string, f: Filter, cursor: string | null) =>
  api<Page>(
    `/api/seller/products/options?limit=${OPTION_PAGE}${q ? `&q=${encodeURIComponent(q)}` : ""}${f !== "all" ? `&stock=${f}` : ""}${cursor ? `&cursor=${cursor}` : ""}`,
  );
const SEARCH_DELAY_MS = 300;
// 서버 재고 조건과 같은 기준(out=0, low=1~5). 빼기·더하기로 바뀐 줄이 켜 둔 조건에 안 맞으면 목록에서 뺀다
const fitsFilter = (f: Filter, stock: number) => (f === "out" ? stock === 0 : f === "low" ? stock >= 1 && stock <= LOW : true);

const toRows = (options: OptionStock[]): Row[] =>
  options.map((o) => ({ key: o.optionId, productId: o.productId, productName: o.productName, optionId: o.optionId, optionName: o.optionName, stock: o.stock }));

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
  // 한 번에 적용 진행(순서대로 한 건씩 보낸다. 그사이 바뀐 재고 처리를 옵션마다 확실히 하려고 병렬로 보내지 않는다)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [notice, setNotice] = useState<{ kind: "neg" | "cau"; text: string } | null>(null);
  const [sheet, setSheet] = useState<Row | null>(null);
  const [histRow, setHistRow] = useState<Row | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // 검색할 때마다 목록(rows)이 바뀌어도, 바꿔 둔 재고는 다른 검색 결과에 있던 옵션까지 함께 적용한다.
  // pool: 지금까지 불러온 옵션(키 → 줄). 바뀐 옵션은 pool에서 찾는다
  const [pool, setPool] = useState<Record<string, Row>>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadedQ, setLoadedQ] = useState("");
  const [loadedFilter, setLoadedFilter] = useState<Filter>("all");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  // 검색 요청이 실패하면(400 말고) 같은 검색어로 다시 부를 수 있게 한다
  const [searchFailed, setSearchFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // 늦게 온 옛 응답(이전 검색·이전 「더 불러오기」)은 버린다
  const loadId = useRef(0);
  const loadedOnce = useRef(false);
  // keep: 다시 불러온 뒤 남겨 둘 바꾼 값(적용 중에 새로 적은 값은 지우지 않는다). 없으면 reset일 때 모두 지운다
  const load = useCallback(async (q: string, f: Filter, reset: boolean, keep?: (prev: Record<string, string>) => Record<string, string>) => {
    const id = ++loadId.current;
    if (reset) setState((s) => (s.kind === "ok" ? s : { kind: "loading" }));
    setSearching(true);
    setSearchFailed(false);
    setLoadingMore(false);
    const r = await fetchOptions(q, f, null);
    if (id !== loadId.current) return;
    setSearching(false);
    if (!r.ok) {
      // 서버 기준(NFKC 뒤 50자)을 넘었으면 길이 안내, 아니면 글자 안내
      if (r.status === 400) return setSearchError(textLength(q.normalize("NFKC").trim()) > MAX_SEARCH_LENGTH ? `검색어는 ${MAX_SEARCH_LENGTH}자까지 입력할 수 있습니다` : "검색어에 사용할 수 없는 글자가 있습니다");
      if (loadedOnce.current) return setSearchFailed(true);
      return setState({ kind: "error", status: r.status });
    }
    loadedOnce.current = true;
    setSearchError(null);
    const got = toRows(r.data.options);
    setRows(got);
    setCursor(r.data.nextCursor);
    setLoadedQ(q);
    setLoadedFilter(f);
    setPool((p) => ({ ...(reset && !keep ? {} : p), ...Object.fromEntries(got.map((x) => [x.key, x])) }));
    if (reset) {
      setNext((prev) => (keep ? keep(prev) : {}));
      setSelected(new Set());
    }
    setState({ kind: "ok" });
  }, []);

  const loadMoreOptions = async () => {
    if (!cursor) return;
    const id = loadId.current;
    setLoadingMore(true);
    const r = await fetchOptions(loadedQ, loadedFilter, cursor);
    if (id !== loadId.current) return;
    setLoadingMore(false);
    if (!r.ok) return setNotice({ kind: "neg", text: "옵션을 더 불러오지 못했습니다. 다시 눌러 주십시오" });
    const got = toRows(r.data.options);
    setRows((rs) => [...rs, ...got]);
    setCursor(r.data.nextCursor);
    setPool((p) => ({ ...p, ...Object.fromEntries(got.map((x) => [x.key, x])) }));
  };

  useEffect(() => {
    void load("", "all", true);
  }, [load]);

  // 검색어를 멈추고 잠시 뒤 서버에서 다시 찾는다
  const searchQ = query.trim();
  // 적용이 끝난 뒤 다시 불러올 때는 그사이 바뀐 검색어를 쓴다(적용 중에 검색을 바꿔도 새 결과를 옛 검색어로 덮지 않게)
  const searchQRef = useRef(searchQ);
  searchQRef.current = searchQ;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const firstSearch = useRef(true);
  useEffect(() => {
    if (firstSearch.current) {
      firstSearch.current = false;
      return;
    }
    const t = setTimeout(() => void load(searchQ, filterRef.current, false), SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [searchQ, load]);
  // 재고 조건 칩을 바꾸면 바로 서버에서 다시 거른다
  const firstFilter = useRef(true);
  useEffect(() => {
    if (firstFilter.current) {
      firstFilter.current = false;
      return;
    }
    void load(searchQRef.current, filter, false);
  }, [filter, load]);

  const target = (r: Row) => (next[r.key] === undefined ? r.stock : parseAmount(next[r.key]));
  const rowError = (r: Row): string | null => {
    const t = target(r);
    if (t === null) return "숫자만 입력해 주십시오";
    if (t < 0) return "0개 이상으로 입력해 주십시오";
    if (t > INT4_MAX) return "재고는 21억 개까지 입력할 수 있습니다";
    return null;
  };

  // 검색어·재고 조건을 바꾼 뒤 결과가 오기 전에는 지금 보이는 줄이 옛 결과라, 모두 선택·한꺼번에 적기를 막는다
  const pending = searching || searchQ !== loadedQ || filter !== loadedFilter;
  // 검색·재고 조건은 서버가 걸러 준 결과 그대로다
  const visible = rows;
  // 불러온 줄(200개씩)은 모두 그린다. 더 그릴 줄은 「옵션 더 불러오기」로만 늘어난다
  const shown = visible;
  // 검색·걸러 보기를 바꾸면 선택은 지금 결과와 겹치는 것만 남긴다(조건 밖 옵션이 「한꺼번에 적기」에 섞이지 않게)
  useEffect(() => {
    setSelected((s) => {
      if (s.size === 0) return s;
      const keys = new Set(visible.map((r) => r.key));
      const out = new Set([...s].filter((k) => keys.has(k)));
      return out.size === s.size ? s : out;
    });
  }, [visible]);

  // 바뀐 옵션은 지금 결과에 없어도(다른 검색에서 바꿔 둔 것) 함께 센다
  const changed = Object.keys(next)
    .map((k) => pool[k])
    .filter((r): r is Row => !!r && target(r) !== r.stock);
  const invalid = changed.filter((r) => rowError(r));
  const valid = changed.filter((r) => !rowError(r));
  const up = valid.reduce((s, r) => s + Math.max(0, target(r)! - r.stock), 0);
  const down = valid.reduce((s, r) => s + Math.max(0, r.stock - target(r)!), 0);
  const unsold = valid.filter((r) => r.stock === 0 && target(r)! > 0).length;

  const applyBulkDelta = () => {
    const d = parseAmount(bulkDelta);
    if (pending || d === null || d === 0 || selected.size === 0) return;
    setNext((m) => {
      const out = { ...m };
      for (const r of visible) if (selected.has(r.key)) out[r.key] = String(Math.max(0, (target(r) ?? r.stock) + d));
      return out;
    });
  };

  // 한 번에 적용: 재고 증감 API에 화면이 본 재고(expectedStock)와 사유를 함께 보낸다.
  // 그사이 재고가 바뀌었으면 서버가 바꾸지 않고 stock_conflict로 돌려준다(덮어쓰지 않음). 사유는 재고 이력에 남는다.
  const [bulkReason, setBulkReason] = useState<(typeof BULK_REASONS)[number] | null>(null);
  const [bulkMemo, setBulkMemo] = useState("");
  const bulkNote = bulkReason === "직접 입력" ? bulkMemo.trim() : bulkReason;
  const bulkMemoError = bulkReason === "직접 입력" ? memoError(bulkMemo) : null;
  const bulkNoteOk = !!bulkNote && !bulkMemoError;
  const [histKey, setHistKey] = useState(0);
  const applyChanges = async () => {
    if (!bulkNoteOk) return;
    setConfirm(false);
    setApplying(true);
    setNotice(null);
    const conflicts: string[] = [];
    const failed: string[] = [];
    let done = 0;
    let sent = 0;
    // 이번에 보낸 값. 적용이 끝난 뒤 이 값 그대로인 칸만 지우고, 그사이 새로 적거나 고친 칸은 남긴다
    const sentValues: Record<string, string> = Object.fromEntries(valid.map((r) => [r.key, next[r.key]]));
    setProgress({ done: 0, total: valid.length });
    for (const r of valid) {
      const res = await api<{ optionId: string; stock: number }>(`/api/seller/products/${r.productId}/options/${r.optionId}/stock-adjust`, {
        method: "POST",
        body: { delta: target(r)! - r.stock, reason: bulkNote, expectedStock: r.stock },
      });
      if (res.ok) done++;
      else if (res.error === "stock_conflict") conflicts.push(`${r.productName} · ${r.optionName}`);
      else failed.push(`${r.productName} · ${r.optionName}`);
      setProgress({ done: ++sent, total: valid.length });
    }
    setApplying(false);
    setProgress(null);
    setBulkReason(null);
    setBulkMemo("");
    await load(searchQRef.current, filterRef.current, true, (prev) => Object.fromEntries(Object.entries(prev).filter(([k, v]) => sentValues[k] !== v)));
    setHistKey((k) => k + 1);
    if (done) setToast(`재고 ${done}건을 변경했습니다`);
    if (conflicts.length || failed.length) {
      const parts = [];
      if (conflicts.length) parts.push(`그사이 주문 등으로 재고가 바뀌어 ${conflicts.length}건은 변경하지 않았습니다(${conflicts.join(", ")}). 지금 재고를 보고 다시 입력해 주십시오.`);
      if (failed.length) parts.push(`${failed.length}건은 저장하지 못했습니다(${failed.join(", ")}).`);
      setNotice({ kind: "cau", text: parts.join(" ") });
    }
  };

  // 「모두 선택」은 지금 불러온 옵션을 모두 고른다(서버 결과가 더 있으면 「옵션 더 불러오기」 뒤에 고른다)
  const allVisibleSelected = shown.length > 0 && shown.every((r) => selected.has(r.key));
  const toggleAll = () =>
    setSelected((s) => {
      const out = new Set(s);
      if (allVisibleSelected) shown.forEach((r) => out.delete(r.key));
      else shown.forEach((r) => out.add(r.key));
      return out;
    });

  // 적용할 옵션 중 지금 화면에 그려지지 않은 것(「N개 모두 선택」·걸러 보기 밖). 확인 창에서 따로 알린다
  const shownKeys = new Set(shown.map((r) => r.key));
  const hiddenCount = valid.filter((r) => !shownKeys.has(r.key)).length;

  const applyLabel = applying ? (progress ? `${progress.done.toLocaleString("ko-KR")}/${progress.total.toLocaleString("ko-KR")} 적용 중` : "적용 중") : `변경 ${valid.length}건 적용`;

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
            <span className="t-l2 c-alt">옵션마다 변경할 재고를 입력하고 한 번에 적용하거나, 사유와 함께 빼고 더합니다.</span>
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
                <ErrorState title="재고를 불러오지 못했습니다" onRetry={() => void load(searchQ, filter, true)} />
              ))}
          </div>
        ) : (
          <div className="form-grid stock-grid">
            <div className="card" style={{ overflow: "hidden" }}>
              <div className="toolbar" style={{ padding: "14px 20px", boxShadow: "inset 0 -1px 0 var(--wds-line-normal-alternative)" }}>
                <div className="search stock-search">
                  <input
                    className={`inp inp-sm${searchError ? " is-error" : ""}`}
                    type="search"
                    placeholder="상품명 · 옵션명 검색"
                    aria-label="재고 검색"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    aria-invalid={!!searchError}
                    maxLength={MAX_SEARCH_LENGTH}
                    aria-busy={searching}
                  />
                </div>
                <button className={`chip${filter === "low" ? " on" : ""}`} type="button" aria-pressed={filter === "low"} onClick={() => setFilter(filter === "low" ? "all" : "low")}>
                  재고 {LOW} 이하
                </button>
                <button className={`chip${filter === "out" ? " on" : ""}`} type="button" aria-pressed={filter === "out"} onClick={() => setFilter(filter === "out" ? "all" : "out")}>
                  품절
                </button>
                {/* 휴대폰에서는 표 머리줄이 숨으므로 「모두 선택」을 따로 둔다 */}
                <label className="chk stock-mselect">
                  <input className="cbx" type="checkbox" checked={allVisibleSelected} onChange={toggleAll} disabled={pending} />
                  모두 선택
                </label>
                <div className="row stock-bulk">
                  <span className="t-l2 c-alt">선택한 옵션에</span>
                  <input className="inp inp-sm num" type="text" inputMode="numeric" placeholder="+10" value={bulkDelta} onChange={(e) => setBulkDelta(e.target.value)} aria-label="선택한 옵션에 더하거나 뺄 수량" style={{ width: 80, textAlign: "right" }} />
                  <button className="btn btn-sm btn-out" type="button" onClick={applyBulkDelta} disabled={pending || selected.size === 0 || !parseAmount(bulkDelta)}>
                    한꺼번에 적기
                  </button>
                </div>
              </div>
              {/* 검색어가 틀리면(400) 검색창 바로 아래에 알리고, 옛 결과는 감춰 모두 선택이 꺼진 이유가 보이게 한다 */}
              {searchError && (
                <div className="row stock-selinfo" role="alert" data-testid="search-error">
                  <span className="t-l2 c-neg">{searchError}</span>
                  <button className="btn btn-sm btn-out" type="button" onClick={() => setQuery("")}>
                    검색 지우기
                  </button>
                </div>
              )}
              {searchFailed && (
                <div className="row stock-selinfo" role="alert" data-testid="search-failed">
                  <span className="t-l2 c-neg">「{searchQ || "전체"}」 결과를 불러오지 못했습니다</span>
                  <button className="btn btn-sm btn-out" type="button" onClick={() => void load(searchQRef.current, filterRef.current, false)}>
                    다시 시도
                  </button>
                </div>
              )}
              {searchError ? null : visible.length === 0 ? (
                <div className="st" style={{ boxShadow: "none" }}>
                  <div className="st-ic">?</div>
                  <span className="t">
                    {loadedFilter !== "all" ? "조건에 맞는 옵션이 없습니다" : loadedQ ? `「${loadedQ}」에 해당하는 상품이 없습니다` : "아직 재고를 관리할 상품이 없습니다"}
                  </span>
                  {(loadedFilter !== "all" || loadedQ) && (
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
                        <input className="cbx" type="checkbox" checked={allVisibleSelected} onChange={toggleAll} disabled={pending} aria-label="보이는 옵션 모두 선택" />
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
                      <th style={{ width: 204 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => {
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
                            {/* 2줄까지 보이고 넘치면 말줄임. 전체 이름은 마우스를 올리면 보인다 */}
                            <span className="fw6 clamp2" title={r.productName}>
                              {r.productName}
                            </span>
                            <span className="t-c1 c-alt clamp2" title={r.optionName}>
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
                            <button className="btn btn-sm btn-out" type="button" onClick={() => setHistRow(r)} aria-label={`${r.productName} ${r.optionName} 이력`}>
                              이력
                            </button>
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
              {!searchError && cursor && (
                <div className="row center" style={{ padding: "12px 20px" }}>
                  <button className="btn btn-sm btn-out" type="button" onClick={() => void loadMoreOptions()} disabled={loadingMore}>
                    {loadingMore ? "불러오는 중" : "옵션 더 불러오기"}
                  </button>
                </div>
              )}
              <div className="row between" style={{ padding: "12px 20px", gap: 12, flexWrap: "wrap" }}>
                <span className="t-l2 c-alt">
                  {searching ? (
                    <span data-testid="stock-searching">검색 중 · </span>
                  ) : null}
                  불러온 옵션 {rows.length.toLocaleString("ko-KR")}개{cursor ? " · 옵션이 더 있습니다" : ""} · 바뀐 옵션 {changed.length}개 · 적용하기 전에는 반영되지 않습니다
                  {loadingMore && <span data-testid="stock-loading-more"> · 상품을 더 불러오는 중</span>}
                </span>
                {invalid.length > 0 && <span className="err">고칠 칸이 {invalid.length}개 있습니다. 그 칸은 빼고 적용합니다</span>}
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
        {state.kind === "ok" && (
          <section className="card pad col stock-hist" style={{ gap: 12 }} aria-labelledby="hist-title">
            <div className="row between" style={{ gap: 12, flexWrap: "wrap" }}>
              <h2 id="hist-title" className="t-hl2">
                재고 이력
              </h2>
              <span className="t-c1 c-alt">주문 · 취소 · 환불과 직접 변경한 재고가 사유와 함께 남습니다</span>
            </div>
            <StockHistory refreshKey={histKey} />
          </section>
        )}
      </main>

      {/* 휴대폰: 바뀐 것이 있으면 아래에 적용 바를 고정한다 */}
      {state.kind === "ok" && changed.length > 0 && (
        <div className="stock-mbar" data-testid="stock-mbar">
          <span className="t-l2">
            바꿀 옵션 <b className="num">{valid.length}개</b>
            {invalid.length > 0 && <span className="c-neg"> · 고칠 칸 {invalid.length}개</span>}
          </span>
          <button className="btn" type="button" disabled={valid.length === 0 || applying} onClick={() => setConfirm(true)}>
            {applyLabel}
          </button>
        </div>
      )}

      {confirm && (
        <Modal labelId="apply-title" busy={applying} onClose={() => setConfirm(false)}>
          <div className="modal-h">
            <h3 id="apply-title" className="t-hl1">
              재고 {valid.length}건을 적용하시겠습니까?
            </h3>
            {hiddenCount > 0 && (
              <p className="t-l2 fw6 c-cau" data-testid="apply-hidden">
                화면에 안 보이는 {hiddenCount.toLocaleString("ko-KR")}개 포함
              </p>
            )}
            <p className="t-b2 c-neu">
              쇼핑몰에 바로 반영됩니다.{invalid.length ? ` 고칠 칸 ${invalid.length}개는 빼고 적용합니다.` : ""} 그사이 주문으로 재고가 바뀐 옵션은 변경하지 않고 따로 알려 드립니다.
            </p>
          </div>
          <div className="fld">
            <span className="lbl">사유</span>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }} role="radiogroup" aria-label="한 번에 적용하는 사유">
              {BULK_REASONS.map((r) => (
                <button key={r} className={`chip${bulkReason === r ? " on" : ""}`} type="button" role="radio" aria-checked={bulkReason === r} onClick={() => setBulkReason(r)}>
                  {r}
                </button>
              ))}
            </div>
          </div>
          {bulkReason === "직접 입력" && (
            <div className="fld">
              <label htmlFor="bulk-memo">사유 메모</label>
              <input id="bulk-memo" className={`inp${bulkMemoError ? " is-error" : ""}`} type="text" placeholder="예: 창고 재고 맞춤" value={bulkMemo} onChange={(e) => setBulkMemo(e.target.value)} aria-invalid={!!bulkMemoError} />
              {bulkMemoError && <span className="err">{bulkMemoError}</span>}
            </div>
          )}
          <span className="t-c1 c-alt">사유는 재고 이력에 함께 남습니다</span>
          <div className="modal-f">
            <button className="btn btn-out" type="button" onClick={() => setConfirm(false)}>
              취소
            </button>
            <button className="btn" type="button" onClick={() => void applyChanges()} disabled={!bulkNoteOk}>
              적용
            </button>
          </div>
        </Modal>
      )}
      {sheet && (
        <AdjustSheet
          row={rows.find((r) => r.key === sheet.key) ?? sheet}
          onClose={() => setSheet(null)}
          onDone={(row, stock, text) => {
            setRows((rs) => rs.map((r) => (r.key === row.key ? { ...r, stock } : r)).filter((r) => r.key !== row.key || fitsFilter(loadedFilter, stock)));
            setPool((p) => (p[row.key] ? { ...p, [row.key]: { ...p[row.key], stock } } : p));
            setNext((m) => {
              const out = { ...m };
              delete out[row.key];
              return out;
            });
            setSheet(null);
            setToast(text);
            setHistKey((k) => k + 1);
          }}
        />
      )}
      {histRow && (
        <Modal labelId="opt-hist-title" className="stock-hist-modal" onClose={() => setHistRow(null)}>
          <div className="modal-h">
            <h3 id="opt-hist-title" className="t-hl1 clamp2">
              {histRow.productName} · {histRow.optionName}
            </h3>
            <p className="t-l2 c-alt">이 옵션의 재고 이력입니다 · 지금 재고 {histRow.stock.toLocaleString("ko-KR")}개</p>
          </div>
          <div className="stock-hist-body">
            <StockHistory refreshKey={histKey} productId={histRow.productId} optionId={histRow.optionId} />
          </div>
          <div className="modal-f">
            <button className="btn btn-out" type="button" onClick={() => setHistRow(null)}>
              닫기
            </button>
          </div>
        </Modal>
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
        ? "숫자만 입력해 주십시오"
        : n < 1
          ? "1개 이상으로 입력해 주십시오"
          : mode === "minus" && n > row.stock
            ? `남은 재고보다 많이 뺄 수 없습니다 · 지금 ${row.stock.toLocaleString("ko-KR")}개`
            : mode === "plus" && n > INT4_MAX - row.stock
              ? "재고는 21억 개까지 입력할 수 있습니다"
              : null;
  const note = reason === "직접 입력" ? memo.trim() : reason;
  const memoErr = reason === "직접 입력" ? memoError(memo) : null;
  const ready = n !== null && n >= 1 && !qtyError && !!note && !memoErr;
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
    if (!r.ok) return setError(failMessage(r, "admin", "재고를 변경하지 못했습니다. 잠시 후 다시 시도해 주십시오"));
    onDone(row, r.data.stock, `${row.productName} 재고 ${n!.toLocaleString("ko-KR")}개를 ${mode === "minus" ? "뺐습니다" : "더했습니다"} · 남은 재고 ${r.data.stock.toLocaleString("ko-KR")}`);
  };

  return (
    <Modal labelId="adj-title" busy={busy} onClose={onClose}>
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
          <input id="adj-memo" className={`inp${memoErr ? " is-error" : ""}`} type="text" placeholder="예: 추가 입고" value={memo} onChange={(e) => setMemo(e.target.value)} aria-invalid={!!memoErr} />
          {memoErr && <span className="err">{memoErr}</span>}
        </div>
      )}
      <span className="t-c1 c-alt">변경한 사람·시각과 사유가 함께 기록됩니다</span>
      <div className="modal-f">
        <button className="btn btn-out" type="button" onClick={onClose} disabled={busy}>
          취소
        </button>
        <button className="btn" type="button" onClick={() => void submit()} disabled={!ready || busy}>
          {busy ? "변경 중" : n && n >= 1 ? `${n.toLocaleString("ko-KR")}개 ${verb}` : verb}
        </button>
      </div>
    </Modal>
  );
}


// ───────── 재고 이력 ─────────
type Movement = {
  id: string;
  productName: string;
  optionName: string;
  delta: number;
  stockAfter: number | null;
  type: "ORDER" | "CANCEL" | "REFUND" | "MANUAL";
  typeLabel: string;
  note: string | null;
  actor: { name: string };
  createdAt: string;
};

const KST_PARTS = { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false } as const;
const kst = new Intl.DateTimeFormat("ko-KR", KST_PARTS);
const kstWithYear = new Intl.DateTimeFormat("ko-KR", { ...KST_PARTS, year: "numeric" });
const kstYear = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", year: "numeric" });
// 올해(KST) 이력은 월·일·시각만, 올해가 아니면 연도를 붙인다
const when = (iso: string) => {
  const d = new Date(iso);
  return kstYear.format(d) === kstYear.format(new Date()) ? kst.format(d) : kstWithYear.format(d);
};

// 누가·언제·왜 바꿨는지(주문·취소·환불·직접 변경). 최근 것부터 50개씩, 「더 보기」로 이어서 불러온다.
// productId·optionId를 주면 그 옵션의 이력만 보여 준다.
function StockHistory({ refreshKey, productId, optionId }: { refreshKey: number; productId?: string; optionId?: string }) {
  const [items, setItems] = useState<Movement[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [more, setMore] = useState(false);
  // 「이력 더 보기」 실패는 지금 목록을 두고 그 자리에서 다시 부르게 한다
  const [moreError, setMoreError] = useState(false);

  // 첫 쪽을 다시 불러올 때마다 세대를 올린다. 늦게 온 옛 응답(새로고침 전 첫 쪽·「더 보기」)은 버려 새 목록을 덮거나 뒤에 붙지 않게 한다
  const gen = useRef(0);
  const load = useCallback(
    async (cursor?: string) => {
      const id = cursor ? gen.current : ++gen.current;
      // 새로고침 중에는 옛 커서로 「더 보기」를 누르지 못하게 숨긴다
      if (!cursor) setNext(null);
      setMoreError(false);
      const qs = [productId && `productId=${productId}`, optionId && `optionId=${optionId}`, "limit=50", cursor && `cursor=${encodeURIComponent(cursor)}`].filter(Boolean).join("&");
      const r = await api<{ movements: Movement[]; nextCursor: string | null }>(`/api/seller/products/stock-movements?${qs}`);
      if (id !== gen.current) return;
      if (!r.ok) return cursor ? setMoreError(true) : setError(true);
      setError(false);
      setItems((prev) => (cursor && prev ? [...prev, ...r.data.movements] : r.data.movements));
      setNext(r.data.nextCursor);
    },
    [productId, optionId],
  );

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const loadMore = async () => {
    if (!next) return;
    setMore(true);
    await load(next);
    setMore(false);
  };

  if (error) return <ErrorState title="재고 이력을 불러오지 못했습니다" onRetry={() => void load()} />;
  if (items === null) return <LoadingRows rows={3} />;
  if (items.length === 0) return <span className="t-l2 c-alt">아직 재고를 변경한 기록이 없습니다</span>;
  return (
    <>
      <ul className="hist-list" data-testid="stock-history">
        {items.map((m) => (
          <li key={m.id} className="row between hist-item" data-testid="history-item">
            <span className="row" style={{ gap: 10, minWidth: 0 }}>
              <span className={`bdg nodot ${m.type === "MANUAL" ? "b-warn" : m.type === "ORDER" ? "b-gray" : "b-info"}`} style={{ flex: "none" }}>
                {m.typeLabel}
              </span>
              <span className="col" style={{ gap: 2, minWidth: 0 }}>
                <span className="t-l2 fw6 clamp2">
                  {m.productName} · {m.optionName}
                </span>
                <span className="t-c1 c-alt">
                  {m.actor.name} · {when(m.createdAt)}
                  {m.note ? ` · 사유: ${m.note}` : ""}
                  {m.stockAfter !== null ? ` · 남은 재고 ${m.stockAfter.toLocaleString("ko-KR")}` : ""}
                </span>
              </span>
            </span>
            <span className={`num fw6 ${m.delta > 0 ? "c-pos" : "c-neg"}`} style={{ flex: "none" }}>
              {signed(m.delta)}
            </span>
          </li>
        ))}
      </ul>
      {moreError ? (
        <div className="row center" style={{ gap: 8, flexWrap: "wrap" }} role="alert">
          <span className="t-l2 c-neg">이력을 더 불러오지 못했습니다</span>
          <button className="btn btn-sm btn-out" type="button" disabled={more} onClick={() => void loadMore()}>
            {more ? "불러오는 중" : "다시 불러오기"}
          </button>
        </div>
      ) : (
        next && (
          <button className="btn btn-sm btn-out" type="button" style={{ alignSelf: "center" }} disabled={more} onClick={() => void loadMore()}>
            {more ? "불러오는 중" : "이력 더 보기"}
          </button>
        )
      )}
    </>
  );
}
