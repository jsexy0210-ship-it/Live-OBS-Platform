"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHead, ListTable, ListHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../../components/seller/States";
import { adminApi } from "../../../_components/api";
import { AdminTopbar } from "../../../_components/AdminShell";
import { PERMISSION_LABEL, ROLE_LABEL, type PermissionTable } from "../../../_components/accounts";

// MA-063 역할별 권한 표(GET /api/admin/permissions, 최고관리자만, 조회만). 권한 정본은 서버의 권한 표다.
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; table: PermissionTable };

export default function RolesPage() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await adminApi<PermissionTable>("/api/admin/permissions");
    setState(r.ok ? { kind: "ok", table: r.data } : { kind: "error" });
  }, []);
  useEffect(() => void load(), [load]);

  return (
    <>
      <AdminTopbar crumb="관리자 › 역할별로 할 수 있는 일" />
      <main className="main">
        <PageHead description="각 관리자 역할이 조회하거나 처리할 수 있는 일을 확인합니다." title="역할별로 할 수 있는 일" />
        <div className="au-list-section">
          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" && <ErrorState title="역할별로 할 수 있는 일을 불러오지 못했습니다." onRetry={() => void load()} />}
          {state.kind === "ok" && (
            <>
              <ListHead total={state.table.permissions.length} loaded />
              <ListTable>
              <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                <thead>
                  <tr>
                    <th>권한</th>
                    {state.table.roles.map((r) => (
                      <th key={r}>{ROLE_LABEL[r]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {state.table.permissions.map((p) => (
                    <tr key={p.permission} data-testid="permission-row">
                      <td className="fw6 col-text">{PERMISSION_LABEL[p.permission] ?? "그 밖의 기능"}</td>
                      {state.table.roles.map((r) => (
                        <td key={r}>{p.roles.includes(r) ? "가능" : "-"}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </ListTable>
            </>
          )}
        </div>
      </main>
    </>
  );
}
