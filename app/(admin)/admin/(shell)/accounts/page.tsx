"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHead } from "../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../components/seller/States";
import { adminApi } from "../../_components/api";
import { AccountDialog } from "../../_components/AccountDialog";
import { AdminTopbar } from "../../_components/AdminShell";
import { ROLE_LABEL, STATUS_LABEL, type AdminAccount } from "../../_components/accounts";
import { dayTime } from "../../_components/partners";

// MA-061 관리자 계정 목록·MA-062 추가·수정(GET·POST /api/admin/admins, PATCH …/{id}). 최고관리자만 열린다(메뉴·주소 모두 막힘).
// 최고관리자 행에는 정지·역할 변경이 없다(이름만 수정, 대표님 지시 2026-10-04).
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; items: AdminAccount[] };

export default function AccountsPage() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [dialog, setDialog] = useState<{ account: AdminAccount | null } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await adminApi<{ admins: AdminAccount[] }>("/api/admin/admins");
    setState(r.ok ? { kind: "ok", items: r.data.admins } : { kind: "error" });
  }, []);
  useEffect(() => void load(), [load]);

  const saved = (a: AdminAccount, created: boolean) => {
    setDialog(null);
    setToast(created ? "계정을 추가했습니다." : "저장했습니다.");
    setState((s) => (s.kind === "ok" ? { kind: "ok", items: created ? [...s.items, a] : s.items.map((x) => (x.id === a.id ? a : x)) } : s));
  };

  const items = state.kind === "ok" ? state.items : [];
  return (
    <>
      <AdminTopbar crumb="관리자 › 관리자 계정" />
      <main className="main">
        <PageHead
          title="관리자 계정"
          actions={
            <button className="btn" type="button" onClick={() => setDialog({ account: null })}>
              계정 추가
            </button>
          }
        />
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
                    {items.map((a) => (
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
                          <button className="btn btn-sm btn-out" type="button" onClick={() => setDialog({ account: a })}>
                            수정
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row" style={{ padding: "12px 16px" }}>
                <span className="t-c1 c-alt">{items.length}명</span>
              </div>
            </>
          )}
        </div>
      </main>
      {dialog && <AccountDialog account={dialog.account} onClose={() => setDialog(null)} onDone={saved} />}
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
