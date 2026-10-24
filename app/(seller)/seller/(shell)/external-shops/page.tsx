"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Pagination, PageHead } from "../../../../../components/admin-ui";
import { Topbar } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, Toast } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";
import { useUrlState } from "../../../../../lib/client/navigation";
import { TAG, lastNotice, type Data } from "../../../../../components/seller/ExternalShopOperations";
import { formatDate } from "../../../../../lib/client/format";

// SA-006 외부 쇼핑몰 연동 관리(오버레이 전용). API: GET·POST /api/seller/external-shops, DELETE /api/seller/external-shops/{id}.
// 인증을 마치고 돌아오는 주소(…/oauth-done)가 이 화면으로 ?connected=1 또는 ?error=코드를 붙여 보낸다. 플랫폼 이름은 어디에도 쓰지 않는다.
// 보드에 있고 서버에 없는 것(쇼핑몰 별칭 · 주소, 끊는 중 요청 시각, 「결제 잠금으로 멈춤」 줄별 표시 — 잠기면 서버가 402로 막아 화면 전체가 잠김 안내로 바뀝니다)은 넣지 않았다. 마지막 주문 알림 종류는 서버 lastEventKind를 쓴다.
// 「상태 안내」 표의 설명(정본 SA-006). 끊어짐은 목록에서 곧 사라지는 마무리 상태라 안내 표에 넣지 않는다
const HELP: Record<"CONNECTED" | "REAUTH_REQUIRED" | "DISCONNECT_PENDING", string> = {
  CONNECTED: "연결한 쇼핑몰의 주문이 들어오고 있어요",
  REAUTH_REQUIRED: "허용이 풀려 주문 알림이 멈췄어요 · 다시 연결해 주세요",
  DISCONNECT_PENDING: "연결을 끊고 있어요 · 쇼핑몰 응답을 기다리는 중에는 주문을 받지 않아요 · 끝나면 「끊어짐」",
};
const RESULT_ERROR: Record<string, string> = {
  login_required: "로그인이 풀렸습니다. 다시 로그인한 뒤 연결해 주십시오",
  denied: "쇼핑몰에서 연결을 허용하지 않았습니다. 다시 시도해 주십시오",
  invalid_state: "연결 요청이 만료됐거나 맞지 않습니다. 처음부터 다시 연결해 주십시오",
  integration_disabled: "외부 쇼핑몰 연결을 준비하고 있습니다. 조금만 기다려 주십시오",
  exchange_failed: "쇼핑몰 인증을 마치지 못했습니다. 잠시 후 다시 연결해 주십시오",
  already_connected: "이미 다른 파트너스에 연결된 쇼핑몰입니다",
  forbidden: "연결은 대표자나 쇼핑몰 설정 권한이 있는 직원만 할 수 있습니다",
};
export default function ExternalShopsPage() {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; data: Data }>({ kind: "loading" });
  const [u, setU] = useUrlState({ page: "1" });
  const page = /^[1-9]\d*$/.test(u.page) ? Number(u.page) : 1;
  const setPage = (value: number) => setU({ page: String(value) });
  const query = useSearchParams();
  const pathname = usePathname();
  const listHref = `${pathname}${query.size ? `?${query.toString()}` : ""}`;
  const detailHref = (id: string) => `/seller/external-shops/${id}?${new URLSearchParams({ returnTo: listHref })}`;
  // 상대 시각(「2분 전」)이 화면을 열어 둔 동안에도 흘러가도록 30초마다 현재 시각을 갱신한다
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  const load = useCallback(async () => {
    const r = await api<Data>("/api/seller/external-shops");
    setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error", status: r.status });
  }, []);
  useEffect(() => {
    void load();
    // 인증 뒤 돌아온 결과 알림(주소에서는 곧바로 지운다)
    const q = new URLSearchParams(window.location.search);
    if (q.get("connected")) setToast({ text: "쇼핑몰을 연결했습니다" });
    else if (q.get("error")) setToast({ text: RESULT_ERROR[q.get("error")!] ?? "연결하지 못했습니다. 입력한 쇼핑몰 주소가 맞는지 확인한 뒤 다시 눌러 주십시오", neg: true });
    if (q.has("connected") || q.has("error")) window.history.replaceState(null, "", window.location.pathname);
  }, [load]);


  const d = state.kind === "ok" ? state.data : null;
  const pageCount = Math.ceil((d?.connections.length ?? 0) / 10);
  const currentPage = Math.min(page, pageCount || 1);
  useEffect(() => { if (state.kind === "ok") setPage(Math.min(page, Math.max(1, Math.ceil(state.data.connections.length / 10)))); }, [state]);
  return (
    <>
      <Topbar crumb="방송 › 연동 › 외부 쇼핑몰 연동" />
      <main className="main">
        <PageHead
          title="외부 쇼핑몰 연동"
          actions={
            d?.canManage && d.enabled ? (
              <Link className="btn" href={detailHref("new")}>
                쇼핑몰 추가 연결
              </Link>
            ) : undefined
          }
        />
        <div className="col" style={{ gap: 16 }}>
          {state.kind === "loading" && <div className="card"><LoadingRows rows={4} /></div>}
          {state.kind === "error" && <div className="card">{state.status === 402 ? <Locked /> : state.status === 403 ? (
              <div className="st" style={{ boxShadow: "none" }} data-testid="external-forbidden">
                <span className="t">쇼핑몰 설정 권한이 있는 직원만 볼 수 있습니다</span>
                <span className="s">대표자에게 허용해 달라고 요청해 주십시오</span>
              </div>
            ) : <ErrorState title="연동 정보를 불러오지 못했습니다" onRetry={() => void load()} />}</div>}
          {d && (
            <>
              <div className="msg msg-info" role="note"><span>연결한 쇼핑몰의 주문 알림이 주문대기와 방송 화면으로 들어와요 · 플랫폼 이름은 표시하지 않아요</span></div>
              {!d.enabled && (
                <div className="msg msg-cau" role="status" data-testid="external-disabled"><span><b>외부 쇼핑몰 연결을 준비하고 있습니다.</b> 열리면 이 화면에서 연결할 수 있습니다</span></div>
              )}
              {!d.canManage && <div className="msg msg-info" role="note"><span>목록만 볼 수 있습니다. 연결 · 해제는 대표자나 쇼핑몰 설정 권한이 있는 직원에게 요청해 주십시오.</span></div>}
              {d.connections.length === 0 ? (
                <div className="card">
                  <div className="st" data-testid="external-empty">
                    <span className="t">연결한 쇼핑몰이 없습니다</span>
                    <span className="s">운영 중인 쇼핑몰 주소를 넣으면 연결할 수 있는지 바로 확인합니다</span>
                    {d.canManage && d.enabled && <Link className="btn btn-sm" href={detailHref("new")}>쇼핑몰 추가 연결</Link>}
                  </div>
                </div>
              ) : (
                <section className="card">
                  <div className="au-lt-wrap">
                    <table className="tbl">
                      <thead><tr><th style={{ width: 260 }}>쇼핑몰</th><th style={{ width: 130 }}>상태</th><th>마지막으로 받은 주문 알림</th><th style={{ width: 100 }}>연결일</th><th style={{ width: 200 }}>관리</th></tr></thead>
                      <tbody>
                        {d.connections.slice((currentPage - 1) * 10, currentPage * 10).map((c) => (
                          <tr key={c.id} data-testid="external-row">
                            <td><b>{c.shopKey}</b></td>
                            <td><span className={`bdg nodot ${TAG[c.status].cls}`}>{TAG[c.status].label}</span></td>
                            <td>{lastNotice(c, now)}</td>
                            <td className="num" style={{ whiteSpace: "nowrap" }}>{formatDate(c.connectedAt, "—")}</td>
                            <td>
                              <div className="row" style={{ gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                              <Link className="btn btn-sm btn-out" href={detailHref(c.id)}>연결 상세</Link>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
              <span className="t-c1 c-alt">전체 연결 {d.connections.length}곳</span>
              {pageCount > 1 && <Pagination page={currentPage} pageCount={pageCount} onChange={setPage} />}
              <span className="t-c1 c-alt">쇼핑몰 앱 권한이 바뀌거나 만료되면 다시 연결해야 해요 · 끊는 중에는 쇼핑몰 응답을 기다려요. 그동안 주문은 받지 않아요</span>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
                <section className="au-fs" data-testid="external-status-guide">
                  <div className="au-fs-h"><h2 className="au-fs-t">상태 안내</h2></div>
                  <table className="tbl">
                    <thead><tr><th style={{ width: 130 }}>상태</th><th>설명</th></tr></thead>
                    <tbody>
                      {(["CONNECTED", "REAUTH_REQUIRED", "DISCONNECT_PENDING"] as const).map((k) => (
                        <tr key={k}>
                          <td><span className={`bdg nodot ${TAG[k].cls}`}>{TAG[k].label}</span></td>
                          <td style={{ textAlign: "left" }}>{HELP[k]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
                <section className="au-fs">
                  <div className="au-fs-h"><h2 className="au-fs-t">변경 권한</h2></div>
                  <div className="msg" role="note" style={{ display: "block" }}>대표자와 「쇼핑몰 설정」 권한이 있는 직원만 연결 · 해제할 수 있어요 · 목록 조회도 같은 권한이 필요해요</div>
                </section>
              </div>
            </>
          )}
        </div>
        {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
      </main>
    </>
  );
}
