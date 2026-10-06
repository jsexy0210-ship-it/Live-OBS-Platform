"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { adminCan } from "../../../../../../lib/server/authz/permissions";
import { ListHead, Modal, PageHead, SearchBox, SearchRow } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { MAX_SEARCH_LENGTH } from "../../../../../../components/seller/format";
import { useScrollRestore, useUrlState } from "../../../../../../lib/client/navigation";
import { adminApi, failMessage } from "../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../_components/AdminShell";
import { NOTICE_AUDIENCE, NOTICE_CATEGORY, NOTICE_STATUS, type Notice, type NoticeCategory, type NoticeStatus } from "../../../_components/notices";
import { day } from "../../../_components/partners";

// MA-053 공지사항 목록(GET /api/admin/platform-notices, 모든 마스터 역할). 상태는 서버 조건, 분류·제목은 불러온 목록 안에서 거른다(서버에 검색 조건 없음).
// 작성·수정·삭제 버튼은 최고관리자·CS만 보인다(support.manage).
// 적용된 조건(상태·분류·제목)은 주소 쿼리가 기준이라 상세·작성 화면에서 돌아와도 그대로이고 스크롤도 복원한다(UX-03).
type Filters = { status: NoticeStatus | ""; category: NoticeCategory | ""; q: string };
const EMPTY: Filters = { status: "", category: "", q: "" };
type Page = { items: Notice[]; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; items: Notice[]; next: string | null };

function DeleteDialog({ notice, onClose, onDone, onStale }: { notice: Notice; onClose: () => void; onDone: () => void; onStale: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await adminApi(`/api/admin/platform-notices/${notice.id}?expectedVersion=${notice.version}`, { method: "DELETE" });
    setBusy(false);
    if (r.ok) return onDone();
    if (r.status === 409 || r.status === 404) return onStale();
    setError(failMessage(r, "삭제하지 못했습니다. 잠시 후 다시 시도해 주십시오."));
  };
  return (
    <Modal labelId="notice-del-title" busy={busy} onClose={onClose}>
      {(requestClose) => (
        <>
          <div className="modal-h">
            <h2 className="modal-t" id="notice-del-title">
              「{notice.title}」을(를) 삭제하시겠습니까?
            </h2>
            <span className="t-l2 c-alt">삭제한 공지는 어디에도 보이지 않으며, 로그 추적에만 남습니다.</span>
          </div>
          {error && (
            <div style={{ padding: "0 24px" }}>
              <span className="err" role="alert">
                {error}
              </span>
            </div>
          )}
          <div className="modal-f">
            <button className="btn btn-out" type="button" onClick={requestClose} disabled={busy}>
              취소
            </button>
            <button className="btn" type="button" onClick={() => void submit()} disabled={busy}>
              {busy ? "처리 중" : "삭제"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function NoticeList() {
  const { me } = useAdmin();
  const canEdit = adminCan(me.role, "support.manage");
  // saved·stale은 작성·수정 화면이 돌아올 때 붙이는 결과 표시(알림을 보이고 곧 비운다). 조건은 그대로 둔다.
  const [url, setUrl] = useUrlState({ ...EMPTY, saved: "", stale: "" });
  const applied = useMemo<Filters>(
    () => ({
      status: url.status in NOTICE_STATUS ? (url.status as NoticeStatus) : "",
      category: url.category in NOTICE_CATEGORY ? (url.category as NoticeCategory) : "",
      q: url.q,
    }),
    [url.status, url.category, url.q],
  );
  const [draft, setDraft] = useState<Filters>(applied);
  useEffect(() => setDraft(applied), [applied]);
  const apply = (f: Filters) => setUrl({ ...f, saved: "", stale: "" });
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const [target, setTarget] = useState<Notice | null>(null);

  // 작성·수정 화면에서 돌아오면 주소의 결과(saved·stale)를 알림으로 바꾸고 주소를 비운다(목록이 그대로 떠 있어도 매번 처리)
  useEffect(() => {
    const { saved, stale } = url;
    if (!saved && !stale) return;
    setToast(saved ? { text: saved === "published" ? "공지를 게시했습니다." : "임시 저장했습니다." } : { text: "다른 곳에서 먼저 수정됐습니다. 최신 내용을 확인해 주십시오.", neg: true });
    setUrl({ saved: "", stale: "" });
  }, [url.saved, url.stale, setUrl]);

  const reqId = useRef(0);
  const qs = (status: string, cursor?: string) => {
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    if (cursor) p.set("cursor", cursor);
    return p.toString();
  };
  const load = useCallback(async (status: string) => {
    const id = ++reqId.current;
    setMore(false);
    setState({ kind: "loading" });
    const r = await adminApi<Page>(`/api/admin/platform-notices?${qs(status)}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", items: r.data.items, next: r.data.nextCursor } : { kind: "error" });
  }, []);
  useEffect(() => void load(applied.status), [applied.status, load]);
  useScrollRestore("admin-notices", state.kind === "ok");

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    const id = reqId.current;
    const r = await adminApi<Page>(`/api/admin/platform-notices?${qs(applied.status, state.next)}`);
    if (id !== reqId.current) return;
    setMore(false);
    if (r.ok) setState({ kind: "ok", items: [...state.items, ...r.data.items], next: r.data.nextCursor });
    else setToast({ text: "더 불러오지 못했습니다. 다시 눌러 주십시오.", neg: true });
  };

  const items = state.kind === "ok" ? state.items.filter((n) => (!applied.category || n.category === applied.category) && (!applied.q || n.title.includes(applied.q))) : [];
  const filtered = applied.status !== "" || applied.category !== "" || applied.q !== "";
  const reset = () => {
    apply(EMPTY);
  };

  return (
    <>
      <AdminTopbar crumb="고객지원 › 공지사항" />
      <main className="main">
        <PageHead description="공지의 대상과 게시 상태를 확인하고 공지를 작성·수정합니다."
          title="공지사항"
          actions={
            canEdit && (
              <Link className="btn" href="/admin/support/notices/new">
                공지 작성
              </Link>
            )
          }
        />
        <SearchBox onSearch={() => apply({ ...draft, q: draft.q.trim() })} onReset={reset} busy={state.kind === "loading"}>
          <SearchRow label="상태">
            <select className="inp" aria-label="상태" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as Filters["status"] })}>
              <option value="">전체</option>
              {(Object.keys(NOTICE_STATUS) as NoticeStatus[]).map((s) => (
                <option key={s} value={s}>
                  {NOTICE_STATUS[s].label}
                </option>
              ))}
            </select>
          </SearchRow>
          <SearchRow label="분류">
            <select className="inp" aria-label="분류" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as Filters["category"] })}>
              <option value="">전체</option>
              {(Object.keys(NOTICE_CATEGORY) as NoticeCategory[]).map((c) => (
                <option key={c} value={c}>
                  {NOTICE_CATEGORY[c].label}
                </option>
              ))}
            </select>
          </SearchRow>
          <SearchRow label="검색어">
            <input className="inp" type="search" aria-label="제목" placeholder="제목" maxLength={MAX_SEARCH_LENGTH} value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} />
          </SearchRow>
        </SearchBox>

        <div className="card">
          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" && <ErrorState title="공지를 불러오지 못했습니다." onRetry={() => void load(applied.status)} />}
          {state.kind === "ok" &&
            (items.length === 0 ? (
              <div className="st">
                <span className="t">{filtered ? "일치하는 공지가 없습니다." : "아직 공지가 없습니다."}</span>
                {filtered ? (
                  <button className="btn btn-sm btn-out" type="button" onClick={reset}>
                    조건 초기화
                  </button>
                ) : (
                  canEdit && (
                    <Link className="btn btn-sm" href="/admin/support/notices/new">
                      공지 작성
                    </Link>
                  )
                )}
              </div>
            ) : (
              <>
                <ListHead total={items.length} loaded />
                <div style={{ overflowX: "auto" }}>
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>분류</th>
                        <th>제목</th>
                        <th>대상</th>
                        <th>게시일</th>
                        <th>상태</th>
                        {canEdit && <th>관리</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((n) => (
                        <tr key={n.id} data-testid="notice-row">
                          <td>
                            <span className={`bdg ${NOTICE_CATEGORY[n.category].cls}`}>{NOTICE_CATEGORY[n.category].label}</span>
                          </td>
                          <td className="col-text">
                            {canEdit ? (
                              <Link className="fw6" href={`/admin/support/notices/${n.id}`}>
                                {n.title}
                              </Link>
                            ) : (
                              <span className="fw6">{n.title}</span>
                            )}{" "}
                            {n.isPinned && <span className="bdg b-fail">중요</span>}
                          </td>
                          <td>{NOTICE_AUDIENCE[n.audience]}</td>
                          <td>{day(n.publishedAt)}</td>
                          <td>
                            <span className={`bdg ${NOTICE_STATUS[n.status].cls}`}>{NOTICE_STATUS[n.status].label}</span>
                          </td>
                          {canEdit && (
                            <td>
                              <span className="row" style={{ gap: 6 }}>
                                <Link className="btn btn-sm btn-out" href={`/admin/support/notices/${n.id}`}>
                                  수정
                                </Link>
                                <button className="btn btn-sm btn-out" type="button" onClick={() => setTarget(n)}>
                                  삭제
                                </button>
                              </span>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
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
      </main>
      {target && (
        <DeleteDialog
          notice={target}
          onClose={() => setTarget(null)}
          onDone={() => {
            setTarget(null);
            setToast({ text: "공지를 삭제했습니다." });
            void load(applied.status);
          }}
          onStale={() => {
            setTarget(null);
            setToast({ text: "다른 곳에서 먼저 수정됐습니다. 목록을 새로 불러옵니다.", neg: true });
            void load(applied.status);
          }}
        />
      )}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}

export default function NoticesPage() {
  return (
    <Suspense fallback={null}>
      <NoticeList />
    </Suspense>
  );
}
