"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead, useConfirm } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";
import { GripIcon, StateBox, stateKind, useSortable } from "../../banners/_shared/ui";

// SA-066 쇼핑몰 공지·자주 묻는 질문(마케팅). 정본 design/project/SA-066.dc.html: 공지 표 → 자주 묻는 질문 표 → 같은 화면 아래 「공지 쓰기·질문 수정」 입력 표 →
// 구매자 화면 미리보기 + 운영 규칙. 구매자 쇼핑몰(SH-030)에 보이는 글을 관리한다.
// API: GET/POST /api/seller/notices(?kind=notice|faq), PUT/DELETE /api/seller/notices/[id], PUT /api/seller/notices/faq-order({ ids } 전부 새 순서).
// 조회는 같은 쇼핑몰 파트너스 계정 누구나, 쓰기는 대표자·「쇼핑몰 설정」 권한만(서버가 막고 화면은 버튼을 숨긴다).
// 서버 lib/server/shop-notice/service.ts의 한도와 같은 값(서버 모듈은 prisma를 끌어오므로 화면에서 가져오지 않는다).
const TITLE_MAX = 60;
const BODY_MAX = 5000;
const CATEGORY_MAX = 20;

type Kind = "notice" | "faq";
type Item = { id: string; kind: Kind; title: string; body: string; category: string | null; isPinned: boolean; isPublished: boolean; sortOrder: number; createdAt: string };
type Load<T> = { kind: "loading" } | { kind: "error"; status: number; error?: string } | { kind: "ok"; items: T[] };
type Draft = { id: string | null; kind: Kind; title: string; body: string; category: string; isPinned: boolean; isPublished: boolean };

const empty = (kind: Kind): Draft => ({ id: null, kind, title: "", body: "", category: "", isPinned: false, isPublished: true });
const toDraft = (it: Item): Draft => ({ id: it.id, kind: it.kind, title: it.title, body: it.body, category: it.category ?? "", isPinned: it.isPinned, isPublished: it.isPublished });
const day = (iso: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso)).replace(/\.\s*/g, ".").replace(/\.$/, "");
const Status = ({ on }: { on: boolean }) => <span className={`bdg ${on ? "b-done" : "b-cancel"}`}>{on ? "공개" : "비공개"}</span>;
const summary = (list: Item[]) => `총 ${list.length}${list.some((i) => i.isPublished) ? ` · 공개 ${list.filter((i) => i.isPublished).length}` : ""}${list.some((i) => !i.isPublished) ? ` · 비공개 ${list.filter((i) => !i.isPublished).length}` : ""}`;

export default function ShopNoticesPage() {
  const { can, me } = useSeller();
  const { confirm } = useConfirm();
  const editable = can("SHOP_SETTINGS");
  const [notices, setNotices] = useState<Load<Item>>({ kind: "loading" });
  const [faqs, setFaqs] = useState<Load<Item>>({ kind: "loading" });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [category, setCategory] = useState("");
  const [showError, setShowError] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const reqId = useRef({ notice: 0, faq: 0 });

  const load = useCallback(async (kind: Kind) => {
    const id = ++reqId.current[kind];
    const r = await api<{ items: Item[] }>(`/api/seller/notices?kind=${kind}`);
    if (id !== reqId.current[kind]) return;
    const next: Load<Item> = r.ok ? { kind: "ok", items: r.data.items } : { kind: "error", status: r.status, error: r.error };
    (kind === "notice" ? setNotices : setFaqs)(next);
  }, []);
  useEffect(() => {
    void load("notice");
    void load("faq");
  }, [load]);

  const noticeList = notices.kind === "ok" ? notices.items : [];
  const faqList = faqs.kind === "ok" ? faqs.items : [];
  const categories = [...new Set(faqList.map((f) => f.category).filter((c): c is string => !!c))];
  const shownFaqs = category ? faqList.filter((f) => f.category === category) : faqList;
  const pinned = noticeList.find((n) => n.isPinned);

  // 질문 순서: 지금 있는 질문 전부를 새 순서로 보낸다(서버가 다르면 409). 분류로 걸러 본 동안에는 바꾸지 않는다.
  const { rowProps, move } = useSortable(shownFaqs, async (next) => {
    if (category) return;
    setFaqs({ kind: "ok", items: next });
    const r = await api<{ faqs: Item[] }>("/api/seller/notices/faq-order", { method: "PUT", body: { ids: next.map((x) => x.id) } });
    if (!r.ok) {
      setToast({ text: failMessage(r, "admin", "순서를 바꾸지 못했습니다. 잠시 후 다시 시도해 주십시오"), neg: true });
      await load("faq");
      return;
    }
    setFaqs({ kind: "ok", items: r.data.faqs });
    setToast({ text: "순서를 저장했습니다 · 구매자 화면에 바로 반영" });
  });

  const open = (d: Draft) => {
    setDraft(d);
    setShowError(false);
    setFailure(null);
  };
  const isFaq = draft?.kind === "faq";
  const titleLen = draft?.title.trim().length ?? 0;
  const bodyLen = draft?.body.trim().length ?? 0;
  const titleError = titleLen === 0 ? (isFaq ? "질문을 입력해 주십시오" : "제목을 입력해 주십시오") : titleLen > TITLE_MAX ? `${isFaq ? "질문" : "제목"}은 ${TITLE_MAX}자까지 입력할 수 있습니다` : null;
  const bodyError = bodyLen === 0 ? (isFaq ? "답변을 입력해 주십시오" : "내용을 입력해 주십시오") : bodyLen > BODY_MAX ? `${isFaq ? "답변" : "내용"}은 ${BODY_MAX.toLocaleString("ko-KR")}자까지 입력할 수 있습니다` : null;
  const categoryError = (draft?.category.trim().length ?? 0) > CATEGORY_MAX ? `분류는 ${CATEGORY_MAX}자까지 입력할 수 있습니다` : null;
  const noun = isFaq ? "질문" : "공지";

  const save = async () => {
    if (!draft) return;
    if (titleError || bodyError || categoryError) return setShowError(true);
    setFailure(null);
    const willPin = draft.kind === "notice" && draft.isPublished && draft.isPinned;
    const replaced = willPin && pinned && pinned.id !== draft.id ? pinned : null;
    await confirm({
      title: replaced ? "고정 공지를 바꾸시겠습니까?" : draft.id ? `${noun}를 저장하시겠습니까?` : `${noun}를 추가하시겠습니까?`,
      body: replaced ? `홈 띠는 공지 1개만 고정됩니다. 「${replaced.title}」 고정이 풀리고 이 공지가 고정됩니다.` : "구매자 화면에 바로 반영됩니다.",
      confirmLabel: replaced ? "바꾸기" : draft.id ? "저장" : "추가",
      run: async () => {
        const body = {
          title: draft.title.trim(),
          body: draft.body.trim(),
          category: draft.kind === "faq" ? draft.category.trim() || null : undefined,
          isPinned: willPin,
          isPublished: draft.isPublished,
        };
        const r = draft.id ? await api<unknown>(`/api/seller/notices/${draft.id}`, { method: "PUT", body }) : await api<unknown>("/api/seller/notices", { method: "POST", body: { kind: draft.kind, ...body } });
        if (!r.ok) return failMessage(r, "admin", "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오");
        setDraft(null);
        setToast({ text: `${noun}를 ${draft.id ? "저장" : "추가"}했습니다 · 구매자 화면에 바로 반영` });
        await load(draft.kind);
      },
    });
  };

  const remove = async (it: Item | Draft) => {
    if (!it.id) return;
    const id = it.id;
    await confirm({
      title: `${it.kind === "faq" ? "질문" : "공지"}를 삭제하시겠습니까?`,
      body: `「${it.title}」를 삭제합니다. 쇼핑몰에서 바로 사라지고 되돌릴 수 없습니다.`,
      confirmLabel: "삭제",
      danger: true,
      run: async () => {
        const r = await api<unknown>(`/api/seller/notices/${id}`, { method: "DELETE" });
        if (!r.ok) return failMessage(r, "admin", "삭제하지 못했습니다. 잠시 후 다시 시도해 주십시오");
        setDraft((d) => (d?.id === id ? null : d));
        setToast({ text: it.kind === "faq" ? "질문을 삭제했습니다" : "공지를 삭제했습니다" });
        await load(it.kind);
      },
    });
  };

  // 공개 ↔ 비공개. 값은 전체를 보내며, 비공개로 바꾸면 홈 고정도 풀린다(서버 규칙).
  const toggle = async (it: Item) => {
    const next = !it.isPublished;
    await confirm({
      title: next ? "공지를 공개하시겠습니까?" : "공지를 숨기시겠습니까?",
      body: next ? `「${it.title}」가 구매자 화면에 바로 보입니다.` : `「${it.title}」가 구매자 화면에서 바로 사라집니다.${it.isPinned ? " 홈 고정도 풀립니다." : ""}`,
      confirmLabel: next ? "공개" : "숨기기",
      run: async () => {
        const r = await api<unknown>(`/api/seller/notices/${it.id}`, { method: "PUT", body: { title: it.title, body: it.body, category: undefined, isPinned: next && it.isPinned, isPublished: next } });
        if (!r.ok) return failMessage(r, "admin", "바꾸지 못했습니다. 잠시 후 다시 시도해 주십시오");
        setToast({ text: next ? "공지를 공개했습니다" : "공지를 숨겼습니다" });
        await load("notice");
      },
    });
  };

  const stateBox = (s: Load<Item>, kind: Kind, what: string) =>
    s.kind === "loading" ? <StateBox kind="loading" what={what} /> : s.kind === "error" ? <StateBox kind={stateKind(s.status, s.error)} what={what} onRetry={() => void load(kind)} /> : null;

  return (
    <>
      <Topbar crumb="마케팅 › 쇼핑몰 공지 · 자주 묻는 질문" />
      <main className="main">
        <PageHead description="구매자에게 보여 줄 공지와 자주 묻는 질문을 관리합니다."
          title="쇼핑몰 공지 · 자주 묻는 질문"
          actions={
            <>
              <a className="btn btn-out" href={`/shop/${encodeURIComponent(me.shop.slug)}/help`} target="_blank" rel="noopener noreferrer">
                구매자 화면 보기
              </a>
              {editable && (
                <>
                  <button className="btn btn-out" type="button" onClick={() => open(empty("faq"))} data-testid="add-faq">
                    질문 추가
                  </button>
                  <button className="btn" type="button" onClick={() => open(empty("notice"))} data-testid="add-notice">
                    공지 쓰기
                  </button>
                </>
              )}
            </>
          }
        />
        {!editable && (
          <div className="msg msg-info" role="status">
            <span>목록만 볼 수 있습니다. 공지 · 질문 추가와 수정은 대표자나 쇼핑몰 설정 권한이 있는 직원에게 요청해 주십시오.</span>
          </div>
        )}

        <div className="sc-sec-t">공지</div>
        {stateBox(notices, "notice", "공지")}
        {notices.kind === "ok" && noticeList.length === 0 && (
          <section className="card" style={{ overflow: "hidden" }}>
            <div className="st" style={{ boxShadow: "none" }}>
              <div className="st-ic">+</div>
              <span className="t">아직 공지가 없습니다</span>
              <span className="s">배송 지연 · 방송 일정 · 안내를 공지로 알릴 수 있습니다</span>
              {editable && (
                <button className="btn btn-sm" type="button" onClick={() => open(empty("notice"))}>
                  공지 쓰기
                </button>
              )}
            </div>
          </section>
        )}
        {notices.kind === "ok" && noticeList.length > 0 && (
          <>
            <div className="sc-ltop">
              <span className="t-c1 c-alt" data-testid="notice-summary">
                {summary(noticeList)}
              </span>
            </div>
            <div className="sc-tbl-wrap">
              <table className="tbl sc-tbl" data-testid="notice-table">
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>제목</th>
                    <th style={{ width: 80 }}>종류</th>
                    <th style={{ width: 160 }}>노출</th>
                    <th style={{ width: 100 }}>작성일</th>
                    <th style={{ width: 70 }}>상태</th>
                    {editable && <th style={{ width: 190 }}>관리</th>}
                  </tr>
                </thead>
                <tbody>
                  {noticeList.map((it) => (
                    <tr key={it.id} data-testid="notice-row" className={draft?.id === it.id ? "is-sel" : undefined}>
                      <td className="col-text">
                        <b>{it.title}</b> {it.isPinned && <span className="bdg b-info">고정</span>}
                      </td>
                      <td>공지</td>
                      <td>{it.isPinned ? "쇼핑몰 공지 · 홈 띠" : "쇼핑몰 공지"}</td>
                      <td className="num">{day(it.createdAt)}</td>
                      <td>
                        <Status on={it.isPublished} />
                      </td>
                      {editable && (
                        <td>
                          <div className="acts2">
                            <button className="btn btn-sm btn-out" type="button" onClick={() => open(toDraft(it))}>
                              수정
                            </button>
                            <button className="btn btn-sm btn-out" type="button" onClick={() => void toggle(it)}>
                              {it.isPublished ? "숨기기" : "공개"}
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <span className="t-c1 c-alt">공지는 최신순으로 보입니다 · 홈 고정은 공개한 공지 1개만 · 새로 고정하면 이전 고정은 풀립니다</span>
          </>
        )}

        <div className="sc-sec-t">자주 묻는 질문</div>
        {stateBox(faqs, "faq", "질문")}
        {faqs.kind === "ok" && faqList.length === 0 && (
          <section className="card" style={{ overflow: "hidden" }}>
            <div className="st" style={{ boxShadow: "none" }}>
              <div className="st-ic">+</div>
              <span className="t">아직 자주 묻는 질문이 없습니다</span>
              <span className="s">구매자가 자주 묻는 내용을 질문과 답변으로 정리해 둘 수 있습니다</span>
              {editable && (
                <button className="btn btn-sm" type="button" onClick={() => open(empty("faq"))}>
                  질문 추가
                </button>
              )}
            </div>
          </section>
        )}
        {faqs.kind === "ok" && faqList.length > 0 && (
          <>
            <div className="sc-ltop">
              <label className="sc-auto">
                <span className="t-c1">분류</span>
                <select className="inp inp-sm" style={{ minWidth: 150 }} aria-label="분류" value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="">분류 전체</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <span className="t-c1 c-alt" data-testid="faq-summary">
                {summary(shownFaqs)}
              </span>
            </div>
            <div className="sc-tbl-wrap">
              <table className="tbl sc-tbl" data-testid="faq-table">
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>질문</th>
                    <th style={{ width: 110 }}>분류</th>
                    <th style={{ width: 70 }}>상태</th>
                    {editable && <th style={{ width: 120 }}>관리</th>}
                  </tr>
                </thead>
                <tbody>
                  {shownFaqs.map((it, i) => (
                    <tr key={it.id} {...rowProps(it.id, editable && !category)} data-testid="faq-row" className={draft?.id === it.id ? "is-sel" : undefined}>
                      <td className="col-text">
                        <span className="sc-ord">
                          {editable && !category && (
                            <span className="sc-mv">
                              <button type="button" aria-label={`${it.title} 위로`} disabled={i === 0} onClick={() => move(i, i - 1)}>
                                ▲
                              </button>
                              <button type="button" aria-label={`${it.title} 아래로`} disabled={i === shownFaqs.length - 1} onClick={() => move(i, i + 1)}>
                                ▼
                              </button>
                            </span>
                          )}
                          <span className="c-alt" aria-hidden="true">
                            <GripIcon />
                          </span>
                          <b>{it.title}</b>
                        </span>
                      </td>
                      <td>{it.category ?? "—"}</td>
                      <td>
                        <Status on={it.isPublished} />
                      </td>
                      {editable && (
                        <td>
                          <div className="acts2">
                            <button className="btn btn-sm btn-out" type="button" onClick={() => open(toDraft(it))}>
                              수정
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <span className="t-c1 c-alt">끌어서 순서 변경 · 질문은 이 순서대로 구매자 화면에 보입니다{category ? " · 분류 전체로 돌려야 순서를 바꿀 수 있습니다" : ""}</span>
          </>
        )}

        {draft && (
          <section aria-label={`${noun} ${draft.id ? "수정" : "쓰기"}`} data-testid="notice-editor">
            <div className="sc-sec-t">
              {draft.id ? `${noun} 수정 · ${draft.title || "제목 없음"}` : draft.kind === "faq" ? "질문 추가" : "공지 쓰기"}
              {draft.id && (
                <span style={{ marginLeft: 8 }}>
                  <Status on={draft.isPublished} />
                </span>
              )}
            </div>
            {failure && (
              <div className="msg msg-neg" role="alert">
                <span>{failure}</span>
              </div>
            )}
            <table className="au-ft sc-ft">
              <tbody>
                <tr>
                  <th>
                    <label htmlFor="notice-title">{isFaq ? "질문" : "제목"}</label> <span className="sc-rq">*</span>
                  </th>
                  <td>
                    <input id="notice-title" className={`inp${showError && titleError ? " is-error" : ""}`} style={{ maxWidth: 560 }} value={draft.title} aria-invalid={showError && !!titleError} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                    {showError && titleError ? <span className="err">{titleError}</span> : <span className="help">구매자에게 보이는 글 {isFaq ? "· 해요체 " : ""}· {titleLen} / {TITLE_MAX}자</span>}
                  </td>
                </tr>
                {isFaq && (
                  <tr>
                    <th>
                      <label htmlFor="notice-category">분류</label>
                    </th>
                    <td>
                      <input id="notice-category" className={`inp${showError && categoryError ? " is-error" : ""}`} style={{ maxWidth: 240 }} list="notice-categories" value={draft.category} aria-invalid={showError && !!categoryError} onChange={(e) => setDraft({ ...draft, category: e.target.value })} />
                      <datalist id="notice-categories">
                        {categories.map((c) => (
                          <option key={c} value={c} />
                        ))}
                      </datalist>
                      {showError && categoryError ? <span className="err">{categoryError}</span> : <span className="help">선택 · 비우면 분류 없음 · 목록에서 고르거나 새로 입력</span>}
                    </td>
                  </tr>
                )}
                <tr>
                  <th>
                    <label htmlFor="notice-body">{isFaq ? "답변" : "내용"}</label> <span className="sc-rq">*</span>
                  </th>
                  <td>
                    <textarea id="notice-body" className={`inp${showError && bodyError ? " is-error" : ""}`} style={{ maxWidth: 560, height: 120, padding: "10px 12px" }} value={draft.body} aria-invalid={showError && !!bodyError} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
                    {showError && bodyError ? <span className="err">{bodyError}</span> : <span className="help">{bodyLen.toLocaleString("ko-KR")} / {BODY_MAX.toLocaleString("ko-KR")}자</span>}
                  </td>
                </tr>
                <tr>
                  <th>옵션</th>
                  <td>
                    <label className="sc-ck">
                      <input type="checkbox" checked={draft.isPublished} onChange={(e) => setDraft({ ...draft, isPublished: e.target.checked, isPinned: e.target.checked && draft.isPinned })} />
                      쇼핑몰에 공개
                    </label>
                    {!isFaq && (
                      <label className="sc-ck">
                        <input type="checkbox" checked={draft.isPublished && draft.isPinned} disabled={!draft.isPublished} onChange={(e) => setDraft({ ...draft, isPinned: e.target.checked })} />
                        홈 띠에 고정
                      </label>
                    )}
                  </td>
                </tr>
                <tr>
                  <th />
                  <td>
                    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                      <button className="btn" type="button" onClick={() => void save()} data-testid="notice-save">
                        저장
                      </button>
                      <button className="btn btn-out" type="button" onClick={() => document.getElementById("notice-preview")?.scrollIntoView({ block: "center" })}>
                        미리보기
                      </button>
                      <button className="btn btn-out" type="button" onClick={() => setDraft(null)}>
                        닫기
                      </button>
                      {draft.id && (
                        <button className="btn btn-neg" type="button" onClick={() => void remove(draft)} data-testid="notice-delete">
                          삭제
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        )}

        <div className="sc-two">
          <div>
            <div className="sc-sec-t">구매자 화면 미리보기</div>
            <div className="sc-box" id="notice-preview" data-testid="notice-preview">
              {draft ? (
                <div className="col" style={{ gap: 4, width: "100%", textAlign: "left" }}>
                  <span className="t-c1 c-alt">
                    공지 · 자주 묻는 질문 · {isFaq ? "질문" : "공지"}
                  </span>
                  <b>{draft.title || (isFaq ? "질문을 입력하면 여기에 표시됩니다" : "제목을 입력하면 여기에 표시됩니다")}</b>
                  <span className="t-c1 c-alt" style={{ whiteSpace: "pre-wrap" }}>
                    {draft.body.trim().slice(0, 120) || "내용을 입력하면 여기에 표시됩니다"}
                  </span>
                  {!draft.isPublished && <span className="t-c1 c-alt">비공개 글은 구매자에게 보이지 않습니다</span>}
                </div>
              ) : (
                <span className="t-c1 c-alt">글을 쓰거나 수정하면 여기에 표시됩니다</span>
              )}
            </div>
            <span className="t-c1 c-alt">구매자 화면 문구는 해요체 그대로 표시 · 쇼핑몰 도움말 화면에 보입니다</span>
          </div>
          <div>
            <div className="sc-sec-t">운영 규칙</div>
            <table className="au-ft">
              <tbody>
                <tr>
                  <th>홈 띠</th>
                  <td>고정 공지 1개만 · 팝업과 별개</td>
                </tr>
                <tr>
                  <th>권한</th>
                  <td>대표자 · 쇼핑몰 설정 권한 직원</td>
                </tr>
                <tr>
                  <th>기록</th>
                  <td>작성 · 수정 · 숨김은 로그 추적에 남습니다</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </main>
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
