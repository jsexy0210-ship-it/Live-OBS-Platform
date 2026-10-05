"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ListHead, Modal, PageHead } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";

// SA-066 쇼핑몰 공지·자주 묻는 질문. 구매자 쇼핑몰(SH-030)에 보이는 글을 관리한다.
// API: GET/POST /api/seller/notices(?kind=notice|faq), PUT/DELETE /api/seller/notices/[id], PUT /api/seller/notices/faq-order({ ids } 전부 새 순서).
// 조회는 같은 쇼핑몰 파트너스 계정 누구나, 쓰기는 대표자·「쇼핑몰 설정」 권한만(서버가 막고 화면은 버튼을 숨긴다).
// 서버 lib/server/shop-notice/service.ts의 한도와 같은 값(서버 모듈은 prisma를 끌어오므로 화면에서 가져오지 않는다).
const TITLE_MAX = 60;
const BODY_MAX = 5000;
const CATEGORY_MAX = 20;

type Kind = "notice" | "faq";
type Item = { id: string; kind: Kind; title: string; body: string; category: string | null; isPinned: boolean; isPublished: boolean; sortOrder: number; createdAt: string };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; items: Item[] };
type Form = { mode: "add" } | { mode: "edit"; item: Item } | null;

const TABS: { key: Kind; label: string }[] = [
  { key: "notice", label: "공지" },
  { key: "faq", label: "자주 묻는 질문" },
];
const day = (iso: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

export default function ShopNoticesPage() {
  const { can } = useSeller();
  const editable = can("SHOP_SETTINGS");
  const [tab, setTab] = useState<Kind>("notice");
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [form, setForm] = useState<Form>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [category, setCategory] = useState("");
  const [pinned, setPinned] = useState(false);
  const [published, setPublished] = useState(true);
  const [showError, setShowError] = useState(false);
  const [remove, setRemove] = useState<Item | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  // 탭을 빨리 바꾸면 이전 응답이 늦게 올 수 있다. 마지막으로 보낸 요청의 응답만 반영한다
  const reqId = useRef(0);

  const load = useCallback(async (kind: Kind) => {
    const id = ++reqId.current;
    setState({ kind: "loading" });
    const r = await api<{ items: Item[] }>(`/api/seller/notices?kind=${kind}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", items: r.data.items } : { kind: "error", status: r.status });
  }, []);
  useEffect(() => void load(tab), [tab, load]);

  const items = state.kind === "ok" ? state.items : [];
  const isFaq = tab === "faq";
  const openForm = (f: NonNullable<Form>) => {
    setForm(f);
    setShowError(false);
    setFailure(null);
    const it = f.mode === "edit" ? f.item : null;
    setTitle(it?.title ?? "");
    setBody(it?.body ?? "");
    setCategory(it?.category ?? "");
    setPinned(it?.isPinned ?? false);
    setPublished(it?.isPublished ?? true);
  };

  const titleLen = title.trim().length;
  const bodyLen = body.trim().length;
  const titleError = titleLen === 0 ? "제목을 입력해 주십시오" : titleLen > TITLE_MAX ? `제목은 ${TITLE_MAX}자까지 입력할 수 있습니다` : null;
  const bodyError = bodyLen === 0 ? "내용을 입력해 주십시오" : bodyLen > BODY_MAX ? `내용은 ${BODY_MAX.toLocaleString("ko-KR")}자까지 입력할 수 있습니다` : null;
  const categoryError = category.trim().length > CATEGORY_MAX ? `분류는 ${CATEGORY_MAX}자까지 입력할 수 있습니다` : null;
  const dirty = !form
    ? false
    : form.mode === "add"
      ? title !== "" || body !== "" || category !== ""
      : title !== form.item.title || body !== form.item.body || category !== (form.item.category ?? "") || pinned !== form.item.isPinned || published !== form.item.isPublished;

  const submit = async () => {
    if (!form) return;
    if (titleError || bodyError || categoryError) return setShowError(true);
    setBusy(true);
    setFailure(null);
    const payload = { title: title.trim(), body: body.trim(), category: isFaq ? category.trim() || null : undefined, isPinned: !isFaq && published && pinned, isPublished: published };
    const r =
      form.mode === "add"
        ? await api<unknown>("/api/seller/notices", { method: "POST", body: { kind: tab, ...payload } })
        : await api<unknown>(`/api/seller/notices/${form.item.id}`, { method: "PUT", body: payload });
    setBusy(false);
    if (!r.ok) return setFailure(failMessage(r, "admin", "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오"));
    setForm(null);
    setToast({ text: form.mode === "add" ? "추가했습니다" : "저장했습니다" });
    await load(tab);
  };

  const confirmRemove = async () => {
    if (!remove) return;
    setBusy(true);
    const r = await api<unknown>(`/api/seller/notices/${remove.id}`, { method: "DELETE" });
    setBusy(false);
    setRemove(null);
    if (!r.ok) return setToast({ text: failMessage(r, "admin", "삭제하지 못했습니다. 잠시 후 다시 시도해 주십시오"), neg: true });
    setToast({ text: "삭제했습니다" });
    await load(tab);
  };

  // 질문 순서: 한 칸 옮길 때마다 지금 있는 질문 전부를 새 순서로 보낸다(서버가 다르면 409)
  const move = async (index: number, dir: -1 | 1) => {
    const next = [...items];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    setBusy(true);
    const r = await api<{ faqs: Item[] }>("/api/seller/notices/faq-order", { method: "PUT", body: { ids: next.map((x) => x.id) } });
    setBusy(false);
    if (!r.ok) {
      setToast({ text: failMessage(r, "admin", "순서를 바꾸지 못했습니다. 잠시 후 다시 시도해 주십시오"), neg: true });
      if (r.status === 409) await load(tab);
      return;
    }
    setState({ kind: "ok", items: r.data.faqs });
  };

  return (
    <>
      <Topbar crumb="설정 › 쇼핑몰 설정 › 공지·자주 묻는 질문" />
      <main className="main">
        <PageHead
          title="공지·자주 묻는 질문"
          actions={
            editable ? (
              <button className="btn" type="button" onClick={() => openForm({ mode: "add" })} data-testid="add-button">
                {isFaq ? "질문 추가" : "공지 추가"}
              </button>
            ) : undefined
          }
        />
        <span className="t-c1 c-alt">구매자 쇼핑몰에 보이는 글입니다. 공개로 둔 글만 구매자에게 보이고, 바꾸면 바로 반영됩니다.{editable ? "" : " 수정은 대표자와 쇼핑몰 설정 권한이 있는 계정만 할 수 있습니다."}</span>

        <div className="card" style={{ overflow: "visible", marginTop: 16 }}>
          <div className="tabs" role="tablist" style={{ padding: "0 12px" }}>
            {TABS.map((t) => (
              <button key={t.key} className={`tab${tab === t.key ? " on" : ""}`} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
          {state.kind === "ok" && items.length > 0 && <ListHead total={items.length} />}
          {state.kind === "loading" && <LoadingRows rows={4} />}
          {state.kind === "error" &&
            (state.status === 402 ? <Locked /> : <ErrorState title="목록을 불러오지 못했습니다" onRetry={() => void load(tab)} />)}
          {state.kind === "ok" && items.length === 0 && (
            <div className="st">
              <span className="t">{isFaq ? "아직 자주 묻는 질문이 없습니다" : "아직 공지가 없습니다"}</span>
            </div>
          )}
          {state.kind === "ok" && items.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="tbl" data-testid="notice-table">
                <thead>
                  <tr>
                    {isFaq && <th>순서</th>}
                    <th>제목</th>
                    {isFaq && <th>분류</th>}
                    <th>상태</th>
                    <th>{isFaq ? "수정일" : "등록일"}</th>
                    {editable && <th>관리</th>}
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, i) => (
                    <tr key={it.id} data-testid="notice-row">
                      {isFaq && <td className="num">{i + 1}</td>}
                      <td className="col-text">
                        {it.isPinned && <span className="bdg b-info">홈 고정</span>} {it.title}
                      </td>
                      {isFaq && <td>{it.category ?? "-"}</td>}
                      <td>
                        <span className={`bdg ${it.isPublished ? "b-done" : "b-warn"}`}>{it.isPublished ? "공개" : "비공개"}</span>
                      </td>
                      <td className="num">{day(it.createdAt)}</td>
                      {editable && (
                        <td>
                          <div className="cell-actions">
                            {isFaq && (
                              <>
                                <button className="btn btn-sm btn-out" type="button" aria-label={`${it.title} 위로`} disabled={busy || i === 0} onClick={() => void move(i, -1)}>
                                  위로
                                </button>
                                <button className="btn btn-sm btn-out" type="button" aria-label={`${it.title} 아래로`} disabled={busy || i === items.length - 1} onClick={() => void move(i, 1)}>
                                  아래로
                                </button>
                              </>
                            )}
                            <button className="btn btn-sm btn-out" type="button" onClick={() => openForm({ mode: "edit", item: it })}>
                              수정
                            </button>
                            <button className="btn btn-sm btn-out" type="button" onClick={() => setRemove(it)}>
                              삭제
                            </button>
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
        <p className="help" style={{ marginTop: 16 }}>
          {isFaq ? "질문은 이 순서대로 쇼핑몰에 보입니다. 분류는 선택입니다." : "공지는 최신순으로 보입니다. 홈 고정은 공개한 공지 1개만 할 수 있고, 새로 고정하면 이전 고정은 풀립니다."}
        </p>
      </main>

      {form && (
        <Modal labelId="notice-form-title" busy={busy} dirty={dirty} onClose={() => setForm(null)}>
          <div className="modal-h">
            <h2 className="modal-t" id="notice-form-title">
              {form.mode === "add" ? (isFaq ? "질문 추가" : "공지 추가") : isFaq ? "질문 수정" : "공지 수정"}
            </h2>
          </div>
          <div className="col" style={{ gap: 12, padding: "0 20px 16px" }}>
            {failure && (
              <div className="msg msg-neg" role="alert">
                <span>{failure}</span>
              </div>
            )}
            <label className="col" style={{ gap: 4 }}>
              <span className="t-l2">{isFaq ? "질문" : "제목"}</span>
              <input className={`inp${showError && titleError ? " is-error" : ""}`} type="text" value={title} maxLength={TITLE_MAX + 20} aria-invalid={showError && !!titleError} onChange={(e) => setTitle(e.target.value)} />
              {showError && titleError ? <span className="t-c1 c-neg">{titleError}</span> : <span className="t-c1 c-alt">{titleLen} / {TITLE_MAX}</span>}
            </label>
            {isFaq && (
              <label className="col" style={{ gap: 4 }}>
                <span className="t-l2">분류 (선택)</span>
                <input className={`inp${showError && categoryError ? " is-error" : ""}`} type="text" value={category} maxLength={CATEGORY_MAX + 10} aria-invalid={showError && !!categoryError} onChange={(e) => setCategory(e.target.value)} />
                {showError && categoryError && <span className="t-c1 c-neg">{categoryError}</span>}
              </label>
            )}
            <label className="col" style={{ gap: 4 }}>
              <span className="t-l2">{isFaq ? "답변" : "내용"}</span>
              <textarea className={`inp${showError && bodyError ? " is-error" : ""}`} rows={8} value={body} aria-invalid={showError && !!bodyError} onChange={(e) => setBody(e.target.value)} />
              {showError && bodyError ? <span className="t-c1 c-neg">{bodyError}</span> : <span className="t-c1 c-alt">{bodyLen.toLocaleString("ko-KR")} / {BODY_MAX.toLocaleString("ko-KR")}</span>}
            </label>
            <label className="chk">
              <input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} />
              쇼핑몰에 공개
            </label>
            {!isFaq && (
              <label className="chk">
                <input type="checkbox" checked={published && pinned} disabled={!published} onChange={(e) => setPinned(e.target.checked)} />
                쇼핑몰 홈 상단에 고정 (공개한 공지 1개)
              </label>
            )}
          </div>
          <div className="modal-f">
            <button className="btn btn-out" type="button" onClick={() => setForm(null)} disabled={busy}>
              취소
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => void submit()} data-testid="notice-save">
              {busy ? "저장 중" : form.mode === "add" ? "추가" : "저장"}
            </button>
          </div>
        </Modal>
      )}
      {remove && (
        <Modal labelId="notice-del-title" busy={busy} onClose={() => setRemove(null)}>
          <div className="modal-h">
            <h2 className="modal-t" id="notice-del-title">
              「{remove.title}」을 삭제하시겠습니까?
            </h2>
            <span className="t-l2 c-alt">삭제하면 쇼핑몰에서 바로 사라지고 되돌릴 수 없습니다.</span>
          </div>
          <div className="modal-f">
            <button className="btn btn-out" type="button" onClick={() => setRemove(null)} disabled={busy}>
              취소
            </button>
            <button className="btn btn-neg" type="button" onClick={() => void confirmRemove()} disabled={busy} data-testid="notice-delete-confirm">
              {busy ? "삭제 중" : "삭제"}
            </button>
          </div>
        </Modal>
      )}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
