"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FormRow, FormSection, PageHead, useConfirm } from "../admin-ui";
import { Topbar, useSeller } from "./SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "./States";
import { api, failMessage } from "./api";
import { ago, formatDate } from "../../lib/client/format";
import { confirmLeave, sanitizeNext, useSmartBack, useUnsavedGuard } from "../../lib/client/navigation";

export type Status = "CONNECTED" | "REAUTH_REQUIRED" | "DISCONNECT_PENDING" | "DISCONNECTED";
export type Conn = { id: string; shopKey: string; status: Status; connectedAt: string; lastEventAt: string | null; lastEventKind?: "ORDER_CREATED" | "ORDER_CANCELED" | "OTHER" | null };
export type Data = { enabled: boolean; canManage: boolean; connections: Conn[] };

export const TAG: Record<Status, { label: string; cls: string }> = {
  CONNECTED: { label: "이어짐", cls: "b-done" },
  REAUTH_REQUIRED: { label: "다시 이어야 함", cls: "b-warn" },
  DISCONNECT_PENDING: { label: "끊는 중", cls: "b-wait" },
  DISCONNECTED: { label: "끊어짐", cls: "b-gray" },
};
const KIND: Record<string, string> = { ORDER_CREATED: "주문 생성", ORDER_CANCELED: "주문 취소", OTHER: "그 밖의 알림" };
// 「마지막으로 받은 주문 알림」 칸: 이어짐은 받은 시각 · 종류, 멈춘 상태는 멈춘 이유
export const lastNotice = (c: Conn, now: number) =>
  c.status === "REAUTH_REQUIRED" ? "허용이 풀려 주문 알림이 멈췄어요" : c.status === "DISCONNECT_PENDING" ? "쇼핑몰 응답을 기다리는 중" : c.lastEventAt ? `${ago(c.lastEventAt, now)}${c.lastEventKind ? ` · ${KIND[c.lastEventKind]}` : ""}` : "아직 받은 주문 알림이 없어요";

export function ExternalShopOperations({ connectionId, returnTo }: { connectionId?: string; returnTo?: string | null }) {
  const { me } = useSeller();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; data: Data }>({ kind: "loading" });
  const [url, setUrl] = useState("");
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const generation = useRef(0);
  const { confirm } = useConfirm();
  const dirty = !connectionId && url !== "" && !authorizeUrl;
  const releaseGuard = useUnsavedGuard(dirty);
  // 인증 시작이 확인되면 dirty 보호를 정리한 다음 기존 인증 주소로 이동한다.
  useEffect(() => { if (authorizeUrl) window.location.assign(authorizeUrl); }, [authorizeUrl]);
  const safeReturnTo = sanitizeNext(returnTo, ["/seller/external-shops"]);
  const listHref = safeReturnTo?.split("?")[0] === "/seller/external-shops" ? safeReturnTo : "/seller/external-shops";
  const back = useSmartBack(listHref);
  const cancel = async () => { if (!confirmLeave(dirty)) return; await releaseGuard(); back(); };
  const load = useCallback(async () => {
    const request = ++generation.current;
    setState({ kind: "loading" });
    const r = await api<Data>("/api/seller/external-shops");
    if (request !== generation.current) return;
    setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error", status: r.status });
  }, []);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  // 인증 주소를 받으면 그 화면으로 이동한다(쇼핑몰 관리자 로그인·앱 권한 승인은 그쪽에서 한다)
  const begin = async (body: { shopUrl: string } | { connectionId: string }, ask: { title: string; body: string; confirmLabel: string }) => {
    await confirm({
      ...ask,
      run: async () => {
        const r = await api<{ authorizeUrl: string }>("/api/seller/external-shops", { method: "POST", body });
        if (!r.ok) return r.message ?? failMessage(r, "admin");
        await releaseGuard();
        setAuthorizeUrl(r.data.authorizeUrl);
      },
    });
  };

  const disconnect = async (c: Conn, ask: { title: string; body: string; confirmLabel: string }) => {
    let status: Status | undefined;
    const ok = await confirm({
      ...ask,
      danger: true,
      run: async () => {
        const r = await api<{ status: Status }>(`/api/seller/external-shops/${c.id}`, { method: "DELETE" });
        if (!r.ok) return failMessage(r, "admin", "해제하지 못했습니다. 잠시 후 다시 시도해 주십시오");
        status = r.data.status;
      },
    });
    if (!ok) return;
    setToast({ text: status === "DISCONNECTED" ? "연결을 해제했습니다 · 주문 이벤트를 더 받지 않습니다" : "연결을 끊고 있습니다 · 쇼핑몰 응답을 기다리는 중입니다" });
    if (status === "DISCONNECTED") setDisconnected(true);
    await load();
  };

  const d = state.kind === "ok" ? state.data : null;
  const c = connectionId ? d?.connections.find((item) => item.id === connectionId) : undefined;
  const canManage = !!d?.canManage && !me.readOnly;
  return <><Topbar crumb="방송 › 연동 › 외부 쇼핑몰 연동 › 상세" /><main className="main">
    <PageHead title={connectionId ? "쇼핑몰 연결 상세" : "쇼핑몰 추가 연결"} back={listHref} onBack={cancel} />
    {state.kind === "loading" ? <div className="card"><LoadingRows rows={3} /></div> : state.kind === "error" ? <div className="card">{state.status === 402 ? <Locked /> : state.status === 403 ? <NoPermission need="쇼핑몰 설정" /> : <ErrorState title="연동 정보를 불러오지 못했습니다" onRetry={() => void load()} />}</div> : !connectionId ? canManage ? <FormSection title="쇼핑몰 주소"><FormRow label="쇼핑몰 주소">
      {!d?.enabled ? <p role="status">외부 쇼핑몰 연결을 준비하고 있습니다. 열리면 이 화면에서 연결할 수 있습니다</p> : <section className="col" style={{ gap: 8 }} aria-label="쇼핑몰 추가 연결" data-testid="external-add">
        <label htmlFor="ext-url"><b>쇼핑몰 주소</b></label>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input id="ext-url" className="inp" style={{ minWidth: 320 }} type="text" inputMode="url" placeholder="운영 중인 쇼핑몰 주소" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="btn" type="button" disabled={!url.trim()} onClick={() => void begin({ shopUrl: url.trim() }, { title: "이 쇼핑몰을 연결하시겠습니까?", body: `${url.trim()}의 쇼핑몰 관리자 로그인 화면으로 이동합니다. 로그인하고 앱 설치를 허용하면 연결됩니다.`, confirmLabel: "연결 시작하기" })}>이 주소로 연결 시작하기</button>
          <button className="btn btn-out" type="button" onClick={() => void cancel()}>취소</button>
        </div>
        <span className="t-c1 c-alt">주소로 연결할 수 있는지 자동으로 확인합니다 · 연결할 수 있으면 관리자 로그인과 앱 설치 승인으로 이어집니다</span>
      </section>}
    </FormRow></FormSection> : <NoPermission need="쇼핑몰 설정" /> : disconnected ? <section className="card pad" aria-label="연결 해제 결과"><p>연결을 해제했습니다 · 주문 이벤트를 더 받지 않습니다</p><button className="btn btn-out" type="button" onClick={back}>목록으로</button></section> : !c ? <div className="card"><ErrorState title="연결을 찾을 수 없습니다" onRetry={() => void load()} /></div> : <section aria-label="쇼핑몰 연결 상세" data-testid="external-detail">
      <FormSection title={c.shopKey}>
        <FormRow label="상태"><span className={`bdg nodot ${TAG[c.status].cls}`}>{TAG[c.status].label}</span></FormRow>
        <FormRow label="마지막으로 받은 주문 알림"><span>{lastNotice(c, now)}</span></FormRow>
        <FormRow label="연결일"><span>{formatDate(c.connectedAt, "—")}</span></FormRow>
      </FormSection>
      {canManage && <div className="row" style={{ gap: 8 }}>
        {d?.enabled && c.status === "REAUTH_REQUIRED" && <button className="btn" type="button" onClick={() => void begin({ connectionId: c.id }, { title: `${c.shopKey} 연결을 다시 하시겠습니까?`, body: "쇼핑몰 관리자 화면으로 이동해 앱 허용을 다시 받습니다.", confirmLabel: "다시 연결하기" })}>다시 연결</button>}
        {c.status === "DISCONNECT_PENDING" && <button className="btn btn-out" type="button" onClick={() => void disconnect(c, { title: "연결 해제를 다시 요청하시겠습니까?", body: `${c.shopKey}의 주문 알림이 더 들어오지 않습니다.`, confirmLabel: "해제 다시 요청하기" })}>해제 다시 요청하기</button>}
        {(c.status === "CONNECTED" || c.status === "REAUTH_REQUIRED") && <button className="btn btn-out" type="button" onClick={() => void disconnect(c, { title: `${c.shopKey} 연결을 해제하시겠습니까?`, body: "해제하면 이 쇼핑몰의 주문 이벤트가 더 들어오지 않습니다. 이미 받은 주문과 기록은 그대로 남습니다. 다시 쓰려면 주소를 넣고 새로 연결합니다.", confirmLabel: "연결 해제" })}>연결 해제</button>}
      </div>}
    </section>}
    {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
  </main></>;
}
