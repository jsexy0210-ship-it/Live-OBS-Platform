"use client";

import { CursorPagination } from "../../../../../components/Pagination";

import { formatDateTime } from "../../../../../lib/client/format";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { ListTable, Modal, PageHead, SearchBox, SearchRow } from "../../../../../components/admin-ui";
import { Topbar } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../components/seller/States";
import { api, failMessage } from "../../../../../components/seller/api";
import { useScrollRestore, useUrlState } from "../../../../../lib/client/navigation";
import "./buyer-inquiries.css";
import { recentRange } from "../../../../../lib/client/dateInput";
import { PERIOD_ALL } from "../../../../../lib/client/filterDefaults";
import { DatePicker } from "../../../../../components/admin-ui/DatePicker";

// SA-046 구매자 문의 목록 · SA-047 문의 상세·답변(파트너스 관리자, 게시판 › 구매자 문의).
// API: GET /api/seller/inquiries(?status·kind·from·to·q·cursor), PUT /api/seller/inquiries/{id}/answer { answer | null }.
// 조회는 같은 쇼핑몰 파트너스 계정 누구나(비공개 문의 포함), 답변은 대표자·구매자 문의 권한 직원만(서버가 canEdit으로 알려 줌).
// 상세는 목록 응답의 한 건을 그대로 쓴다(목록이 본문·사진·답변을 모두 내려 준다).
const ANSWER_MAX = 1000;
type Status = "WAITING" | "ANSWERED";
type Kind = "PRODUCT" | "GENERAL";
type Inquiry = {
  id: string;
  kind: Kind;
  product: { id: string; name: string } | null;
  order: { id: string; orderNoLabel: string } | null;
  title: string;
  body: string;
  isPrivate: boolean;
  status: Status;
  answer: string | null;
  answeredAt: string | null;
  createdAt: string;
  authorNickname: string;
  images: { id: string; width: number; height: number; url: string }[];
};
type Data = { inquiries: Inquiry[]; nextCursor: string | null; waitingCount: number; canEdit: boolean };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; data: Data };
type Filter = { status: "" | Status; kind: "" | Kind; from: string; to: string; q: string; period: string };

// 기본값 정본 lib/client/filterDefaults.ts: 작성일은 처음부터 최근 1개월, 초기화도 이 값으로 돌아간다. 홈 「처리할 일」 링크는 ?period=all(기간 전체)로 들어온다
const emptyFilter = (): Filter => ({ status: "", kind: "", q: "", period: "", ...recentRange(1) });
const KIND_LABEL: Record<Kind, string> = { PRODUCT: "상품 문의", GENERAL: "1:1 문의" };
const STATUS_BADGE: Record<Status, { label: string; cls: string }> = {
  WAITING: { label: "답변 대기", cls: "b-wait" },
  ANSWERED: { label: "답변 완료", cls: "b-done" },
};
const TABS: { key: "" | Status; label: string }[] = [
  { key: "", label: "전체" },
  { key: "WAITING", label: "답변 대기" },
  { key: "ANSWERED", label: "답변 완료" },
];

export default function BuyerInquiriesPage() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  // 조건은 URL 쿼리(?status=WAITING&kind=&from=&to=&q=)와 맞춘다: 파트너스 홈 「처리할 일」 링크가 답변 대기로 바로 연다. 틀린 값은 전체로 본다
  const [url, setUrl] = useUrlState(emptyFilter());
  const filter = useMemo<Filter>(
    () => ({
      status: url.status === "WAITING" || url.status === "ANSWERED" ? url.status : "",
      kind: url.kind === "PRODUCT" || url.kind === "GENERAL" ? url.kind : "",
      ...(url.period === PERIOD_ALL ? { from: "", to: "" } : { from: url.from, to: url.to }),
      q: url.q,
      period: url.period === PERIOD_ALL ? PERIOD_ALL : "",
    }),
    [url.status, url.kind, url.from, url.to, url.q, url.period],
  );
  const [draft, setDraft] = useState<Filter>(filter);
  const [cursor, setCursor] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const reqId = useRef(0);
  const paging = useRef(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  const query = useCallback(
    (c?: string | null) => {
      const q = new URLSearchParams();
      if (filter.status) q.set("status", filter.status);
      if (filter.kind) q.set("kind", filter.kind);
      if (filter.from) q.set("from", filter.from);
      if (filter.to) q.set("to", filter.to);
      if (filter.q.trim()) q.set("q", filter.q.trim());
      if (c) q.set("cursor", c);
      return `/api/seller/inquiries?${q.toString()}`;
    },
    [filter],
  );

  const load = useCallback(async () => {
    const id = ++reqId.current; paging.current = true;
    const r = await api<Data>(query());
    if (id !== reqId.current) return;
    paging.current = false;
    if (!r.ok) return setState({ kind: "error", status: r.status });
    setCursor(r.data.nextCursor);
    setState({ kind: "ok", data: r.data }); setPage(1); setCursors([undefined]);
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  const goPage = async (target: number, next = cursors[target - 1]) => {
    if (state.kind !== "ok" || paging.current || target < 1 || target > cursors.length + 1) return;
    paging.current = true;
    const id = reqId.current;
    const r = await api<Data>(query(next));
    if (id !== reqId.current) return;
    paging.current = false;
    if (!r.ok) return setToast({ text: "목록을 불러오지 못했습니다. 다시 눌러 주십시오", neg: true });
    setState({ kind: "ok", data: r.data }); setCursor(r.data.nextCursor);
    setCursors((prev) => [...prev.slice(0, target - 1), next]); setPage(target);
  };

  useScrollRestore("seller-buyer-inquiries", state.kind === "ok");
  const data = state.kind === "ok" ? state.data : null;
  const rows = data?.inquiries ?? [];
  const open = rows.find((x) => x.id === openId) ?? null;
  const invalidRange = draft.from !== "" && draft.to !== "" && draft.from > draft.to;

  const search = () => {
    if (invalidRange) return;
    setUrl({ ...draft, period: "" });
  };
  const setTab = (status: "" | Status) => {
    setDraft((d) => ({ ...d, status }));
    setUrl({ status });
  };

  return (
    <>
      <Topbar crumb="게시판 › 구매자 문의" />
      <main className="main">
        <PageHead title="구매자 문의" />
        {data && !data.canEdit && (
          <div className="msg msg-info" role="status">
            <span>문의 목록만 볼 수 있습니다. 답변은 대표자나 구매자 문의 권한이 있는 직원에게 요청해 주십시오.</span>
          </div>
        )}
        <SearchBox onSearch={search} onReset={() => {
            const empty = { ...emptyFilter(), status: filter.status };
            setDraft(empty);
            setUrl(empty);
          }} label="문의 검색">
          <SearchRow label="작성일">
            <DatePicker aria-label="작성일 시작" value={draft.from} onChange={(v) => setDraft({ ...draft, from: v })} />
            <span aria-hidden="true">~</span>
            <DatePicker aria-label="작성일 끝" value={draft.to} onChange={(v) => setDraft({ ...draft, to: v })} />
            {invalidRange && <span className="help bi-neg">시작일이 끝일보다 늦습니다</span>}
          </SearchRow>
          <SearchRow label="종류">
            <select className="inp" aria-label="문의 종류" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as "" | Kind })}>
              <option value="">전체</option>
              <option value="PRODUCT">상품 문의</option>
              <option value="GENERAL">1:1 문의</option>
            </select>
          </SearchRow>
          <SearchRow label="검색어">
            <input className="inp" aria-label="검색어" placeholder="제목 · 내용 · 작성자 · 상품명" maxLength={50} value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} />
          </SearchRow>
        </SearchBox>

        <section className="au-list-section">
          <div className="tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.key || "all"} className={`tab${filter.status === t.key ? " on" : ""}`} type="button" role="tab" aria-selected={filter.status === t.key} onClick={() => setTab(t.key)}>
                {t.label}
                {t.key === "WAITING" && data ? ` ${data.waitingCount.toLocaleString("ko-KR")}` : ""}
              </button>
            ))}
          </div>
          {state.kind === "loading" && <div className="card"><LoadingRows rows={5} /></div>}
          {state.kind === "error" &&
            (state.status === 403 ? <NoPermission need="구매자 문의" /> : state.status === 402 ? <div className="card"><Locked /></div> : <div className="card"><ErrorState title="구매자 문의를 불러오지 못했습니다" onRetry={() => void load()} /></div>)}
          {data && rows.length === 0 && (
            <div className="card"><div className="st" style={{ boxShadow: "none" }}>
              <div className="st-ic">0</div>
              <span className="t">{filter.status || filter.kind || filter.from || filter.to || filter.q ? "조건에 맞는 문의가 없습니다" : "아직 문의가 없습니다"}</span>
              <span className="s">구매자가 상품 문의나 1:1 문의를 남기면 여기에 표시됩니다.</span>
            </div></div>
          )}
          {data && rows.length > 0 && (
            <ListTable>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>상태</th>
                    <th>종류</th>
                    <th>제목</th>
                    <th>작성자</th>
                    <th>작성일</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} data-testid="inquiry-row">
                      <td>
                        <span className={`bdg ${STATUS_BADGE[r.status].cls}`}>{STATUS_BADGE[r.status].label}</span>
                      </td>
                      <td>{KIND_LABEL[r.kind]}</td>
                      <td className="col-text">
                        <button className="bi-title" type="button" onClick={() => setOpenId(r.id)}>
                          {r.isPrivate && <span className="bdg b-gray nodot">비공개</span>} {r.title}
                        </button>
                        {r.product && <div className="t-c1 c-alt">{r.product.name}</div>}
                        {r.order && <div className="t-c1 c-alt">주문 {r.order.orderNoLabel}</div>}
                      </td>
                      <td>{r.authorNickname}</td>
                      <td className="num">{formatDateTime(r.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ListTable>
          )}
          {(page > 1 || cursor) && <CursorPagination page={page} visited={cursors.length} hasNext={!!cursor} onChange={(target) => void goPage(target)} onNext={() => { if (cursor) void goPage(page + 1, cursor); }} />}
        </section>
      </main>
      {open && data && (
        <InquiryDialog
          key={open.id}
          item={open}
          canEdit={data.canEdit}
          onClose={() => setOpenId(null)}
          onSaved={async (text) => {
            setToast({ text });
            await load();
          }}
        />
      )}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}

function InquiryDialog({ item, canEdit, onClose, onSaved }: { item: Inquiry; canEdit: boolean; onClose: () => void; onSaved: (text: string) => Promise<void> }) {
  const [saved, setSaved] = useState(item.answer ?? "");
  const [answer, setAnswer] = useState(item.answer ?? "");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const dirty = canEdit && answer.trim() !== saved;

  const save = async (next: string | null) => {
    setBusy(true);
    setFailed(null);
    const r = await api(`/api/seller/inquiries/${item.id}/answer`, { method: "PUT", body: { answer: next } });
    setBusy(false);
    if (!r.ok) return setFailed(failMessage(r, "admin", "답변을 저장하지 못했습니다. 입력한 내용은 그대로 있습니다"));
    setSaved(next ?? "");
    if (next === null) setAnswer("");
    await onSaved(next === null ? "답변을 지웠습니다. 답변 대기로 돌아갑니다" : "답변을 저장했습니다");
  };

  return (
    <Modal labelId="bi-title" className="modal-lg" busy={busy} dirty={dirty} onClose={onClose}>
      {(requestClose) => (
        <>
          <div className="modal-h">
            <h2 className="modal-t" id="bi-title">
              {item.isPrivate ? "비공개 문의" : "문의"} · {item.authorNickname}
            </h2>
            <span className="t-c1 c-alt num">
              {KIND_LABEL[item.kind]} · {formatDateTime(item.createdAt)}
              {item.product ? ` · ${item.product.name}` : ""}
              {item.order ? ` · 주문 ${item.order.orderNoLabel}` : ""}
            </span>
          </div>
          {failed && (
            <div className="msg msg-neg" role="alert">
              <span>{failed}</span>
            </div>
          )}
          <div className="col bi-body">
            <span className="fw6">{item.title}</span>
            <p className="bi-text">{item.body}</p>
            {item.images.length > 0 && (
              <div className="bi-imgs">
                {item.images.map((i) => (
                  <img key={i.id} src={i.url} alt="문의 사진" width={96} height={96} />
                ))}
              </div>
            )}
            {item.isPrivate && <span className="t-c1 c-alt">작성자와 파트너스에게만 보이는 문의입니다.</span>}
            <div className="fld">
              <label htmlFor="bi-answer">답변</label>
              <textarea id="bi-answer" className="inp bi-answer" value={answer} maxLength={ANSWER_MAX} disabled={!canEdit || busy} onChange={(e) => setAnswer(e.target.value)} />
              <span className="help num">
                {answer.length.toLocaleString("ko-KR")} / {ANSWER_MAX.toLocaleString("ko-KR")}자
                {item.answeredAt ? ` · ${formatDateTime(item.answeredAt)} 답변` : ""}
              </span>
            </div>
          </div>
          <div className="modal-f">
            <button className="btn btn-out" type="button" onClick={requestClose} disabled={busy}>
              {canEdit ? "취소" : "닫기"}
            </button>
            {canEdit && saved !== "" && (
              <button className="btn btn-out" type="button" disabled={busy} onClick={() => void save(null)}>
                답변 지우기
              </button>
            )}
            {canEdit && (
              <button className="btn" type="button" disabled={busy || answer.trim() === "" || answer.trim() === saved} onClick={() => void save(answer.trim())}>
                {busy ? "저장 중" : "답변 저장"}
              </button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
