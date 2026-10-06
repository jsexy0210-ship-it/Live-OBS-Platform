"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ListHead, PageHead, ListTable } from "../../../../../components/admin-ui";
import { Topbar } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";
import { kstText } from "../banners/_shared/ui";

// SA-130 알림 센터(파트너스 관리자). 새 공지, 내 문의에 달린 플랫폼 답변, 입금 확인·결제 완료·재고 없음·반품 요청을 한 줄씩 보이고, 눌러 처리 화면으로 간다. 계정 누구나(직원 포함), 구독이 잠기거나 이용 정지 중에도 본다.
// API: GET /api/seller/notifications → { items: [{ id, kind: NOTICE|INQUIRY_REPLY|DEPOSIT_PENDING|ORDER_PAID|OUT_OF_STOCK|RETURN_REQUESTED|CHARGE_SHORTAGE, title, href, createdAt, unread }], unreadCount }(최근 30건),
// POST /api/seller/notifications/read(연 것으로 남김 — 공지 알림 읽음, 문의 답변은 그 문의를 열어야 읽음).
// 열었을 때의 안 읽음 표시는 그대로 보여 주고, 읽음 처리는 목록을 받은 뒤에 한다(새로 고치면 공지는 읽음으로 바뀐다).
type Item = { id: string; kind: "NOTICE" | "INQUIRY_REPLY" | "DEPOSIT_PENDING" | "ORDER_PAID" | "OUT_OF_STOCK" | "RETURN_REQUESTED" | "CHARGE_SHORTAGE"; title: string; href: string; createdAt: string; unread: boolean };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; items: Item[]; unreadCount: number };

const KIND: Record<Item["kind"], { label: string; cls: string }> = {
  NOTICE: { label: "공지", cls: "b-info" },
  INQUIRY_REPLY: { label: "문의 답변", cls: "b-done" },
  DEPOSIT_PENDING: { label: "입금 확인", cls: "b-warn" },
  ORDER_PAID: { label: "결제 완료", cls: "b-done" },
  OUT_OF_STOCK: { label: "재고 없음", cls: "b-fail" },
  RETURN_REQUESTED: { label: "반품·교환", cls: "b-warn" },
  CHARGE_SHORTAGE: { label: "충전금", cls: "b-warn" },
};

export default function NotificationsPage() {
  const [state, setState] = useState<Load>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await api<{ items: Item[]; unreadCount: number }>("/api/seller/notifications");
    if (!r.ok) return setState({ kind: "error" });
    setState({ kind: "ok", items: r.data.items, unreadCount: r.data.unreadCount });
    // 목록을 받은 뒤에 연 것으로 남긴다(실패해도 목록은 그대로)
    void api("/api/seller/notifications/read", { method: "POST" });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const items = state.kind === "ok" ? state.items : [];

  return (
    <>
      <Topbar crumb="알림" />
      <main className="main">
        <PageHead description="주문과 쇼핑몰 운영에서 확인할 알림을 모아 봅니다."
          title="알림"
          actions={
            <Link className="btn btn-out btn-level-secondary" href="/seller/notices">
              공지 · 문의
            </Link>
          }
        />
        <span className="t-c1 c-alt">새 공지(최근 14일), 문의 답변, 입금 확인 요청, 결제 완료, 품절, 반품·교환 요청이 보입니다. 누르면 해당 화면으로 갑니다.</span>
        <div className="au-list-section" >
          {state.kind === "ok" && <ListHead total={items.length} unit="건" actions={state.unreadCount > 0 ? <span className="t-l2" data-testid="notif-unread">읽지 않은 알림 {state.unreadCount}건</span> : undefined} />}
          {state.kind === "loading" && <LoadingRows rows={4} />}
          {state.kind === "error" && <ErrorState title="알림을 불러오지 못했습니다" onRetry={() => void load()} />}
          {state.kind === "ok" && items.length === 0 && (
            <div className="st" style={{ boxShadow: "none" }}>
              <div className="st-ic">0</div>
              <span className="t">새 알림이 없습니다</span>
              <span className="s">공지와 문의 답변이 오면 여기에 표시됩니다.</span>
            </div>
          )}
          {state.kind === "ok" && items.length > 0 && (
            <ListTable>
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 110 }}>종류</th>
                    <th>제목</th>
                    <th style={{ width: 160 }}>시각</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((n) => (
                    <tr key={n.id} data-testid="notif-row" data-unread={n.unread ? "true" : "false"}>
                      <td>
                        <span className={`bdg ${KIND[n.kind].cls}`}>{KIND[n.kind].label}</span>
                      </td>
                      <td className="col-text ell">
                        <Link href={n.href} className={n.unread ? "fw6" : undefined}>
                          {n.title}
                        </Link>
                        {n.unread && <span className="bdg b-info nodot"> 새 알림</span>}
                      </td>
                      <td className="num">{kstText(n.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ListTable>
          )}
        </div>
      </main>
    </>
  );
}
