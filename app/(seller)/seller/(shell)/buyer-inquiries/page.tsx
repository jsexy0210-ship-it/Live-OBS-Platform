"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal, PageHead, SearchBox, SearchRow } from "../../../../../components/admin-ui";
import { Topbar } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../components/seller/States";
import { api, failMessage } from "../../../../../components/seller/api";
import { listTime } from "../../../../../components/seller/orders";
import "./buyer-inquiries.css";

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
type Filter = { status: "" | Status; kind: "" | Kind; from: string; to: string; q: string };

const EMPTY: Filter = { status: "", kind: "", from: "", to: "", q: "" };
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
  const [draft, setDraft] = useState<Filter>(EMPTY);
  const [filter, setFilter] = useState<Filter>(EMPTY);
  const [more, setMore] = useState<Inquiry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
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
    const r = await api<Data>(query());
    if (!r.ok) return setState({ kind: "error", status: r.status });
    setMore([]);
    setCursor(r.data.nextCursor);
    setState({ kind: "ok", data: r.data });
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    const r = await api<Data>(query(cursor));
    setLoadingMore(false);
    if (!r.ok) return setToast({ text: "더 불러오지 못했습니다. 다시 눌러 주십시오", neg: true });
    const seen = new Set(more.map((x) => x.id));
    setMore((m) => [...m, ...r.data.inquiries.filter((x) => !seen.has(x.id))]);
    setCursor(r.data.nextCursor);
  };

  const data = state.kind === "ok" ? state.data : null;
  const seen = new Set<string>();
  const rows = data ? [...data.inquiries, ...more].filter((x) => !seen.has(x.id) && seen.add(x.id)) : [];
  const open = rows.find((x) => x.id === openId) ?? null;
  const invalidRange = draft.from !== "" && draft.to !== "" && draft.from > draft.to;

  const search = () => {
    if (invalidRange) return;
    setFilter(draft);
  };
  const setTab = (status: "" | Status) => {
    setDraft((d) => ({ ...d, status }));
    setFilter((f) => ({ ...f, status }));
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
        <SearchBox onSearch={search} onReset={() => { setDraft({ ...EMPTY, status: filter.status }); setFilter({ ...EMPTY, status: filter.status }); }} label="문의 검색">
          <SearchRow label="종류">
            <select className="inp" aria-label="문의 종류" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as "" | Kind })}>
              <option value="">전체</option>
              <option value="PRODUCT">상품 문의</option>
              <option value="GENERAL">1:1 문의</option>
            </select>
          </SearchRow>
          <SearchRow label="작성일">
            <input className="inp" type="date" aria-label="작성일 시작" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
            <span aria-hidden="true">~</span>
            <input className="inp" type="date" aria-label="작성일 끝" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
            {invalidRange && <span className="help bi-neg">시작일이 끝일보다 늦습니다</span>}
          </SearchRow>
          <SearchRow label="검색어">
            <input className="inp" aria-label="검색어" placeholder="제목 · 내용 · 작성자 · 상품명" maxLength={50} value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} />
          </SearchRow>
        </SearchBox>

        <div className="card">
          <div className="tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.key || "all"} className={`tab${filter.status === t.key ? " on" : ""}`} type="button" role="tab" aria-selected={filter.status === t.key} onClick={() => setTab(t.key)}>
                {t.label}
                {t.key === "WAITING" && data ? ` ${data.waitingCount.toLocaleString("ko-KR")}` : ""}
              </button>
            ))}
          </div>
          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" &&
            (state.status === 403 ? <NoPermission need="구매자 문의" /> : state.status === 402 ? <Locked /> : <ErrorState title="구매자 문의를 불러오지 못했습니다" onRetry={() => void load()} />)}
          {data && rows.length === 0 && (
            <div className="st" style={{ boxShadow: "none" }}>
              <div className="st-ic">0</div>
              <span className="t">{filter.status || filter.kind || filter.from || filter.to || filter.q ? "조건에 맞는 문의가 없습니다" : "아직 문의가 없습니다"}</span>
              <span className="s">구매자가 상품 문의나 1:1 문의를 남기면 여기에 표시됩니다.</span>
            </div>
          )}
          {data && rows.length > 0 && (
            <div className="au-lt-wrap">
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
                      </td>
                      <td>{r.authorNickname}</td>
                      <td className="num">{listTime(r.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {cursor && (
            <div className="bi-more">
              <button className={`btn btn-sm btn-out${loadingMore ? " is-loading" : ""}`} type="button" disabled={loadingMore} onClick={() => void loadMore()}>
                더 불러오기
              </button>
            </div>
          )}
        </div>
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
              {KIND_LABEL[item.kind]} · {listTime(item.createdAt)}
              {item.product ? ` · ${item.product.name}` : ""}
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
                {item.answeredAt ? ` · ${listTime(item.answeredAt)} 답변` : ""}
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
