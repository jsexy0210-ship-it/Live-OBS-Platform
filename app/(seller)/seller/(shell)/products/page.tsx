"use client";

import { formatDateTimeParts } from "../../../../../lib/client/format";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useScrollRestore, useUrlState } from "../../../../../lib/client/navigation";
import { CursorPagination, ListHead, ListTable, PageHead, SearchBox, SearchRow } from "../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { categoryLabel, categoryOptions, type CategoryNode } from "../../../../../components/seller/ProductCategoryPicker";
import { ErrorState, LoadingRows, Locked, NoImage, NoPermission, Toast } from "../../../../../components/seller/States";
import { api, type Product, type ProductStatus } from "../../../../../components/seller/api";
import { LOW_STOCK, MAX_SEARCH_LENGTH, statusBadge, textLength, totalStock, won } from "../../../../../components/seller/format";
import { recentRange } from "../../../../../lib/client/dateInput";
import { PERIOD_ALL } from "../../../../../lib/client/filterDefaults";
import { DatePicker } from "../../../../../components/admin-ui/DatePicker";
import styles from "./products.module.css";

// SA-011 상품 목록(업무용 관리 화면). 위쪽 표형 검색 상자에서 조건을 정해 「검색」을 누르면 걸러 보고, 이어서 불러온다(현재 10개씩).
// 정렬·페이지 크기는 바꾸는 즉시 적용한다. 체크한 상품의 변경은 선택 상품 작업 상세로 이동해 확정한다.
const FILTERS: { key: ProductStatus | "ALL"; label: string }[] = [
  { key: "ALL", label: "전체" },
  { key: "ON_SALE", label: "판매 중" },
  // 판매 상태를 「품절」로 정한 상품만. 판매 중인데 재고가 0인 상품은 「판매 중」 탭에 「재고 없음」 배지로 보인다
  { key: "SOLD_OUT", label: "품절로 설정" },
  { key: "HIDDEN", label: "숨김" },
  { key: "DRAFT", label: "임시 저장" },
];

type StockFilter = "out" | "low";
// 서버 기준과 같다: 재고 없음 = 옵션 재고 합계 0, 재고 부족 = 1~5(목록 배지 「재고 없음」·「재고 부족」과 같은 기준)
const STOCK_FILTERS: { key: StockFilter; label: string }[] = [
  { key: "out", label: "재고 없음" },
  { key: "low", label: "재고 부족" },
];
type Display = "" | "shown" | "hidden";
const DISPLAYS: { key: Display; label: string }[] = [
  { key: "", label: "전체" },
  { key: "shown", label: "쇼핑몰에 보임" },
  { key: "hidden", label: "안 보임" },
];
type Deduct = "" | "ORDER" | "PAYMENT";
const DEDUCTS: { key: Deduct; label: string }[] = [
  { key: "", label: "전체" },
  { key: "PAYMENT", label: "결제하면 줄임" },
  { key: "ORDER", label: "주문하면 바로 줄임" },
];
type Sort = "newest" | "sales" | "price_asc" | "price_desc";
const SORTS: { key: Sort; label: string }[] = [
  { key: "newest", label: "최근 등록순" },
  { key: "sales", label: "판매량순" },
  { key: "price_desc", label: "판매가 높은순" },
  { key: "price_asc", label: "판매가 낮은순" },
];
const LIMITS = [10];


// 검색 상자에 정하는 조건. 입력 중인 값(draft)과 「검색」을 눌러 적용한 값(applied)을 따로 둔다
type Filters = {
  status: ProductStatus | "ALL";
  stock: StockFilter | null;
  // 검색어 종류: name = 상품·옵션 이름(q, 50자까지), code = 상품 코드·SKU(code, 64자까지)
  mode: "name" | "code";
  text: string;
  categoryId: string;
  display: Display;
  deduct: Deduct;
  from: string;
  to: string;
};
// 기본값 정본 lib/client/filterDefaults.ts: 등록일은 처음부터 최근 1개월이 채워져 있고, 초기화도 이 값으로 돌아간다
const emptyFilters = (): Filters => ({ status: "ALL", stock: null, mode: "name", text: "", categoryId: "", display: "", deduct: "", ...recentRange(1) });

const query = (f: Filters, sort: Sort, limit: number) =>
  [
    f.status === "ALL" ? "" : `status=${f.status}`,
    f.stock ? `stock=${f.stock}` : "",
    f.text ? `${f.mode === "name" ? "q" : "code"}=${encodeURIComponent(f.text)}` : "",
    f.categoryId ? `categoryId=${f.categoryId}` : "",
    f.display ? `display=${f.display}` : "",
    f.deduct ? `stockDeductMode=${f.deduct}` : "",
    f.from ? `createdFrom=${f.from}` : "",
    f.to ? `createdTo=${f.to}` : "",
    sort === "newest" ? "" : `sort=${sort}`,
    `limit=${limit}`,
  ]
    .filter(Boolean)
    .join("&");

// 주소에 싣는 값(기본값과 같으면 쿼리에서 뺀다). 알 수 없는 값은 읽을 때 기본값으로 돌린다
const urlDefaults = () => ({ q: "", mode: "name", status: "ALL", stock: "", categoryId: "", display: "", deduct: "", ...recentRange(1), period: "", sort: "newest", limit: "10" });
const oneOf = <T extends string>(v: string, list: readonly T[], fallback: T): T => ((list as readonly string[]).includes(v) ? (v as T) : fallback);

const TOASTS: Record<string, string> = {
  created: "상품을 등록했습니다",
  draft: "임시 저장했습니다",
  deleted: "상품을 삭제했습니다",
  created_partial: "상품을 등록했습니다. 카테고리나 이미지 일부를 저장하지 못했으니 상품 수정에서 확인해 주십시오",
};

type Page = { products: Product[]; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error"; status: number; message?: string } | { kind: "ok"; items: Product[]; next: string | null };
// 등록일은 한국 시간 기준 월/일
// 한국 날짜(YYYY-MM-DD). days만큼 앞뒤로 옮긴다
const kstDate = (offsetDays = 0, offsetMonths = 0) => {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  if (offsetMonths) d.setMonth(d.getMonth() + offsetMonths);
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(d);
};
const optionSummary = (p: Product) => (p.options.length === 0 ? "선택 항목 없음" : p.options.map((o) => o.name).join(" · "));
const isShown = (p: Product) => p.status === "ON_SALE" || p.status === "SOLD_OUT";

export default function ProductListPage() {
  const { can } = useSeller();
  // 적용한 조건·정렬·개수는 주소(쿼리)가 기준이다. 상세에 갔다 Back으로 돌아와도 그대로 복원된다(IA Back 규칙 3항)
  const [u, setU] = useUrlState(urlDefaults());
  const searchParams = useSearchParams().toString();
  const returnTo = `/seller/products${searchParams ? `?${searchParams}` : ""}`;
  const applied: Filters = {
    status: oneOf(u.status, FILTERS.map((f) => f.key), "ALL"),
    stock: u.stock === "out" || u.stock === "low" ? u.stock : null,
    mode: oneOf(u.mode, ["name", "code"], "name"),
    text: u.q,
    categoryId: u.categoryId,
    display: oneOf(u.display, DISPLAYS.map((d) => d.key), ""),
    deduct: oneOf(u.deduct, DEDUCTS.map((d) => d.key), ""),
    ...(u.period === PERIOD_ALL ? { from: "", to: "" } : { from: u.from, to: u.to }),
  };
  const sort = oneOf(u.sort, SORTS.map((x) => x.key), "newest");
  const limit = Number(oneOf(u.limit, LIMITS.map(String), "10"));
  const key = query(applied, sort, limit);
  const appliedJson = JSON.stringify(applied);
  const [draft, setDraft] = useState<Filters>(applied);
  // 주소가 밖에서 바뀌면(Back 등) 입력 중인 값도 적용된 조건으로 맞춘다. 「검색」「초기화」로 이 화면이 직접 바꾼 주소는 입력 칸을 건드리지 않는다
  // (초기화 직후 새 검색어를 입력하는 중에 주소 변경이 늦게 반영돼도 입력이 지워지지 않게)
  const pushed = useRef<string | null>(null);
  useEffect(() => {
    if (pushed.current === appliedJson) return;
    pushed.current = appliedJson;
    setDraft(JSON.parse(appliedJson) as Filters);
  }, [appliedJson]);
  const [cats, setCats] = useState<CategoryNode[]>([]);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const paging = useRef(false);
  const [toast, setToast] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toUrl = (f: Filters) => ({ q: f.text, mode: f.mode, status: f.status, stock: f.stock ?? "", categoryId: f.categoryId, display: f.display, deduct: f.deduct, from: f.from, to: f.to, period: "" });
  const apply = () => {
    const next = { ...draft, text: draft.text.trim() };
    // 같은 조건으로 다시 누르면 주소가 안 바뀌므로 목록만 다시 읽는다
    if (JSON.stringify(next) === appliedJson) void load(key);
    else {
      pushed.current = JSON.stringify(next);
      setU(toUrl(next));
    }
  };
  const resetAll = () => {
    const empty = emptyFilters();
    setDraft(empty);
    pushed.current = JSON.stringify(empty);
    setU(toUrl(empty));
  };

  // 카테고리 칸은 상품 목록이 열린 뒤 한 번만 읽는다(목록이 요금제·권한으로 막힌 화면에서 쓸데없이 요청하지 않게)
  const catsLoaded = useRef(false);
  const listOk = state.kind === "ok";
  useEffect(() => {
    if (!listOk || catsLoaded.current) return;
    catsLoaded.current = true;
    // 없어도 목록은 쓸 수 있는 보조 조회라 실패(권한·요금제 포함)는 조용히 넘기고, 요금제 안내 화면을 띄우지 않도록 api() 대신 직접 읽는다
    void fetch("/api/seller/categories", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ categories: CategoryNode[] }>) : null))
      .then((d) => d && setCats(d.categories))
      .catch(() => undefined);
  }, [listOk]);

  // 조건을 빨리 바꾸면 이전 응답이 늦게 올 수 있다. 마지막으로 보낸 요청의 응답만 화면에 반영한다
  const reqId = useRef(0);
  const load = useCallback(async (qs: string) => {
    const id = ++reqId.current;
    setPage(1); setCursors([undefined]); paging.current = false;
    setState({ kind: "loading" });
    setSelected(new Set());
    const r = await api<Page>(`/api/seller/products${qs ? `?${qs}` : ""}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", items: r.data.products, next: r.data.nextCursor } : { kind: "error", status: r.status, message: r.message });
  }, []);

  useEffect(() => {
    void load(key);
  }, [key, load]);
  useScrollRestore("seller-products", listOk);

  // 등록·삭제 뒤 돌아오면 한 번 알려 주고 주소에서 지운다
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("toast");
    if (t && TOASTS[t]) {
      setToast(TOASTS[t]);
      const rest = new URLSearchParams(window.location.search);
      rest.delete("toast");
      window.history.replaceState(null, "", rest.size ? `/seller/products?${rest}` : "/seller/products");
    }
  }, []);

  const turnPage = async (target: number) => {
    if (state.kind !== "ok" || paging.current || target === page || target < 1 || target > cursors.length + 1) return;
    const cursor = target <= cursors.length ? cursors[target - 1] : state.next;
    if (target > 1 && !cursor) return;
    paging.current = true;
    const id = ++reqId.current;
    const qs = key + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
    const r = await api<Page>("/api/seller/products?" + qs);
    if (id !== reqId.current) return;
    paging.current = false;
    if (!r.ok) return setToast("불러오지 못했습니다. 다시 눌러 주십시오");
    setSelected(new Set()); setState({ kind: "ok", items: r.data.products, next: r.data.nextCursor });
    setPage(target); setCursors(c => {
      const visited = target > c.length ? [...c, cursor ?? undefined] : c;
      return visited[target] && visited[target] !== r.data.nextCursor ? visited.slice(0, target) : visited;
    });
  };

  const canManage = can("PRODUCT_MANAGE");
  const items = state.kind === "ok" ? state.items : [];
  const appliedCat = applied.categoryId ? categoryLabel(cats, applied.categoryId) : null;
  const isApplied = JSON.stringify(applied) !== JSON.stringify(emptyFilters());
  // 커서 API는 전체 건수를 주지 않으므로 현재 쪽의 건수만 표시한다
  const countUnit = "건 (현재 쪽)";
  const allChecked = items.length > 0 && items.every((p) => selected.has(p.id));
  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (state.kind === "error" && state.status === 403) {
    return (
      <>
        <Topbar crumb="상품 › 상품 목록" />
        <main className="main"><NoPermission need="상품" /></main>
      </>
    );
  }

  const radios = <T extends string>(label: string, name: string, list: { key: T; label: string }[], value: T, set: (v: T) => void) => (
    <div role="radiogroup" aria-label={label} className="row" style={{ gap: 16, flexWrap: "wrap" }}>
      {list.map((o) => (
        <label key={o.key || "all"} className="chk">
          <input className="rdo" type="radio" name={name} checked={value === o.key} onChange={() => set(o.key)} />
          {o.label}
        </label>
      ))}
    </div>
  );

  return (
    <>
      <Topbar crumb="상품 › 상품 목록" />
      <main className={`main ${styles.page}`}>
        <PageHead
          title="상품 목록"
          description="상품을 검색하고 판매 상태와 재고를 관리합니다."
          actions={
            canManage && (
              <>
                <Link className="btn btn-out" href="/seller/products/stock">
                  재고 관리
                </Link>
                <Link className="btn" href="/seller/products/new">
                  상품 등록
                </Link>
              </>
            )
          }
        />

        <SearchBox label="목록 조건" onSearch={apply} onReset={resetAll}>
          <SearchRow label="검색어">
            <select className="inp inp-sm inp-w-md" aria-label="검색 기준" value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as "name" | "code", text: "" })}>
              <option value="name">상품명 · 선택 항목 이름</option>
              <option value="code">상품 코드</option>
            </select>
            <input
              className="inp inp-sm"
              type="search"
              placeholder="검색어 입력"
              aria-label="상품 검색"
              value={draft.text}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              maxLength={draft.mode === "name" ? MAX_SEARCH_LENGTH : 64}
            />
          </SearchRow>
          {cats.length > 0 && (
            <SearchRow label="카테고리">
              <select className="inp inp-sm inp-w-lg" aria-label="카테고리" value={draft.categoryId} onChange={(e) => setDraft({ ...draft, categoryId: e.target.value })}>
                <option value="">전체</option>
                {categoryOptions(cats).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </SearchRow>
          )}
          <SearchRow label="판매 상태" label2="쇼핑몰 노출" children2={radios("쇼핑몰 노출", "display", DISPLAYS, draft.display, (v) => setDraft({ ...draft, display: v }))}>
            {radios("판매 상태", "status", FILTERS, draft.status, (v) => setDraft({ ...draft, status: v }))}
          </SearchRow>
          <SearchRow label="재고가 줄어드는 때">{radios("재고가 줄어드는 때", "deduct", DEDUCTS, draft.deduct, (v) => setDraft({ ...draft, deduct: v }))}</SearchRow>
          <SearchRow label="등록일" label2="재고" children2={radios("재고", "stock", [{ key: "", label: "전체" }, ...STOCK_FILTERS] as { key: StockFilter | ""; label: string }[], draft.stock ?? "", (v) => setDraft({ ...draft, stock: v === "" ? null : v }))}>
            <span className="row wrap" style={{ gap: 8 }}>
              <button className="btn btn-dense btn-out btn-w-xs" type="button" onClick={() => setDraft({ ...draft, from: kstDate(), to: kstDate() })}>
                오늘
              </button>
              <button className="btn btn-dense btn-out btn-w-xs" type="button" onClick={() => setDraft({ ...draft, from: kstDate(-6), to: kstDate() })}>
                7일
              </button>
              <button className="btn btn-dense btn-out btn-w-xs" type="button" onClick={() => setDraft({ ...draft, from: kstDate(0, -1), to: kstDate() })}>
                1개월
              </button>
              <button className="btn btn-dense btn-out btn-w-xs" type="button" onClick={() => setDraft({ ...draft, from: kstDate(0, -3), to: kstDate() })}>
                3개월
              </button>
              <button className="btn btn-dense btn-out btn-w-xs" type="button" onClick={() => setDraft({ ...draft, from: "", to: "" })}>
                전체
              </button>
            </span>
            <span className="row" style={{ gap: 8 }}>
              <DatePicker className="dt-sm" aria-label="등록일 시작" value={draft.from} onChange={(v) => setDraft({ ...draft, from: v })} />
              <span aria-hidden="true">~</span>
              <DatePicker className="dt-sm" aria-label="등록일 끝" value={draft.to} onChange={(v) => setDraft({ ...draft, to: v })} />
            </span>
          </SearchRow>
        </SearchBox>

        <div className="au-list-section">
          <ListHead
            total={items.length}
            unit={countUnit}
            actions={
              <>
                <select className="inp inp-sm inp-w-md" aria-label="정렬" value={sort} onChange={(e) => setU({ sort: e.target.value })}>
                  {SORTS.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <select className="inp inp-sm inp-w-sm" aria-label="목록 개수" value={limit} onChange={(e) => setU({ limit: e.target.value })}>
                  {LIMITS.map((n) => (
                    <option key={n} value={n}>
                      {n}개씩
                    </option>
                  ))}
                </select>
                {canManage && (selected.size > 0 ? <Link className="btn btn-dense btn-out btn-level-bulk" href={`/seller/products/operations?${new URLSearchParams({ ids: [...selected].join(","), returnTo })}`}>선택 상품 작업 상세</Link> : <button className="btn btn-dense btn-out btn-level-bulk" type="button" disabled>선택 상품 작업 상세</button> )}
              </>
            }
          />

          {state.kind === "loading" && <LoadingRows />}
          {state.kind === "error" &&
            (state.status === 403 ? (
              <NoPermission need="상품" />
            ) : state.status === 402 ? (
              <Locked />
            ) : state.status === 400 ? (
              <div className="st" style={{ boxShadow: "none" }}>
                <div className="st-ic neg">!</div>
                {/* 검색어가 서버 기준(NFKC 뒤 50자)을 넘었으면 길이 안내, 그 밖에는 서버가 알려 준 이유 */}
                <span className="t">
                  {applied.mode === "name" && applied.text && textLength(applied.text.normalize("NFKC").trim()) > MAX_SEARCH_LENGTH
                    ? `검색어는 ${MAX_SEARCH_LENGTH}자까지 입력할 수 있습니다`
                    : applied.mode === "name" && applied.text && !state.message
                      ? "검색어에 사용할 수 없는 글자가 있습니다"
                      : (state.message ?? "검색 조건을 확인해 주십시오")}
                </span>
                <button
                  className="btn btn-sm btn-text"
                  type="button"
                  onClick={() => {
                    setDraft((d) => ({ ...d, text: "" }));
                    setU({ q: "" });
                  }}
                >
                  검색 지우기
                </button>
                <button className="btn btn-sm btn-text" type="button" onClick={resetAll}>
                  조건 초기화
                </button>
              </div>
            ) : (
              <ErrorState title="상품을 불러오지 못했습니다" onRetry={() => void load(key)} />
            ))}
          {state.kind === "ok" && items.length === 0 && (
            <div className="st" style={{ boxShadow: "none" }}>
              <div className="st-ic">+</div>
              {!isApplied ? (
                <>
                  <span className="t">아직 등록된 상품이 없습니다</span>
                  <span className="s">상품을 등록하면 쇼핑몰과 방송 주문대기에 바로 연결됩니다.</span>
                  {canManage && (
                    <Link className="btn btn-sm" href="/seller/products/new">
                      상품 등록
                    </Link>
                  )}
                </>
              ) : (
                <>
                  <span className="t">
                    「
                    {[
                      applied.text || null,
                      applied.status === "ALL" ? null : FILTERS.find((f) => f.key === applied.status)?.label,
                      STOCK_FILTERS.find((f) => f.key === applied.stock)?.label,
                      appliedCat ?? null,
                      applied.display ? DISPLAYS.find((d) => d.key === applied.display)?.label : null,
                      applied.deduct ? DEDUCTS.find((d) => d.key === applied.deduct)?.label : null,
                      applied.from || applied.to ? `${applied.from || "처음"} ~ ${applied.to || "오늘"}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    」에 해당하는 상품이 없습니다
                  </span>
                  <button className="btn btn-sm btn-text" type="button" onClick={resetAll}>
                    전체 보기
                  </button>
                </>
              )}
            </div>
          )}
          {state.kind === "ok" && items.length > 0 && (
            <>
              <ListTable className={`p-tbl-wrap ${styles.grid}`} aria-label="상품 목록 표">
                <table className="tbl p-table">
                  <thead>
                    <tr>
                      {canManage && (
                        <th className="p-w-chk">
                          <input type="checkbox" aria-label="전체 선택" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(items.map((p) => p.id)))} />
                        </th>
                      )}
                      <th className="p-w-img">이미지</th>
                      <th>상품명 · 코드</th>
                      <th className="p-w-price">판매가</th>
                      <th className="p-w-stock">재고</th>
                      <th className="p-w-flag">판매</th>
                      <th className="p-w-flag">보임</th>
                      <th className="p-w-state">상태</th>
                      <th className="p-w-date">등록일</th>
                      {canManage && <th className="p-w-act">관리</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((p) => {
                      const b = statusBadge(p);
                      const stock = totalStock(p);
                      return (
                        <tr key={p.id} className="p-row" data-testid="product-row">
                          {canManage && (
                            <td>
                              <input type="checkbox" aria-label={`${p.name} 선택`} checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                            </td>
                          )}
                          <td>
                            <div className="thumb" title={p.thumbnailUrl ? "대표 이미지" : "이미지 없음"}>
                              {p.thumbnailUrl ? <img src={p.thumbnailUrl} alt="" data-testid="product-thumb" /> : <NoImage />}
                            </div>
                          </td>
                          <td className="col-text">
                            <Link href={`/seller/products/${p.id}`} className="fw6 p-name" style={{ color: "inherit", textDecoration: "none" }}>
                              {p.name}
                            </Link>
                            <div className="t-c1 c-alt ell">{[p.code, optionSummary(p)].filter(Boolean).join(" · ")}</div>
                          </td>
                          <td className="num">{won(p.price)}</td>
                          <td className={`num${stock === 0 ? " c-neg fw6" : stock <= LOW_STOCK ? " c-cau fw6" : ""}`}>
                            {stock.toLocaleString("ko-KR")}
                          </td>
                          <td className="num">{(p.soldQuantity ?? 0).toLocaleString("ko-KR")}</td>
                          <td>{isShown(p) ? "보임" : "안 보임"}</td>
                          <td>
                            <span className={`bdg ${b.cls}`}>{b.label}</span>
                          </td>
                          <td className="num">{formatDateTimeParts(p.createdAt)?.date}
                            <br />
                            {formatDateTimeParts(p.createdAt)?.time}</td>
                          {canManage && (
                            <td>
                              <Link className="btn btn-sm btn-out btn-level-table" href={`/seller/products/${p.id}/operations?${new URLSearchParams({ returnTo })}`}>
                                수정
                              </Link>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </ListTable>
              <ul className="p-cards">
                {items.map((p) => {
                  const b = statusBadge(p);
                  const stock = totalStock(p);
                  return (
                    <li key={p.id}>
                      <Link href={`/seller/products/${p.id}`} className="p-card" data-testid="product-card">
                        <div className="thumb" title={p.thumbnailUrl ? "대표 이미지" : "이미지 없음"}>
                          {p.thumbnailUrl ? <img src={p.thumbnailUrl} alt="" /> : <NoImage size={24} />}
                        </div>
                        <div className="col grow" style={{ gap: 4 }}>
                          <span className="fw6 p-name">{p.name}</span>
                          <span className="t-c1 c-alt ell">{[p.code, optionSummary(p)].filter(Boolean).join(" · ")}</span>
                          <span className="row between" style={{ gap: 8 }}>
                            <span className="fw7 num">{won(p.price)}</span>
                            <span className="row" style={{ gap: 6 }}>
                              <span className={`t-c1 num${stock === 0 ? " c-neg fw6" : stock <= LOW_STOCK ? " c-cau fw6" : " c-alt"}`}>재고 {stock.toLocaleString("ko-KR")}</span>
                              <span className={`bdg ${b.cls}`}>{b.label}</span>
                            </span>
                          </span>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
              {(page > 1 || state.next) && <CursorPagination page={page} visited={cursors.length} hasNext={!!state.next} onChange={n => void turnPage(n)} onNext={() => void turnPage(page + 1)} />}
            </>
          )}
        </div>
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
