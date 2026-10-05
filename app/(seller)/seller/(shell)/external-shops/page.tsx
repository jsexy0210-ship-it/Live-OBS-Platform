"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHead } from "../../../../../components/admin-ui";
import { Topbar } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, Toast } from "../../../../../components/seller/States";
import { api, failMessage } from "../../../../../components/seller/api";

// SA-006 외부 쇼핑몰 연동 관리(오버레이 전용). API: GET·POST /api/seller/external-shops, DELETE /api/seller/external-shops/{id}.
// 인증을 마치고 돌아오는 주소(…/oauth-done)가 이 화면으로 ?connected=1 또는 ?error=코드를 붙여 보낸다. 플랫폼 이름은 어디에도 쓰지 않는다.
// 보드에 있고 서버에 없는 것(쇼핑몰 별칭, 마지막 이벤트 종류, 「결제 잠금으로 멈춤」 줄별 표시 — 잠기면 서버가 402로 막아 화면 전체가 잠김 안내로 바뀝니다)은 넣지 않았다.
type Status = "CONNECTED" | "REAUTH_REQUIRED" | "DISCONNECT_PENDING" | "DISCONNECTED";
type Conn = { id: string; shopKey: string; status: Status; connectedAt: string; lastEventAt: string | null };
type Data = { enabled: boolean; canManage: boolean; connections: Conn[] };

const TAG: Record<Status, { label: string; cls: string }> = {
  CONNECTED: { label: "이어짐", cls: "b-done" },
  REAUTH_REQUIRED: { label: "다시 이어야 함", cls: "b-warn" },
  DISCONNECT_PENDING: { label: "끊는 중", cls: "b-wait" },
  DISCONNECTED: { label: "끊어짐", cls: "b-gray" },
};
const HELP: Record<Status, string> = {
  CONNECTED: "이어진 쇼핑몰의 주문이 들어오고 있습니다",
  REAUTH_REQUIRED: "허용이 풀려 주문 알림이 멈췄습니다 · 다시 이으면 바로 이어집니다",
  DISCONNECT_PENDING: "연결을 끊고 있습니다 · 쇼핑몰 응답을 기다리는 중 · 주문은 받지 않습니다",
  DISCONNECTED: "",
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
const date = (iso: string) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date(iso));
function ago(iso: string | null): string {
  if (!iso) return "아직 없습니다";
  const m = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
  if (m < 1) return "방금 전";
  if (m < 60) return `${m}분 전`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}시간 전`;
  return `${Math.floor(m / 1440)}일 전`;
}

export default function ExternalShopsPage() {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; data: Data }>({ kind: "loading" });
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Conn | null>(null);
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

  // 인증 주소를 받으면 그 화면으로 이동한다(쇼핑몰 관리자 로그인·앱 권한 승인은 그쪽에서 한다)
  const begin = async (body: { shopUrl: string } | { connectionId: string }) => {
    setBusy(true);
    setProblem(null);
    const r = await api<{ authorizeUrl: string }>("/api/seller/external-shops", { method: "POST", body });
    if (!r.ok) {
      setBusy(false);
      return setProblem(r.message ?? failMessage(r, "admin"));
    }
    window.location.assign(r.data.authorizeUrl);
  };

  const disconnect = async (c: Conn) => {
    setBusy(true);
    const r = await api<{ status: Status }>(`/api/seller/external-shops/${c.id}`, { method: "DELETE" });
    setBusy(false);
    setConfirm(null);
    if (!r.ok) return setToast({ text: failMessage(r, "admin", "해제하지 못했습니다. 잠시 후 다시 시도해 주십시오"), neg: true });
    setToast({ text: r.data.status === "DISCONNECTED" ? "연결을 해제했습니다 · 주문 이벤트를 더 받지 않습니다" : "연결을 끊고 있습니다 · 쇼핑몰 응답을 기다리는 중입니다" });
    await load();
  };

  const d = state.kind === "ok" ? state.data : null;
  return (
    <>
      <Topbar crumb="방송 › 연동 › 외부 쇼핑몰 연동" />
      <main className="main">
        <PageHead
          title="외부 쇼핑몰 연동"
          actions={
            d?.canManage && d.enabled ? (
              <button className="btn" type="button" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
                쇼핑몰 더 이어 두기
              </button>
            ) : undefined
          }
        />
        <div className="col" style={{ gap: 16 }}>
          {state.kind === "loading" && <div className="card"><LoadingRows rows={4} /></div>}
          {state.kind === "error" && <div className="card">{state.status === 402 ? <Locked /> : <ErrorState title="연동 정보를 불러오지 못했습니다" onRetry={() => void load()} />}</div>}
          {d && (
            <>
              <div className="msg msg-info" role="note"><span>연결한 쇼핑몰의 주문 이벤트가 방송 주문대기와 오버레이로 들어옵니다</span></div>
              {!d.enabled && (
                <div className="msg msg-cau" role="status" data-testid="external-disabled"><span><b>외부 쇼핑몰 연결을 준비하고 있습니다.</b> 열리면 이 화면에서 연결할 수 있습니다</span></div>
              )}
              {!d.canManage && <div className="msg msg-info" role="note"><span>목록만 볼 수 있습니다. 연결 · 해제는 대표자나 쇼핑몰 설정 권한이 있는 직원에게 요청해 주십시오.</span></div>}
              {adding && d.canManage && d.enabled && (
                <section className="card pad col" style={{ gap: 8 }} data-testid="external-add">
                  <label htmlFor="ext-url"><b>쇼핑몰 주소</b></label>
                  <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <input id="ext-url" className="inp" style={{ minWidth: 320 }} type="text" inputMode="url" placeholder="운영 중인 쇼핑몰 주소" value={url} onChange={(e) => { setUrl(e.target.value); setProblem(null); }} />
                    <button className="btn" type="button" disabled={busy || !url.trim()} onClick={() => void begin({ shopUrl: url.trim() })}>이 주소로 연결 시작하기</button>
                  </div>
                  <span className="t-c1 c-alt">주소로 연결할 수 있는지 자동으로 확인합니다 · 연결할 수 있으면 관리자 로그인과 앱 설치 승인으로 이어집니다</span>
                  {problem && <div className="msg msg-neg" role="alert" data-testid="external-problem"><span>{problem}</span></div>}
                </section>
              )}
              {d.connections.length === 0 ? (
                <div className="card">
                  <div className="st" data-testid="external-empty">
                    <span className="t">연결한 쇼핑몰이 없습니다</span>
                    <span className="s">운영 중인 쇼핑몰 주소를 넣으면 연결할 수 있는지 바로 확인합니다</span>
                  </div>
                </div>
              ) : (
                <section className="card">
                  <div className="au-lt-wrap">
                    <table className="tbl">
                      <thead><tr><th>쇼핑몰</th><th>상태</th><th>마지막으로 받은 주문 알림</th><th>연결일</th><th>관리</th></tr></thead>
                      <tbody>
                        {d.connections.map((c) => (
                          <tr key={c.id} data-testid="external-row">
                            <td><b>{c.shopKey}</b></td>
                            <td><span className={`bdg ${TAG[c.status].cls}`}>{TAG[c.status].label}</span><div className="t-c1 c-alt">{HELP[c.status]}</div></td>
                            <td>{ago(c.lastEventAt)}</td>
                            <td style={{ whiteSpace: "nowrap" }}>{date(c.connectedAt)}</td>
                            <td>
                              {d.canManage && d.enabled && c.status === "REAUTH_REQUIRED" && <button className="btn btn-sm" type="button" disabled={busy} onClick={() => void begin({ connectionId: c.id })}>다시 연결</button>}{" "}
                              {d.canManage && c.status === "DISCONNECT_PENDING" && <button className="btn btn-sm btn-out" type="button" disabled={busy} onClick={() => void disconnect(c)}>해제 다시 요청하기</button>}
                              {d.canManage && (c.status === "CONNECTED" || c.status === "REAUTH_REQUIRED") && <button className="btn btn-sm btn-out" type="button" disabled={busy} onClick={() => setConfirm(c)}>연결 해제</button>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
              {problem && !adding && <div className="msg msg-neg" role="alert"><span>{problem}</span></div>}
              <span className="t-c1 c-alt">다시 연결 필요: 쇼핑몰 관리자에서 앱 권한이 바뀌거나 만료되면 생깁니다 · 해제 대기: 쇼핑몰 응답이 늦어 연결을 끊는 중입니다 · 그동안 주문은 받지 않습니다</span>
            </>
          )}
        </div>
        {confirm && (
          <div className="msg msg-cau" role="alertdialog" aria-label="연결 해제 확인" style={{ marginTop: 16 }} data-testid="external-confirm">
            <span><b>{confirm.shopKey} 연결을 해제하시겠습니까?</b> 해제하면 이 쇼핑몰의 주문 이벤트가 더 들어오지 않습니다. 이미 받은 주문과 기록은 그대로 남습니다. 다시 쓰려면 주소를 넣고 새로 연결합니다.</span>
            <span className="row" style={{ gap: 8 }}>
              <button className="btn" type="button" disabled={busy} onClick={() => void disconnect(confirm)}>연결 해제</button>
              <button className="btn btn-out" type="button" onClick={() => setConfirm(null)}>유지</button>
            </span>
          </div>
        )}
        {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
      </main>
    </>
  );
}
