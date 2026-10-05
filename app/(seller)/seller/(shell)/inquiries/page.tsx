"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ListHead, PageHead } from "../../../../../components/admin-ui";
import { PlatformTabs } from "../../../../../components/seller/PlatformTabs";
import { Topbar } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Toast } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";
import { INQUIRY_CATEGORY, INQUIRY_STATUS, type InquiryCategory, type InquiryStatus } from "../../../../../components/seller/platformInquiry";
import { kstText } from "../banners/_shared/ui";

// SA-113 내 문의 목록(파트너스 관리자, 공지 · 문의 › 내 문의). 보낸 문의와 상태. 대표자는 쇼핑몰 문의 전부, 직원은 자기가 쓴 것만(서버 기준).
// API: GET /api/seller/platform-inquiries?cursor= → { items, nextCursor }. hasNewReply면 「새 답변」을 보인다.
type Row = { id: string; category: InquiryCategory; title: string; status: InquiryStatus; createdAt: string; lastMessageAt: string; authorName: string | null; hasNewReply: boolean };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; rows: Row[]; next: string | null };

export default function InquiriesPage() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ items: Row[]; nextCursor: string | null }>("/api/seller/platform-inquiries");
    if (!r.ok) return setState({ kind: "error" });
    setState({ kind: "ok", rows: r.data.items, next: r.data.nextCursor });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    const r = await api<{ items: Row[]; nextCursor: string | null }>(`/api/seller/platform-inquiries?cursor=${encodeURIComponent(state.next)}`);
    setMore(false);
    if (!r.ok) return setToast("더 불러오지 못했습니다. 다시 눌러 주십시오");
    setState({ kind: "ok", rows: [...state.rows, ...r.data.items], next: r.data.nextCursor });
  };

  const rows = state.kind === "ok" ? state.rows : [];

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
          <PlatformTabs active="inquiries" />
          {state.kind === "ok" && <ListHead total={rows.length} loaded={!!state.next} />}
          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" && <ErrorState title="문의를 불러오지 못했습니다" onRetry={() => void load()} />}
          {state.kind === "ok" && rows.length === 0 && (
            <div className="st" style={{ boxShadow: "none" }}>
              <div className="st-ic">0</div>
              <span className="t">보낸 문의가 없습니다</span>
              <span className="s">궁금한 점이나 오류는 「문의하기」로 보내 주십시오.</span>
            </div>
          )}
          {state.kind === "ok" && rows.length > 0 && (
            <div className="au-lt-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 110 }}>유형</th>
                    <th>제목</th>
                    <th style={{ width: 100 }}>작성자</th>
                    <th style={{ width: 110 }}>상태</th>
                    <th style={{ width: 160 }}>마지막 글</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} data-testid="inquiry-row">
                      <td>{INQUIRY_CATEGORY[r.category]}</td>
                      <td className="col-text ell">
                        <Link href={`/seller/inquiries/${r.id}`} className="fw6">
                          {r.title}
                        </Link>
                        {r.hasNewReply && <span className="bdg b-info nodot"> 새 답변</span>}
                      </td>
                      <td>{r.authorName ?? "-"}</td>
                      <td>
                        <span className={`bdg ${INQUIRY_STATUS[r.status].cls}`}>{INQUIRY_STATUS[r.status].label}</span>
                      </td>
                      <td className="num">{kstText(r.lastMessageAt)}</td>
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
