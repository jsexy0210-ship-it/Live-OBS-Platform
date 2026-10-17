"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../../components/seller/States";
import { adminApi } from "../../../_components/api";
import { AdminTopbar } from "../../../_components/AdminShell";
import { type PermissionTable } from "../../../_components/accounts";

// MA-063 역할별 권한 표(GET /api/admin/permissions, 최고관리자만, 조회만). 정본: design/project/MA-063.dc.html(FINAL v329).
// 권한 정본은 서버의 권한 표이며 「가능」과 「—」 두 값뿐이다. 기능 묶음 6그룹과 라벨은 정본, 작은 글자는 서버 권한 키.
// 역할 머리의 (n)은 이용 중인 관리자 계정 수(GET /api/admin/admins, 같은 최고관리자 권한). 못 불러오면 수만 뺀다.
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; table: PermissionTable; counts: Record<string, number> | null };
const GROUPS: { title: string; items: [string, string][] }[] = [
  { title: "화면 보기 · 기록", items: [["platform.read", "모든 화면 보기"], ["audit.read", "로그 추적 조회"]] },
  { title: "파트너스", items: [["seller.moderate", "파트너스 이용 정지 · 해제"], ["seller.impersonate", "파트너스 화면 대신 보기"]] },
  { title: "요금 · 결제", items: [["billing.manage", "청구 · 요금 관리"], ["billing.price", "요금제 가격 변경"], ["billing.refund", "구독 환불 승인"]] },
  { title: "고객지원", items: [["support.manage", "고객지원 관리"], ["support.assign", "파트너스 문의 담당 배정"]] },
  { title: "설정 · 관리", items: [["admin.manage", "관리자 계정 관리"], ["system.manage", "서비스 설정 바꾸기"], ["infra.manage", "인프라 · 비용"], ["vendor.manage", "외부 서비스 업체 관리"]] },
];
// 정본의 역할 이름(고객 지원은 「CS」)
const ROLE_NAME: Record<string, string> = { SUPER_ADMIN: "최고관리자", OPERATIONS: "운영", CS: "CS", READ_ONLY: "조회 전용" };

export default function RolesPage() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const [r, a] = await Promise.all([adminApi<PermissionTable>("/api/admin/permissions"), adminApi<{ admins: { role: string; status: string }[] }>("/api/admin/admins")]);
    if (!r.ok) return setState({ kind: "error" });
    const counts = a.ok ? a.data.admins.filter((x) => x.status === "ACTIVE").reduce<Record<string, number>>((m, x) => ({ ...m, [x.role]: (m[x.role] ?? 0) + 1 }), {}) : null;
    setState({ kind: "ok", table: r.data, counts });
  }, []);
  useEffect(() => void load(), [load]);

  const table = state.kind === "ok" ? state.table : null;
  // 서버가 정본 묶음에 없는 권한을 더하면 맨 아래 「그 밖의 기능」에 권한 키로 보인다(빠뜨리지 않는다)
  const known = new Set(GROUPS.flatMap((g) => g.items.map(([k]) => k)));
  const extra = table ? table.permissions.filter((p) => !known.has(p.permission)).map((p) => [p.permission, p.permission] as [string, string]) : [];
  const groups = extra.length > 0 ? [...GROUPS, { title: "그 밖의 기능", items: extra }] : GROUPS;
  const rolesOf = (key: string) => table?.permissions.find((p) => p.permission === key)?.roles ?? [];

  return (
    <>
      <AdminTopbar crumb="설정 › 역할별 권한" />
      <main className="main">
        <PageHead title="역할별로 할 수 있는 일" />
        {state.kind === "loading" && <LoadingRows rows={5} />}
        {state.kind === "error" && <ErrorState title="불러오지 못했습니다." onRetry={() => void load()} />}
        {state.kind === "ok" && table && (
          <div className="col" style={{ gap: 16 }}>
            <div className="msg msg-info" role="note">
              {table.roles.length}개 역할이 할 수 있는 일을 정리한 고정 표입니다 · 이 화면에서는 조회만 할 수 있습니다 · 권한 정본은 서버의 권한 표({table.permissions.length}개)이며 「가능」과 「—」 두 값뿐입니다 · 최고관리자는 한 명뿐이고 시드로만 만듭니다
            </div>
            <div className="row t-c1 c-alt" style={{ gap: 16 }}>
              <span>
                <span className="bdg b-done">가능</span> 할 수 있음
              </span>
              <span>
                <span className="bdg b-gray">—</span> 할 수 없음 · 메뉴나 버튼이 보이지 않거나 서버가 막습니다
              </span>
            </div>
            <div className="card">
              <div style={{ overflowX: "auto" }}>
                <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                  <thead>
                    <tr>
                      <th className="col-text">
                        기능 <span className="c-alt fw4">(작은 글자는 서버 권한 키)</span>
                      </th>
                      {table.roles.map((r) => (
                        <th key={r}>
                          {ROLE_NAME[r] ?? r}
                          {state.counts ? ` (${state.counts[r] ?? 0})` : ""}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {groups.flatMap((g) => [
                      <tr key={`g-${g.title}`}>
                        <td className="col-text fw6" colSpan={1 + table.roles.length} style={{ background: "var(--wds-fill-alternative, #f4f5f7)" }}>
                          {g.title}
                        </td>
                      </tr>,
                      ...g.items.map(([key, label]) => (
                        <tr key={key} data-testid="permission-row">
                          <td className="col-text">
                            {label} <span className="t-c1 c-alt">{key}</span>
                          </td>
                          {table.roles.map((r) => (
                            <td key={r}>{rolesOf(key).includes(r) ? <span className="bdg b-done">가능</span> : <span className="bdg b-gray">—</span>}</td>
                          ))}
                        </tr>
                      )),
                    ])}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
