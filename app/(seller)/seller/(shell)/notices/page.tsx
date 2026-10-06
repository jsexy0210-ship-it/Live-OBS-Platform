"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead, ListTable, ListHead } from "../../../../../components/admin-ui";
import { Topbar } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";
import { NOTICE_CATEGORY, NOTICE_FILTERS, type NoticeItem } from "../../../../../components/seller/platformNotice";
import { formatDate } from "../../../../../lib/client/format";
import { useListFilters } from "../../../../(admin)/admin/_components/useListFilters";

// SA-111 공지사항 목록(파트너스 관리자, 공지 · 문의, 정본 v302). 플랫폼이 보낸 점검·정책·기능 안내. 고정 공지는 첫 쪽 위에 따로 보인다.
// 누구나 볼 수 있고 구독이 잠기거나 이용 정지 중에도 열린다. API: GET /api/seller/platform-notices?cursor=&q=&category=&unread=1 → { pinned, items, nextCursor, unreadCount }.
// 쪽은 서버가 20개씩 주는 cursor를 쌓아 이전·다음으로 오간다. 조건(분류·안 읽은 것만·검색어)은 주소에 둔다(docs/IA.md Back 규칙 3항).
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; pinned: NoticeItem[]; items: NoticeItem[]; next: string | null; unread: number };
const DEFAULTS = { category: "", unread: "", q: "" };

export default function NoticesPage() {
  const { applied, draft, setDraft, apply, reset } = useListFilters(DEFAULTS);
  const [state, setState] = useState<Load>({ kind: "loading" });
  // 지금까지 거쳐 온 쪽의 cursor(첫 쪽은 null). 마지막 원소가 지금 쪽이다
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const seq = useRef(0);

  const load = useCallback(async (cursor: string | null) => {
    const n = ++seq.current;
    setState({ kind: "loading" });
    const q = new URLSearchParams();
    if (applied.category) q.set("category", applied.category);
    if (applied.unread) q.set("unread", "1");
    if (applied.q.trim()) q.set("q", applied.q.trim());
    if (cursor) q.set("cursor", cursor);
    const r = await api<{ pinned: NoticeItem[]; items: NoticeItem[]; nextCursor: string | null; unreadCount: number }>(`/api/seller/platform-notices${q.size ? `?${q}` : ""}`);
    if (n !== seq.current) return;
    if (!r.ok) return setState({ kind: "error" });
    setState({ kind: "ok", pinned: r.data.pinned, items: r.data.items, next: r.data.nextCursor, unread: r.data.unreadCount });
  }, [applied]);
  // 조건이 바뀌면 첫 쪽부터 다시 본다
  useEffect(() => {
    setCursors([null]);
    void load(null);
  }, [load]);

  const go = (next: (string | null)[]) => {
    setCursors(next);
    void load(next[next.length - 1]);
  };
  const filtered = !!(applied.category || applied.unread || applied.q.trim());
  const rows = state.kind === "ok" ? [...state.pinned, ...state.items] : [];
  const page = cursors.length;
  const first = (page - 1) * 20 + 1;

  return (
    <>
      <Topbar crumb="공지 · 문의 › 공지사항" />
      <main className="main">
        <PageHead description="ONQ의 공지와 운영 안내를 확인합니다."
          title="공지사항"
          back={false}
          actions={
            <>
              {state.kind === "ok" && state.unread > 0 && <span className="bdg b-info nodot">새 글 {state.unread}</span>}
              <Link className="btn btn-out" href="/seller/inquiries">
                내 문의
              </Link>
            </>
          }
        />
        <div className="au-list-section" >
          <div className="au-lh">
            <div className="seg" role="group" aria-label="분류">
              {NOTICE_FILTERS.map((f) => (
                <button key={f.key} type="button" className={applied.category === f.key ? "on" : ""} aria-pressed={applied.category === f.key} onClick={() => apply({ ...applied, category: f.key })}>
                  {f.label}
                </button>
              ))}
            </div>
            <form
              className="au-lh-act"
              onSubmit={(e) => {
                e.preventDefault();
                apply({ ...applied, q: draft.q.trim() });
              }}
            >
              <label className="chk">
                <input type="checkbox" checked={!!applied.unread} onChange={(e) => apply({ ...applied, unread: e.target.checked ? "1" : "" })} />
                안 읽은 것만
              </label>
              <input className="inp" type="search" aria-label="공지 검색" placeholder="검색어 입력" maxLength={50} value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} style={{ width: 200 }} aria-description="검색" />
              <button className="btn btn-sm btn-out" type="submit">
                검색
              </button>
            </form>
          </div>
          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" && <ErrorState title="목록을 불러오지 못했습니다" onRetry={() => void load(cursors[cursors.length - 1])} />}
          {state.kind === "ok" && rows.length === 0 && (
            <div className="st" style={{ boxShadow: "none" }}>
              {filtered ? (
                <>
                  <span className="t">{applied.q.trim() ? `「${applied.q.trim()}」 검색 결과가 없습니다` : "조건에 맞는 공지가 없습니다"}</span>
                  <button className="btn btn-sm btn-out" type="button" onClick={reset}>
                    검색 초기화
                  </button>
                </>
              ) : (
                <span className="t">아직 공지가 없습니다</span>
              )}
            </div>
          )}
          {state.kind === "ok" && rows.length > 0 && (
            <>
<ListHead total={rows.length} loaded />
<ListTable>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>제목</th>
                    <th style={{ width: 120 }}>분류</th>
                    <th style={{ width: 120 }}>올린 날</th>
                    <th style={{ width: 90 }}>읽음</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((n) => (
                    <tr key={n.id} data-testid="notice-row">
                      <td className="col-text">
                        <Link href={`/seller/notices/${n.id}`} className={n.read ? undefined : "fw6"}>
                          {n.title}
                        </Link>{" "}
                        {n.isPinned && <span className="bdg b-gray nodot">맨 위 고정</span>}
                      </td>
                      <td>
                        <span className={`bdg ${NOTICE_CATEGORY[n.category].cls}`}>{NOTICE_CATEGORY[n.category].label}</span>
                      </td>
                      <td className="num">{formatDate(n.publishedAt)}</td>
                      <td>
                        <span className={`bdg ${n.read ? "b-done" : "b-gray nodot"}`}>{n.read ? "읽음" : "안 읽음"}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ListTable>
</>
          )}
          {state.kind === "ok" && rows.length > 0 && (
            <div className="au-lh">
              <span className="t-l2 c-alt">
                20개씩 · {first}–{first + rows.length - 1} 표시
              </span>
              <div className="au-lh-act">
                <button className="btn btn-sm btn-out" type="button" disabled={page === 1} onClick={() => go(cursors.slice(0, -1))}>
                  ‹ 이전
                </button>
                <button className="btn btn-sm btn-out" type="button" disabled={!state.next} onClick={() => state.next && go([...cursors, state.next])}>
                  다음 ›
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
