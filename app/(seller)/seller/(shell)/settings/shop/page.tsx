"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { SettingsTabs } from "../../../../../../components/seller/SettingsTabs";
import { Toast } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import "./shop-info.css";

// SA-060 쇼핑몰 정보(파트너스 관리자, 설정 › 쇼핑몰 설정). 지금은 로고만(2026-10-04 대표님 지시).
// 로고 상자 자체가 올리는 곳이다(누르거나 끌어다 놓기, 미리보기, 바꾸기·지우기). PNG만, 2MB 이하, 정사각형 512px 이상(1440px까지).
// 보기는 모든 직원, 바꾸기는 대표자·「쇼핑몰 설정」 권한 직원. API: /api/seller/shop-content/logo.
// 화면 문구는 명사형·합니다체.

type Logo = { url: string; size: number; byteSize: number } | null;
const MAX_BYTES = 2 * 1024 * 1024;
const mb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`);

export default function ShopInfoPage() {
  const { me, can } = useSeller();
  const editable = can("SHOP_SETTINGS");
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number; error?: string } | { kind: "ok"; logo: Logo }>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const r = await api<{ logo: Logo }>("/api/seller/shop-content/logo");
    if (!r.ok) return setState({ kind: "error", status: r.status, error: r.error });
    setState({ kind: "ok", logo: r.data.logo });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (file: File) => {
    setError(null);
    if (file.size > MAX_BYTES) return setError(`2MB를 넘었습니다 · 지금 파일은 ${mb(file.size)}입니다`);
    setBusy(true);
    try {
      // 파일 바이트를 그대로 보낸다. 형식·크기는 서버가 바이트로 확인한다.
      const res = await fetch("/api/seller/shop-content/logo", { method: "PUT", body: file, cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setError(data.message ?? (res.status === 403 ? "변경 권한이 없습니다" : "로고를 올리지 못했습니다"));
      setState({ kind: "ok", logo: data.logo as Logo });
      setToast("로고를 바꿨습니다 · 쇼핑몰에 바로 반영");
    } catch {
      setError("연결이 끊겼습니다. 인터넷 연결을 확인해 주십시오");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    const r = await api<{ logo: Logo }>("/api/seller/shop-content/logo", { method: "DELETE" });
    setBusy(false);
    if (!r.ok) return setError(r.status === 403 ? "변경 권한이 없습니다" : "로고를 지우지 못했습니다");
    setState({ kind: "ok", logo: null });
    setToast("로고를 지웠습니다 · 쇼핑몰 이름 첫 글자로 표시");
  };

  const pick = () => editable && !busy && input.current?.click();
  const logo = state.kind === "ok" ? state.logo : null;
  const letter = [...me.shop.name.trim()][0] ?? "";

  return (
    <>
      <Topbar crumb="설정 › 쇼핑몰 설정 › 쇼핑몰 정보" />
      <main className="main">
        <SettingsTabs />
        <div className="ph">
          <div className="col" style={{ gap: 6 }}>
            <h1 className="t-t3">쇼핑몰 정보</h1>
            <span className="t-l2 c-alt">구매자 쇼핑몰 맨 위에 보이는 로고 · 올리면 바로 반영</span>
          </div>
        </div>
        {state.kind === "loading" && (
          <div className="card st" style={{ boxShadow: "none" }} aria-busy="true">
            <span className="spin" />
          </div>
        )}
        {state.kind === "error" && (
          <div className="card st" style={{ boxShadow: "none" }}>
            <div className="st-ic neg">!</div>
            <span className="t">
              {state.status === 402
                ? "이용 기간 종료"
                : state.error === "plan_feature_required"
                  ? "지금 요금제에서 사용할 수 없는 기능"
                  : "쇼핑몰 정보를 불러오지 못했습니다"}
            </span>
            {state.status !== 402 && state.status !== 403 && (
              <button className="btn btn-sm" type="button" onClick={() => void load()}>
                다시 시도
              </button>
            )}
          </div>
        )}
        {state.kind === "ok" && (
          <div className="form-grid">
            <section className="card pad col" style={{ gap: 14 }}>
              <h2 className="t-hl2">로고</h2>
              {!editable && (
                <div className="msg msg-info" role="status">
                  <span>보기만 할 수 있습니다. 로고 변경은 대표자나 쇼핑몰 설정 권한이 있는 직원에게 요청해 주십시오.</span>
                </div>
              )}
              <div className="row" style={{ gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
                <div
                  className={`si-logo${over ? " is-over" : ""}${editable ? " is-editable" : ""}`}
                  role={editable ? "button" : undefined}
                  tabIndex={editable ? 0 : -1}
                  aria-label={editable ? (logo ? "로고 바꾸기" : "로고 올리기") : "로고"}
                  aria-busy={busy}
                  data-testid="logo-box"
                  onClick={pick}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick())}
                  onDragOver={(e) => {
                    if (!editable) return;
                    e.preventDefault();
                    setOver(true);
                  }}
                  onDragLeave={() => setOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setOver(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f && editable) void upload(f);
                  }}
                >
                  {logo ? <img src={logo.url} alt="쇼핑몰 로고" /> : <span className="si-letter">{letter}</span>}
                  {editable && !logo && <span className="si-hint t-c1">{busy ? "올리는 중" : "눌러서 올리기"}</span>}
                </div>
                <div className="col" style={{ gap: 8, minWidth: 0, flex: 1 }}>
                  <span className="t-l2">{logo ? `${logo.size} × ${logo.size}px · PNG · ${mb(logo.byteSize)}` : "로고 없음 · 쇼핑몰 이름 첫 글자로 표시"}</span>
                  <span className="help">PNG · 2MB 이하 · 정사각형 512 × 512px 이상(1440px까지) · 끌어다 놓아도 됨</span>
                  {editable && (
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn btn-sm btn-out" type="button" disabled={busy} onClick={pick}>
                        {busy ? "올리는 중" : logo ? "바꾸기" : "올리기"}
                      </button>
                      {logo && (
                        <button className="btn btn-sm btn-text" type="button" style={{ color: "var(--neg-text)" }} disabled={busy} onClick={() => void remove()}>
                          지우기
                        </button>
                      )}
                    </div>
                  )}
                  {error && (
                    <span className="err" role="alert">
                      {error}
                    </span>
                  )}
                </div>
                <input
                  ref={input}
                  type="file"
                  accept="image/png"
                  hidden
                  aria-label="로고 파일"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void upload(f);
                  }}
                />
              </div>
            </section>
            <aside className="col aside-sticky" style={{ gap: 16 }}>
              <div className="card pad col" style={{ gap: 10 }}>
                <span className="t-hl2">구매자 화면 미리보기</span>
                <div className="si-preview" data-testid="logo-preview">
                  {logo ? <img src={logo.url} alt="" /> : <span className="si-mini-letter">{letter}</span>}
                  <b>{me.shop.name}</b>
                </div>
                <span className="t-c1 c-alt">쇼핑몰 모든 화면 맨 위에 이렇게 표시됩니다</span>
              </div>
            </aside>
          </div>
        )}
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
