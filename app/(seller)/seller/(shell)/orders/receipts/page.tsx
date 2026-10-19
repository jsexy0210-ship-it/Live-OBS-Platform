"use client";

import "../../../../../../styles/seller-orders.css";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CursorPagination, DateRangePicker, FormFoot, FormRow, FormSection, ListHead, PageHead, SearchBox, SearchRow } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import { won } from "../../../../../../components/seller/format";
import { RECEIPT_BADGE as BADGE, RECEIPT_KIND as KIND, receiptNote as note, type ReceiptRow as Row, type ReceiptStatus as Status } from "../../../../../../components/seller/orders";
import { useScrollRestore, useUrlState } from "../../../../../../lib/client/navigation";
import { kstText } from "../../banners/_shared/ui";
import "./receipts.css";

// SA-024 영수증 · 세금계산서(파트너스 관리자, 주문 › 영수증 · 세금계산서). 무통장 · 계좌이체 주문에서 구매자가 신청한 현금영수증 · 세금계산서의 발행 상태를 보고, 실패 · 보류한 건을 다시 발행(대기로)한다.
// API: GET /api/seller/receipt-requests(?status=PENDING|ON_HOLD|ISSUED|FAILED|CANCELLED · cursor, 상태별 건수 counts), POST /api/seller/receipt-requests/[id]/retry. 조회 · 처리는 대표자 · 「영수증 · 세금계산서」(RECEIPT_TAX) 권한 직원.
type Summary = { pending: number; failed: number; cancelled: number; issuedThisMonth: number; issuedAmountThisMonth: number };
type List = { requests: Row[]; nextCursor: string | null; counts: Partial<Record<Status, number>>; summary: Summary };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; rows: Row[]; next: string | null; counts: List["counts"]; summary: Summary };
type Filter = { from: string; to: string; kind: string; status: string; field: string; q: string };

const STATUS_OPTIONS: { key: Status | ""; label: string }[] = [
  { key: "", label: "전체" },
  { key: "PENDING", label: "발행 대기" },
  { key: "ON_HOLD", label: "보류" },
  { key: "ISSUED", label: "발행 완료" },
  { key: "FAILED", label: "실패" },
  { key: "CANCELLED", label: "취소" },
];
const KIND_OPTIONS = [
  ["", "전체"],
  ["CASH_RECEIPT", "현금영수증"],
  ["TAX_INVOICE", "세금계산서"],
] as const;
const FIELD_OPTIONS = [
  ["nickname", "닉네임"],
  ["bizno", "사업자등록번호"],
  ["phone", "휴대폰 번호"],
] as const;
const EMPTY: Filter = { from: "", to: "", kind: "", status: "", field: "nickname", q: "" };
const todayMonth = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 7);

export default function ReceiptsPage() {
  const { can } = useSeller();
  const canEdit = can("RECEIPT_TAX");
  // 조건은 주소(?from·to·kind·status·field·q)가 기준이다(Back 규칙)
  const [u, setU] = useUrlState({ ...EMPTY });
  const applied: Filter = { from: u.from, to: u.to, kind: u.kind, status: u.status, field: u.field || "nickname", q: u.q };
  const [filter, setFilter] = useState<Filter>(applied);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<{ saved: "DIRECT" | "AUTO"; draft: "DIRECT" | "AUTO" } | null>(null);
  const paging = useRef(false);
  const reqId = useRef(0);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const query = new URLSearchParams(Object.entries(applied).filter(([k, v]) => v && !(k === "field" && !applied.q))).toString();

  const load = useCallback(async (q: string) => {
    const id = ++reqId.current;
    setPage(1);
    setCursors([undefined]);
    paging.current = false;
    setPicked(new Set());
    setState({ kind: "loading" });
    const r = await api<List>(`/api/seller/receipt-requests${q ? `?${q}` : ""}`);
    if (id !== reqId.current) return;
    if (!r.ok) return setState({ kind: "error", status: r.status });
    setState({ kind: "ok", rows: r.data.requests, next: r.data.nextCursor, counts: r.data.counts, summary: r.data.summary });
  }, []);
  useEffect(() => {
    void load(query);
  }, [query, load]);
  useEffect(() => setFilter(applied), [u.from, u.to, u.kind, u.status, u.field, u.q]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void (async () => {
      const r = await api<{ issueMode: "DIRECT" | "AUTO" }>("/api/seller/receipt-setting");
      if (r.ok) setMode({ saved: r.data.issueMode, draft: r.data.issueMode });
    })();
  }, []);
  useScrollRestore("seller-receipts", state.kind === "ok");

  const turnPage = async (target: number) => {
    if (state.kind !== "ok" || paging.current || target === page || target < 1 || target > cursors.length + 1) return;
    const cursor = target <= cursors.length ? cursors[target - 1] : state.next;
    if (target > 1 && !cursor) return;
    paging.current = true;
    const id = ++reqId.current;
    const r = await api<List>("/api/seller/receipt-requests?" + (query ? query + "&" : "") + (cursor ? "cursor=" + encodeURIComponent(cursor) : ""));
    if (id !== reqId.current) return;
    paging.current = false;
    if (!r.ok) return setToast({ text: "불러오지 못했습니다. 다시 눌러 주십시오", neg: true });
    setState({ kind: "ok", rows: r.data.requests, next: r.data.nextCursor, counts: r.data.counts, summary: r.data.summary });
    setPicked(new Set());
    setPage(target);
    setCursors((c) => {
      const visited = target > c.length ? [...c, cursor ?? undefined] : c;
      return visited[target] && visited[target] !== r.data.nextCursor ? visited.slice(0, target) : visited;
    });
  };

  const saveMode = async () => {
    if (!mode) return;
    setBusy(true);
    const r = await api<{ issueMode: "DIRECT" | "AUTO" }>("/api/seller/receipt-setting", { method: "PUT", body: { issueMode: mode.draft } });
    setBusy(false);
    if (!r.ok) return setToast({ text: r.message ?? "저장하지 못했습니다. 잠시 뒤 다시 시도해 주십시오", neg: true });
    setMode({ saved: r.data.issueMode, draft: r.data.issueMode });
    setToast({ text: "발행 방식을 저장했습니다" });
  };

  const summary = state.kind === "ok" ? state.summary : null;
  const counts = state.kind === "ok" ? state.counts : {};
  const rows = state.kind === "ok" ? state.rows : [];
  const rowsLoaded = rows.length;
  // 서버의 counts는 조건과 상관없는 전체 건수다. 상태만 걸었을 때는 그 건수가 맞고, 기간 · 종류 · 검색어를 걸면 알 수 없어 불러온 줄 수로 보여 준다
  const narrowed = !!(applied.from || applied.to || applied.kind || applied.q);
  const statusCount = applied.status ? (counts[applied.status as Status] ?? 0) : (Object.values(counts) as number[]).reduce((a, b) => a + b, 0);
  const total = narrowed ? rowsLoaded : statusCount;
  const pendingRows = rows.filter((r) => r.issue?.status === "PENDING");
  const allPicked = pendingRows.length > 0 && pendingRows.every((r) => picked.has(r.id));
  const exportParams = new URLSearchParams(Object.entries(applied).filter(([k, v]) => v && !(k === "field" && !applied.q)));
  exportParams.set("month", todayMonth());
  const tiles: [string, string][] = summary
    ? [
        ["발행 대기", `${summary.pending}건`],
        ["발행 완료 (이번 달)", `${summary.issuedThisMonth}건`],
        ["실패", `${summary.failed}건`],
        ["취소", `${summary.cancelled}건`],
        ["발행 금액 합계", won(summary.issuedAmountThisMonth)],
      ]
    : [];

  return (
    <>
      <Topbar crumb="주문 › 영수증 · 세금계산서" />
      <main className="main">
        <PageHead
          title="영수증 · 세금계산서"
          actions={
            <Link className="btn btn-out" href="/seller/orders/deposits">
              입금 확인
            </Link>
          }
        />
        <span className="t-c1 c-alt">무통장 · 계좌이체 주문에서 구매자가 신청한 현금영수증 · 세금계산서입니다. 카드 결제는 카드 매출전표로 확인합니다.</span>
        {tiles.length > 0 && (
          <div className="rc-sum" data-testid="receipt-summary">
            {tiles.map(([k, v]) => (
              <div key={k}>
                <div className="k">{k}</div>
                <div className="v num">{v}</div>
              </div>
            ))}
          </div>
        )}

        <SearchBox
          onSearch={() => setU({ ...filter, q: filter.q.trim() })}
          onReset={() => {
            setFilter(EMPTY);
            setU(EMPTY);
          }}
        >
          <SearchRow label="기간">
            <DateRangePicker quick fromLabel="시작일" toLabel="종료일" from={filter.from} to={filter.to} onChange={(r) => setFilter({ ...filter, ...r })} />
          </SearchRow>
          <SearchRow
            label="종류"
            label2="상태"
            children2={STATUS_OPTIONS.map((o) => (
              <label key={o.key} className="chk">
                <input className="rdo" type="radio" name="rc-status" checked={filter.status === o.key} onChange={() => setFilter({ ...filter, status: o.key })} />
                {o.label}
              </label>
            ))}
          >
            {KIND_OPTIONS.map(([k, label]) => (
              <label key={k} className="chk">
                <input className="rdo" type="radio" name="rc-kind" checked={filter.kind === k} onChange={() => setFilter({ ...filter, kind: k })} />
                {label}
              </label>
            ))}
          </SearchRow>
          <SearchRow label="검색어">
            <select className="inp" aria-label="검색 항목" value={filter.field} onChange={(e) => setFilter({ ...filter, field: e.target.value })}>
              {FIELD_OPTIONS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <input className="inp" aria-label="검색어" placeholder="검색어 입력" maxLength={50} value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
          </SearchRow>
        </SearchBox>

        <div style={{ marginTop: 16 }}>
          <ListHead
            total={total}
            loaded={narrowed}
            actions={
              <>
                {canEdit && (
                  picked.size > 0 ? <Link className="btn btn-sm btn-out" href={`/seller/orders/receipts/complete?ids=${encodeURIComponent([...picked].join(","))}`}>선택 발행 완료 처리 ({picked.size})</Link> : <button className="btn btn-sm btn-out" type="button" disabled>선택 발행 완료 처리</button>
                )}
                <a className="btn btn-sm btn-out" href={`/api/seller/receipt-requests/export?${exportParams}`} download>
                  이번 달 내려받기
                </a>
              </>
            }
          />
          <div className="card" style={{ overflow: "visible" }}>
            {state.kind === "loading" && <LoadingRows rows={5} />}
            {state.kind === "error" &&
              (state.status === 403 ? <NoPermission need="영수증 · 세금계산서" /> : state.status === 402 ? <Locked /> : <ErrorState title="목록을 불러오지 못했습니다" onRetry={() => void load(query)} />)}
            {state.kind === "ok" && rows.length === 0 && (
              <div className="st" style={{ boxShadow: "none" }}>
                <div className="st-ic">0</div>
                <span className="t">신청 내역이 없습니다</span>
                <span className="s">무통장 주문서에서 현금영수증 · 세금계산서를 신청하면 여기에 들어옵니다</span>
              </div>
            )}
            {state.kind === "ok" && rows.length > 0 && (
              <div className="au-lt-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      {canEdit && (
                        <th style={{ width: 36 }}>
                          <input className="cbx" type="checkbox" aria-label="발행 대기 모두 선택" disabled={pendingRows.length === 0} checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(pendingRows.map((r) => r.id)))} />
                        </th>
                      )}
                      <th className="col-text" style={{ textAlign: "left" }}>
                        닉네임
                      </th>
                      <th style={{ width: 150 }}>접수 시각</th>
                      <th>종류</th>
                      <th style={{ width: 110, textAlign: "right" }}>금액</th>
                      <th style={{ width: 90 }}>상태</th>
                      <th className="col-text" style={{ textAlign: "left" }}>
                        비고
                      </th>
                      {canEdit && <th style={{ width: 130 }}>관리</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} data-testid="receipt-row">
                        {canEdit && (
                          <td>
                            <input
                              className="cbx"
                              type="checkbox"
                              aria-label={`${r.nickname ?? "탈퇴 회원"} 선택`}
                              disabled={r.issue?.status !== "PENDING"}
                              checked={picked.has(r.id)}
                              onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })}
                            />
                          </td>
                        )}
                        <td className="col-text">
                          <Link href={`/seller/orders/receipts/${r.id}`} className="fw6">
                            {r.nickname ?? "탈퇴 회원"}
                          </Link>
                          <div className="t-c1 c-alt num">{r.orderNoLabel}</div>
                        </td>
                        <td className="num">{kstText(r.createdAt)}</td>
                        <td>
                          {KIND[r.kind]}
                          <div className="t-c1 c-alt num">
                            {r.taxInfo ? `${r.taxInfo.companyName} · ` : ""}번호 끝 {r.identityLast4}
                          </div>
                        </td>
                        <td className="num" style={{ textAlign: "right" }}>
                          {r.issue ? won(r.issue.amount) : "—"}
                        </td>
                        <td>{r.issue ? <span className={`bdg ${BADGE[r.issue.status].cls}`}>{BADGE[r.issue.status].label}</span> : "—"}</td>
                        <td className="col-text">{note(r)}</td>
                        {canEdit && (
                          <td>
                            <div className="acts2">
                              {r.issue?.status === "PENDING" ? (
                                <Link className="btn btn-sm" href={`/seller/orders/receipts/${r.id}`}>
                                  발행 완료 처리
                                </Link>
                              ) : r.issue && (r.issue.status === "FAILED" || r.issue.status === "ON_HOLD") ? (
                                <Link className="btn btn-sm" href={`/seller/orders/receipts/${r.id}`}>
                                  다시 발행
                                </Link>
                              ) : r.issue?.status === "ISSUED" ? (
                                <Link className="btn btn-sm btn-out" href={`/seller/orders/receipts/${r.id}`}>
                                  보기
                                </Link>
                              ) : (
                                "—"
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          {state.kind === "ok" && (page > 1 || state.next) && <CursorPagination page={page} visited={cursors.length} hasNext={!!state.next} onChange={(n) => void turnPage(n)} onNext={() => void turnPage(page + 1)} />}
        </div>
        <span className="t-c1 c-alt" style={{ display: "block", marginTop: 12 }}>
          무통장 · 계좌이체 주문의 신청 내역입니다 · 발행 완료 처리를 누르면 구매자에게 알림이 갑니다 · 환불되면 자동으로 「발행 취소」가 됩니다 · 이미 발행한 세금계산서는 수정 세금계산서로 처리합니다
        </span>

        {mode && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveMode();
            }}
          >
            <FormSection title="발행 방식">
              <FormRow label="방식">
                <label className="chk">
                  <input className="rdo" type="radio" name="issueMode" checked={mode.draft === "DIRECT"} disabled={!canEdit} onChange={() => setMode({ ...mode, draft: "DIRECT" })} />
                  직접 발행 후 완료 처리 (홈택스 등에서 발행하고 목록에서 「발행 완료 처리」)
                </label>
                <label className="chk">
                  <input className="rdo" type="radio" name="issueMode" checked={mode.draft === "AUTO"} disabled onChange={() => undefined} />
                  자동 발행 (연동 후 · 입금 확인과 동시에 발행) <span className="bdg b-gray nodot">준비 중</span>
                </label>
              </FormRow>
              <FormRow label="안내">사업자 정보는 구매자가 주문서에 적은 그대로입니다 · 틀렸으면 구매자에게 수정을 요청해 주십시오</FormRow>
            </FormSection>
            {canEdit && (
              <FormFoot>
                <button className="btn btn-lg" type="submit" disabled={busy || mode.draft === mode.saved}>
                  저장
                </button>
              </FormFoot>
            )}
          </form>
        )}
        {state.kind === "ok" && !canEdit && (
          <div className="msg msg-info" role="status">
            <span>보기만 할 수 있습니다. 바꾸려면 대표자에게 「영수증 · 세금계산서」 허용을 요청해 주십시오.</span>
          </div>
        )}
      </main>
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
