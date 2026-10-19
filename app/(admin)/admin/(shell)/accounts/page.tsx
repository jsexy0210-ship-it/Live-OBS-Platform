"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PageHead, Pagination } from "../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../components/seller/States";
import { adminApi } from "../../_components/api";
import { AdminTopbar } from "../../_components/AdminShell";
import { ROLE_LABEL, STATUS_LABEL, type AdminAccount, type AdminRoleCode } from "../../_components/accounts";
import { dayTime } from "../../_components/partners";

// MA-061 관리자 계정 목록·MA-062 추가·수정(GET·POST /api/admin/admins, PATCH …/{id}). 최고관리자만 열린다(메뉴·주소 모두 막힘).
// 최고관리자 행에는 정지·역할 변경이 없다(이름만 수정, 대표님 지시 2026-10-04).
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; items: AdminAccount[] };

export default function AccountsPage() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [page, setPage] = useState(1);
  useEffect(() => { const n = Number(new URLSearchParams(window.location.search).get("page")); if (Number.isInteger(n) && n > 0) setPage(n); }, []);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await adminApi<{ admins: AdminAccount[] }>("/api/admin/admins");
    setState(r.ok ? { kind: "ok", items: r.data.admins } : { kind: "error" });
  }, []);
  useEffect(() => void load(), [load]);

  const items = state.kind === "ok" ? state.items : [];
  const pageCount = Math.ceil(items.length / 10);
  const currentPage = Math.min(page, pageCount || 1);
  const pageItems = items.slice((currentPage - 1) * 10, currentPage * 10);
  useEffect(() => { if (state.kind === "ok") setPage(p => Math.min(p, pageCount || 1)); }, [state.kind, pageCount]);
  return (
    <>
      <AdminTopbar crumb="관리자 › 관리자 계정" />
      <main className="main">
        <PageHead
          title="관리자 계정"
          actions={
            <>
              <Link className="btn btn-out" href="/admin/accounts/roles">
                권한
              </Link>
              <Link className="btn" href={`/admin/accounts/new?returnTo=${encodeURIComponent(`/admin/accounts?page=${currentPage}`)}`}>
                계정 추가
              </Link>
            </>
          }
        />
        <div className="t-b2" style={{ padding: "12px 16px", background: "var(--info-bg)", border: "1px solid var(--info-bg)", borderRadius: 0 }}>최고관리자만 볼 수 있는 메뉴입니다 · 최고관리자는 대표 1명이며 바꾸거나 추가할 수 없습니다 · 다른 관리자는 운영 · 고객 지원 · 조회 전용 중에서 정합니다.</div>
        {state.kind === "ok" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
            {(["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"] as AdminRoleCode[]).map((r) => (
              <div key={r} className="card pad col" style={{ gap: 4 }}>
                <span className="t-l2 c-alt">{ROLE_LABEL[r]}</span>
                <span className="t-h2" data-testid={`role-count-${r}`}>
                  {items.filter((a) => a.role === r).length}명
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="card">
          {state.kind === "loading" && <LoadingRows rows={4} />}
          {state.kind === "error" && <ErrorState title="관리자 계정을 불러오지 못했습니다." onRetry={() => void load()} />}
          {state.kind === "ok" && (
            <>
              <div style={{ overflowX: "auto" }}>
                <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                  <thead>
                    <tr>
                      <th>이름</th>
                      <th>이메일</th>
                      <th>역할</th>
                      <th>상태</th>
                      <th>최근 로그인</th>
                      <th>추가일</th>
                      <th>작업</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageItems.map((a) => (
                      <tr key={a.id} data-testid="account-row">
                        <td className="fw6">{a.name}</td>
                        <td>{a.email}</td>
                        <td>{ROLE_LABEL[a.role]}</td>
                        <td>
                          <span className={`bdg ${STATUS_LABEL[a.status].cls}`}>{STATUS_LABEL[a.status].label}</span>
                        </td>
                        <td className="num">{dayTime(a.lastLoginAt)}</td>
                        <td className="num">{dayTime(a.createdAt)}</td>
                        <td>
                          <Link className="btn btn-sm btn-out" href={`/admin/accounts/${a.id}?returnTo=${encodeURIComponent(`/admin/accounts?page=${currentPage}`)}`}>상세</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {pageCount > 1 && <Pagination page={currentPage} pageCount={pageCount} onChange={setPage} label="관리자 계정 페이지 이동" />}
              <div className="row" style={{ padding: "12px 16px" }}>
                <span className="t-c1 c-alt">{items.length}명</span>
              </div>
            </>
          )}
        </div>
      </main>
    </>
  );
}
