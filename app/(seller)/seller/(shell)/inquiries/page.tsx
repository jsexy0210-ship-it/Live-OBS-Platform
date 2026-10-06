"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead } from "../../../../../components/admin-ui";
import { Topbar } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";
import { INQUIRY_CATEGORY, INQUIRY_WRITE_CATEGORIES, SELLER_INQUIRY_STATUS, type InquiryCategory, type InquiryStatus } from "../../../../../components/seller/platformInquiry";
import { formatDate, formatDateTime } from "../../../../../lib/client/format";
import { useListFilters } from "../../../../(admin)/admin/_components/useListFilters";

// SA-113 내 문의 목록(파트너스 관리자, 공지 · 문의 › 내 문의, 정본 v310). 보낸 문의와 상태. 대표자는 쇼핑몰 문의 전부, 직원은 자기가 쓴 것만(서버 기준).
// API: GET /api/seller/platform-inquiries?cursor=&status=&category= → { items, counts, newReplyCount, avgFirstReplyMinutes, nextCursor }. 마지막 글 최신 순 20건.
// 쪽은 서버 cursor를 쌓아 이전·다음으로 오간다. 조건(상태·문의 종류)은 주소에 둔다(docs/IA.md Back 규칙 3항).
type Row = { id: string; category: InquiryCategory; title: string; status: InquiryStatus; createdAt: string; lastMessageAt: string; lastReplyAt: string | null; hasNewReply: boolean };
type Counts = { all: number; open: number; answered: number; closed: number };
type Page = { items: Row[]; counts: Counts; newReplyCount: number; avgFirstReplyMinutes: number | null; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; page: Page };
const DEFAULTS = { status: "", category: "" };
const TABS: { key: string; label: string; count: (c: Counts) => number }[] = [
  { key: "", label: "전체", count: (c) => c.all },
  { key: "OPEN", label: "접수", count: (c) => c.open },
  { key: "ANSWERED", label: "답변 완료", count: (c) => c.answered },
  { key: "CLOSED", label: "종료", count: (c) => c.closed },
];
const avgText = (m: number) => (m < 60 ? `${Math.max(1, m)}분` : `${Math.round(m / 60)}시간`);

export default function InquiriesPage() {
  const { applied, apply, reset } = useListFilters(DEFAULTS);
  const [state, setState] = useState<Load>({ kind: "loading" });
  // 지금까지 거쳐 온 쪽의 cursor(첫 쪽은 null). 마지막 원소가 지금 쪽이다
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const seq = useRef(0);

  const load = useCallback(async (cursor: string | null) => {
    const n = ++seq.current;
    setState({ kind: "loading" });
    const q = new URLSearchParams();
    if (applied.status) q.set("status", applied.status);
    if (applied.category) q.set("category", applied.category);
    if (cursor) q.set("cursor", cursor);
    const r = await api<Page>(`/api/seller/platform-inquiries${q.size ? `?${q}` : ""}`);
    if (n !== seq.current) return;
    setState(r.ok ? { kind: "ok", page: r.data } : { kind: "error" });
  }, [applied]);
  useEffect(() => {
    setCursors([null]);
    void load(null);
  }, [load]);

  const go = (next: (string | null)[]) => {
    setCursors(next);
    void load(next[next.length - 1]);
  };
  const page = state.kind === "ok" ? state.page : null;
  const rows = page?.items ?? [];
  const filtered = !!(applied.status || applied.category);
  const no = cursors.length;
  const first = (no - 1) * 20 + 1;

  return (
    <>
      <Topbar crumb="공지 · 문의 › 내 문의" />
      <main className="main">
        <PageHead description="ONQ 운영팀에 남긴 문의와 답변을 확인합니다."
          title="내 문의"
          back="/seller/notices"
          actions={
            <>
              {page && page.newReplyCount > 0 && <span className="bdg b-pending nodot">답변 {page.newReplyCount}</span>}
              <Link className="btn" href="/seller/inquiries/new">
                문의하기
              </Link>
            </>
          }
        />
        <div className="card" style={{ overflow: "visible" }}>
          <div className="au-lh">
            <div className="seg" role="group" aria-label="상태">
              {TABS.map((t) => (
                <button key={t.key} type="button" className={applied.status === t.key ? "on" : ""} aria-pressed={applied.status === t.key} onClick={() => apply({ ...applied, status: t.key })}>
                  {t.label}
                  {page ? ` ${t.count(page.counts)}` : ""}
                </button>
              ))}
            </div>
            <div className="au-lh-act">
              <label htmlFor="iq-kind" style={{ whiteSpace: "nowrap" }}>문의 종류</label>
              <select id="iq-kind" className="inp" style={{ width: 160 }} value={applied.category} onChange={(e) => apply({ ...applied, category: e.target.value })}>
                <option value="">전체</option>
                {INQUIRY_WRITE_CATEGORIES.map((k) => (
                  <option key={k} value={k}>
                    {INQUIRY_CATEGORY[k]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" && <ErrorState title="목록을 불러오지 못했습니다" onRetry={() => void load(cursors[cursors.length - 1])} />}
          {page && rows.length === 0 && (
            <div className="st" style={{ boxShadow: "none" }}>
              {filtered ? (
                <>
                  <span className="t">조건에 맞는 문의가 없습니다</span>
                  <button className="btn btn-sm btn-out" type="button" onClick={reset}>
                    조건 초기화
                  </button>
                </>
              ) : (
                <>
                  <span className="t">보낸 문의가 없습니다</span>
                  <span className="s">궁금한 점이나 오류는 「문의하기」로 보내 주십시오.</span>
                  <Link className="btn btn-sm" href="/seller/inquiries/new">
                    문의하기
                  </Link>
                </>
              )}
            </div>
          )}
          {page && rows.length > 0 && (
            <div className="au-lt-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>제목</th>
                    <th style={{ width: 120 }}>문의 종류</th>
                    <th style={{ width: 110 }}>작성일</th>
                    <th style={{ width: 150 }}>마지막 글</th>
                    <th style={{ width: 170 }}>상태</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} data-testid="inquiry-row">
                      <td className="col-text ell">
                        <Link href={`/seller/inquiries/${r.id}`} className="fw6">
                          {r.title}
                        </Link>
                      </td>
                      <td>{INQUIRY_CATEGORY[r.category]}</td>
                      <td className="num">{formatDate(r.createdAt)}</td>
                      <td className="num">{r.lastReplyAt ? formatDateTime(r.lastReplyAt) : "—"}</td>
                      <td>
                        <span className={`bdg ${SELLER_INQUIRY_STATUS[r.status].cls}`}>{SELLER_INQUIRY_STATUS[r.status].label}</span>
                        {r.hasNewReply && <span className="bdg b-info nodot"> 새 답변</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {page && rows.length > 0 && (
            <div className="au-lh">
              <span className="t-l2 c-alt">
                20개씩 · {first}–{first + rows.length - 1} 표시
                {page.avgFirstReplyMinutes !== null && ` · 평균 첫 답변 ${avgText(page.avgFirstReplyMinutes)} (평일 10~18시)`}
              </span>
              <div className="au-lh-act">
                <button className="btn btn-sm btn-out" type="button" disabled={no === 1} onClick={() => go(cursors.slice(0, -1))}>
                  ‹ 이전
                </button>
                <button className="btn btn-sm btn-out" type="button" disabled={!page.nextCursor} onClick={() => page.nextCursor && go([...cursors, page.nextCursor])}>
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
