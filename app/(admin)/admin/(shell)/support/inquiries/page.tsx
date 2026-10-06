"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ListHead, PageHead, SearchBox, SearchRow, ListTable } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { useScrollRestore } from "../../../../../../lib/client/navigation";
import { adminApi } from "../../../_components/api";
import { AdminTopbar } from "../../../_components/AdminShell";
import { INQUIRY_CATEGORY, INQUIRY_STATUS, INQUIRY_TABS, type InquiryCategory, type InquiryCounts, type InquiryRow, type InquiryStatus } from "../../../_components/inquiries";
import { dayTime } from "../../../_components/partners";
import { useListFilters } from "../../../_components/useListFilters";

// MA-051 파트너스 문의 목록(GET /api/admin/platform-inquiries, 모든 마스터 역할 조회). 정본: design/project/MA-051.dc.html(FINAL v310).
// 검색 패널(상태·분류·담당) → 목록. 상태 옆 숫자는 서버의 상태별 전체 수. 조건은 「검색」을 눌러 적용하고 주소(?status=&category=&assignee=&sellerId=)에 남는다.
// 답변·종료는 상세(MA-052)에서 한다(최고관리자·CS). 마지막 글 최신 순 50건씩 이어서 불러오고, 파트너스 지정(?sellerId=)을 받는다.
type Page = { items: InquiryRow[]; counts: InquiryCounts; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; items: InquiryRow[]; counts: InquiryCounts; next: string | null };
const CATEGORIES = ["BROADCAST", "PAYMENT_LINK", "ORDER_REFUND", "REWARD", "SUBSCRIPTION_FEE", "SHOP", "ACCOUNT", "OTHER"] as const satisfies readonly InquiryCategory[];
const ASSIGNEES = [
  ["", "전체"],
  ["me", "나"],
  ["none", "미배정"],
] as const;
const EMPTY = { status: "OPEN", category: "", assignee: "", sellerId: "" };
// 접수 뒤 지난 시간(답변을 기다리는 문의만): 「42분」「5시간 50분」「1일 2시간」
function elapsed(from: string, now: number): string {
  const min = Math.max(0, Math.floor((now - new Date(from).getTime()) / 60_000));
  if (min < 60) return `${min}분`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}시간${min % 60 ? ` ${min % 60}분` : ""}`;
  return `${Math.floor(h / 24)}일${h % 24 ? ` ${h % 24}시간` : ""}`;
}

function Inquiries() {
  // 적용된 조건은 주소 쿼리가 기준이다(상세 → Back에서 그대로 돌아온다). 없는 상태 값은 기본(답변 대기)으로 본다.
  const { applied, draft, setDraft, apply } = useListFilters(EMPTY);
  const { sellerId } = applied;
  const tab = (INQUIRY_TABS as string[]).includes(applied.status) ? (applied.status as InquiryStatus | "") : "OPEN";
  const category = (CATEGORIES as readonly string[]).includes(applied.category) ? applied.category : "";
  const assignee = ["me", "none"].includes(applied.assignee) ? applied.assignee : "";
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const reqId = useRef(0);
  const qs = useCallback(
    (cursor?: string) => {
      const p = new URLSearchParams();
      if (tab) p.set("status", tab);
      if (category) p.set("category", category);
      if (assignee) p.set("assignee", assignee);
      if (sellerId) p.set("sellerId", sellerId);
      if (cursor) p.set("cursor", cursor);
      return p.toString();
    },
    [tab, category, assignee, sellerId],
  );
  const load = useCallback(async () => {
    const id = ++reqId.current;
    setMore(false);
    setState({ kind: "loading" });
    const r = await adminApi<Page>(`/api/admin/platform-inquiries?${qs()}`);
    if (id !== reqId.current) return;
    setNow(Date.now());
    setState(r.ok ? { kind: "ok", items: r.data.items, counts: r.data.counts, next: r.data.nextCursor } : { kind: "error" });
  }, [qs]);
  useEffect(() => void load(), [load]);
  useScrollRestore("admin-inquiries", state.kind === "ok");

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    const id = reqId.current;
    const r = await adminApi<Page>(`/api/admin/platform-inquiries?${qs(state.next)}`);
    if (id !== reqId.current) return;
    setMore(false);
    if (r.ok) setState({ ...state, items: [...state.items, ...r.data.items], next: r.data.nextCursor });
    else setToast("더 불러오지 못했습니다. 다시 눌러 주십시오.");
  };

  const counts = state.kind === "ok" ? state.counts : null;
  const total = counts ? counts.OPEN + counts.ANSWERED + counts.CLOSED : null;
  const items = state.kind === "ok" ? state.items : [];
  const filtered = category !== "" || assignee !== "";
  const search = () => apply({ ...draft, status: draft.status || "", sellerId });
  const reset = () => apply({ ...EMPTY, sellerId });
  const radio = (name: string, key: "status" | "category" | "assignee", value: string, label: React.ReactNode) => (
    <label key={`${key}-${value}`} className="chk">
      <input className="chkbox" type="radio" name={name} checked={draft[key] === value} onChange={() => setDraft({ ...draft, [key]: value })} />
      {label}
    </label>
  );

  return (
    <>
      <AdminTopbar crumb="고객지원 › 파트너스 문의" />
      <main className="main">
        <PageHead description="파트너스 문의를 조건별로 조회하고 답변이 필요한 문의를 확인합니다." title="파트너스 문의" />
        <div className="col" style={{ gap: 20 }}>
          <SearchBox onSearch={search} onReset={reset} busy={state.kind === "loading"}>
            <SearchRow label="상태">
              {INQUIRY_TABS.map((t) => radio("f-status", "status", t, `${t === "" ? "전체" : INQUIRY_STATUS[t].label}${counts ? ` ${t === "" ? total : counts[t]}` : ""}`))}
            </SearchRow>
            <SearchRow label="분류">
              {radio("f-category", "category", "", "전체")}
              {CATEGORIES.map((c) => radio("f-category", "category", c, INQUIRY_CATEGORY[c]))}
            </SearchRow>
            <SearchRow label="담당">{ASSIGNEES.map(([v, l]) => radio("f-assignee", "assignee", v, l))}</SearchRow>
          </SearchBox>
          {sellerId && (
            <div className="row" style={{ gap: 8 }}>
              <span className="t-l2 c-alt">한 파트너스의 문의만 보고 있습니다.</span>
              <Link className="btn btn-sm btn-out" href="/admin/support/inquiries">
                전체 보기
              </Link>
            </div>
          )}
          <div className="au-list-section">
            {state.kind === "loading" && <LoadingRows rows={5} />}
            {state.kind === "error" && <ErrorState title="파트너스 문의를 불러오지 못했습니다." onRetry={() => void load()} />}
            {state.kind === "ok" &&
              (items.length === 0 ? (
                <div className="st">
                  <span className="t">{filtered ? "조건에 맞는 문의가 없습니다." : tab === "OPEN" ? "답변을 기다리는 문의가 없습니다." : "문의가 없습니다."}</span>
                </div>
              ) : (
                <>
                  <ListHead total={items.length} loaded={state.next !== null} />
                  <ListTable>
                    <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                      <thead>
                        <tr>
                          <th>제목</th>
                          <th>파트너스</th>
                          <th>분류</th>
                          <th>접수</th>
                          <th>경과</th>
                          <th>담당</th>
                          <th>상태</th>
                          <th>관리</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((r) => (
                          <tr key={r.id} data-testid="inquiry-row">
                            <td className="col-text">
                              {r.urgent && <span className="bdg b-fail">긴급</span>} {r.title}
                            </td>
                            <td>
                              <b>{r.shopName}</b>
                            </td>
                            <td>{INQUIRY_CATEGORY[r.category]}</td>
                            <td>{dayTime(r.createdAt)}</td>
                            <td>{r.status === "OPEN" ? elapsed(r.createdAt, now) : "—"}</td>
                            <td>{r.assignee?.name ?? "—"}</td>
                            <td>
                              <span className={`bdg ${INQUIRY_STATUS[r.status].cls}`}>{INQUIRY_STATUS[r.status].label}</span>
                            </td>
                            <td>
                              <Link className="btn btn-sm btn-out btn-level-table" href={`/admin/support/inquiries/${r.id}`}>
                                {r.status === "CLOSED" ? "보기" : "답변"}
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </ListTable>
                  {state.next && (
                    <div className="row" style={{ justifyContent: "center", padding: "12px 16px" }}>
                      <button className="btn btn-sm btn-out" type="button" onClick={() => void loadMore()} disabled={more}>
                        {more ? "불러오는 중" : "더 보기"}
                      </button>
                    </div>
                  )}
                </>
              ))}
          </div>
        </div>
      </main>
      {toast && <Toast text={toast} neg onDone={() => setToast(null)} />}
    </>
  );
}

export default function InquiriesPage() {
  return (
    <Suspense fallback={null}>
      <Inquiries />
    </Suspense>
  );
}
