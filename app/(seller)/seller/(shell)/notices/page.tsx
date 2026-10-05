"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ListHead, PageHead } from "../../../../../components/admin-ui";
import { PlatformTabs } from "../../../../../components/seller/PlatformTabs";
import { Topbar } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Toast } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";
import { NOTICE_CATEGORY, type NoticeItem } from "../../../../../components/seller/platformNotice";
import { kstText } from "../banners/_shared/ui";

// SA-111 공지사항 목록(파트너스 관리자, 공지 · 문의). 플랫폼이 보낸 점검·정책·기능 안내. 고정 공지는 첫 쪽 위에 따로 보인다.
// 누구나 볼 수 있고 구독이 잠기거나 이용 정지 중에도 열린다. API: GET /api/seller/platform-notices?cursor= → { pinned, items, nextCursor }.
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; pinned: NoticeItem[]; items: NoticeItem[]; next: string | null };

export default function NoticesPage() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ pinned: NoticeItem[]; items: NoticeItem[]; nextCursor: string | null }>("/api/seller/platform-notices");
    if (!r.ok) return setState({ kind: "error" });
    setState({ kind: "ok", pinned: r.data.pinned, items: r.data.items, next: r.data.nextCursor });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    const r = await api<{ items: NoticeItem[]; nextCursor: string | null }>(`/api/seller/platform-notices?cursor=${encodeURIComponent(state.next)}`);
    setMore(false);
    if (!r.ok) return setToast("더 불러오지 못했습니다. 다시 눌러 주십시오");
    setState({ ...state, items: [...state.items, ...r.data.items], next: r.data.nextCursor });
  };

  const rows = state.kind === "ok" ? [...state.pinned, ...state.items] : [];

  return (
    <>
      <Topbar crumb="공지 · 문의" />
      <main className="main">
        <PageHead
          title="공지 · 문의"
          actions={
            <Link className="btn" href="/seller/inquiries/new">
              문의하기
            </Link>
          }
        />
        <div className="card" style={{ overflow: "visible" }}>
          <PlatformTabs active="notices" />
          {state.kind === "ok" && <ListHead total={rows.length} loaded={!!state.next} />}
          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" && <ErrorState title="공지를 불러오지 못했습니다" onRetry={() => void load()} />}
          {state.kind === "ok" && rows.length === 0 && (
            <div className="st" style={{ boxShadow: "none" }}>
              <div className="st-ic">0</div>
              <span className="t">등록된 공지가 없습니다</span>
              <span className="s">점검·정책·기능 안내가 올라오면 여기에 표시됩니다.</span>
            </div>
          )}
          {state.kind === "ok" && rows.length > 0 && (
            <div className="au-lt-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 90 }}>분류</th>
                    <th>제목</th>
                    <th style={{ width: 160 }}>게시일</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((n) => (
                    <tr key={n.id} data-testid="notice-row">
                      <td>
                        <span className={`bdg ${NOTICE_CATEGORY[n.category].cls}`}>{NOTICE_CATEGORY[n.category].label}</span>
                      </td>
                      <td className="col-text ell">
                        {n.isPinned && <span className="bdg b-info nodot">고정</span>}{" "}
                        <Link href={`/seller/notices/${n.id}`} className="fw6">
                          {n.title}
                        </Link>
                      </td>
                      <td className="num">{kstText(n.publishedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {state.kind === "ok" && state.next && (
            <div className="row" style={{ padding: "12px 20px", justifyContent: "center" }}>
              <button className={`btn btn-sm btn-out${more ? " is-loading" : ""}`} type="button" disabled={more} onClick={() => void loadMore()}>
                더 불러오기
              </button>
            </div>
          )}
        </div>
      </main>
      {toast && <Toast text={toast} neg onDone={() => setToast(null)} />}
    </>
  );
}
