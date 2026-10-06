"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead } from "../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../components/seller/States";
import { adminApi } from "../../_components/api";
import { AdminTopbar } from "../../_components/AdminShell";
import { dayTime } from "../../_components/partners";

// MA-002 알림 센터(GET /api/admin/notifications, 모든 마스터 역할, 조회만). 지금 알림은 답변을 기다리는 파트너스 문의(최근 30건)뿐이고, 항목을 누르면 처리 화면으로 간다.
// 서버가 읽음 처리를 주지 않아 「읽음」 표시·버튼은 두지 않는다. 문의가 답변되면 목록에서 빠진다.
type Item = { id: string; kind: "INQUIRY_WAITING"; title: string; href: string; createdAt: string; unread: boolean };
type Data = { items: Item[]; unreadCount: number };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; data: Data };
const KIND_LABEL: Record<Item["kind"], string> = { INQUIRY_WAITING: "답변 대기 문의" };

export default function AdminNotificationsPage() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const reqId = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    setState({ kind: "loading" });
    const r = await adminApi<Data>("/api/admin/notifications");
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error" });
  }, []);
  useEffect(() => void load(), [load]);

  const d = state.kind === "ok" ? state.data : null;
  return (
    <>
      <AdminTopbar crumb="알림 센터" />
      <main className="main">
        <PageHead description="결제 연결 오류와 운영 알림을 확인하고 해당 항목으로 이동합니다."
          title="알림 센터"
          actions={
            <button className="btn btn-out" type="button" onClick={() => void load()} disabled={state.kind === "loading"}>
              새로 고침
            </button>
          }
        />
        <div className="card">
          {state.kind === "loading" && <LoadingRows rows={4} />}
          {state.kind === "error" && <ErrorState title="알림을 불러오지 못했습니다." onRetry={() => void load()} />}
          {d &&
            (d.items.length === 0 ? (
              <div className="st">
                <span className="t">새 알림이 없습니다.</span>
              </div>
            ) : (
              <>
                <div className="pad t-l2 c-alt" data-testid="notification-count">
                  처리할 알림 {d.unreadCount.toLocaleString("ko-KR")}건
                  {d.unreadCount > d.items.length && ` · 최근 ${d.items.length}건만 보입니다. 나머지는 `}
                  {d.unreadCount > d.items.length && <Link href="/admin/support/inquiries?status=OPEN">파트너스 문의</Link>}
                  {d.unreadCount > d.items.length && "에서 확인해 주십시오."}
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                    <thead>
                      <tr>
                        <th>종류</th>
                        <th>제목</th>
                        <th>마지막 글</th>
                        <th>관리</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.items.map((n) => (
                        <tr key={n.id} data-testid="notification-row">
                          <td>{KIND_LABEL[n.kind]}</td>
                          <td className="col-text">{n.title}</td>
                          <td>{dayTime(n.createdAt)}</td>
                          <td>
                            <Link className="btn btn-sm btn-out" href={n.href}>
                              답변
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ))}
        </div>
      </main>
    </>
  );
}
