"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FormRow, FormSection, PageHead } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { Toast } from "../../../../../../components/seller/States";
import { api, apiUpload, failMessage } from "../../../../../../components/seller/api";
import "./shop-info.css";

// SA-060 쇼핑몰 정보(파트너스 관리자, 설정 › 쇼핑몰 설정). 지금은 로고만(2026-10-04 대표님 지시).
// 로고 상자 자체가 올리는 곳이다(누르거나 끌어다 놓기, 미리보기, 바꾸기·지우기). PNG만, 2MB 이하, 정사각형 512px 이상(1440px까지).
// 보기는 모든 직원, 바꾸기는 대표자·「쇼핑몰 설정」 권한 직원. API: /api/seller/shop-content/logo.
// 대표 색상(쇼핑몰 설정 권한이 있는 계정에만 보임): GET·PUT /api/seller/brand-color { color: "#RRGGBB" | null }. 흰 바탕과의 대비가 3:1 미만이면 서버가 거절한다. 「저장」을 눌러야 반영된다.
// 화면 문구는 명사형·합니다체.

type Logo = { url: string; size: number; byteSize: number } | null;
const MAX_BYTES = 2 * 1024 * 1024;
const mb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`);

type BrandColor = { color: string | null; contrastOnWhite: number | null };
const HEX = /^#[0-9a-fA-F]{6}$/;

function BrandColorSection({ onToast }: { onToast: (t: string) => void }) {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; saved: BrandColor }>({ kind: "loading" });
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ brandColor: BrandColor }>("/api/seller/brand-color");
    if (!r.ok) return setState({ kind: "error", status: r.status });
    setText(r.data.brandColor.color ?? "");
    setState({ kind: "ok", saved: r.data.brandColor });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === "loading") return null;
  if (state.kind === "error")
    return (
      <div style={{ marginTop: 32 }}>
        <FormSection title="대표 색상">
          <FormRow label="대표 색상">
            <span className="err" role="alert">대표 색상을 불러오지 못했습니다</span>
            <button className="btn btn-sm btn-out" type="button" onClick={() => void load()}>
              다시 시도
            </button>
          </FormRow>
        </FormSection>
      </div>
    );

  const saved = state.saved;
  const value = text.trim();
  const valid = value === "" || HEX.test(value);
  const dirty = value.toUpperCase() !== (saved.color ?? "");
  const picker = HEX.test(value) ? value : saved.color ?? "#2563EB";

  const save = async (next: string | null) => {
    setSaving(true);
    setError(null);
    const r = await api<{ brandColor: BrandColor }>("/api/seller/brand-color", { method: "PUT", body: { color: next } });
    setSaving(false);
    if (!r.ok) return setError(failMessage(r, "admin", "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오"));
    setText(r.data.brandColor.color ?? "");
    setState({ kind: "ok", saved: r.data.brandColor });
    onToast(next === null ? "대표 색상을 지웠습니다 · 기본 색으로 표시" : "대표 색상을 저장했습니다 · 쇼핑몰에 바로 반영");
  };

  return (
    <div style={{ marginTop: 32 }}>
      <FormSection title="대표 색상">
        <FormRow
          label="대표 색상"
          htmlFor="brand-color"
          help={error ? <span className="err" role="alert">{error}</span> : !valid ? <span className="err">색상은 #RRGGBB 형식으로 입력해 주십시오</span> : "버튼과 가격 강조에 쓰입니다 · 흰 바탕에서 잘 보이는 진한 색만 쓸 수 있습니다 · 비우면 기본 색"}
        >
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input type="color" aria-label="색상 고르기" value={picker.toLowerCase()} onChange={(e) => setText(e.target.value.toUpperCase())} disabled={saving} style={{ width: 44, height: 36, padding: 0 }} />
            <input id="brand-color" className={`inp num${!valid ? " is-error" : ""}`} type="text" value={text} placeholder="#RRGGBB" maxLength={7} onChange={(e) => setText(e.target.value)} aria-invalid={!valid} disabled={saving} style={{ width: 120 }} />
            <button className="btn btn-sm" type="button" disabled={saving || !valid || !dirty} onClick={() => void save(value === "" ? null : value.toUpperCase())} data-testid="brand-save">
              {saving ? "저장 중" : "저장"}
            </button>
            {saved.color && (
              <button className="btn btn-sm btn-text" type="button" style={{ color: "var(--neg-text)" }} disabled={saving} onClick={() => void save(null)} data-testid="brand-clear">
                기본 색으로
              </button>
            )}
          </div>
        </FormRow>
        <FormRow label="미리보기" help={saved.contrastOnWhite !== null ? `저장된 색의 흰 바탕 대비 ${saved.contrastOnWhite}:1` : "대표 색상을 저장하면 흰 바탕 대비가 표시됩니다"}>
          <div className="row" style={{ gap: 12, alignItems: "center" }} data-testid="brand-preview">
            <span className="btn btn-sm" style={HEX.test(value) ? { background: value, borderColor: value, color: "#fff" } : undefined}>
              구매하기
            </span>
            <b style={HEX.test(value) ? { color: value } : undefined}>12,900원</b>
          </div>
        </FormRow>
      </FormSection>
    </div>
  );
}

export default function ShopInfoPage() {
  const { me, can } = useSeller();
  const editable = can("SHOP_SETTINGS");
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number; error?: string } | { kind: "ok"; logo: Logo }>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // 올리는 중에는 새 파일(끌어 놓기 포함)을 받지 않는다. 상태(busy)는 다음 렌더에야 바뀌므로 잇단 끌어 놓기는 ref로 막는다.
  const working = useRef(false);

  const load = useCallback(async () => {
    const r = await api<{ logo: Logo }>("/api/seller/shop-content/logo");
    if (!r.ok) return setState({ kind: "error", status: r.status, error: r.error });
    setState({ kind: "ok", logo: r.data.logo });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (file: File) => {
    // 고른 파일은 이미 받았으니 입력 칸을 바로 비운다. 화면에서 거절(2MB 초과 등)해도 같은 파일을 다시 고를 수 있다(Codex 4176481022).
    if (input.current) input.current.value = "";
    setError(null);
    if (working.current) return;
    if (file.size > MAX_BYTES) return setError(`2MB를 넘었습니다 · 지금 파일은 ${mb(file.size)}입니다`);
    working.current = true;
    setBusy(true);
    // 파일 바이트를 그대로 보낸다. 형식·크기는 서버가 바이트로 확인한다. 로그인이 풀렸으면 apiUpload가 로그인 화면으로 보낸다.
    const r = await apiUpload<{ logo: Logo }>("/api/seller/shop-content/logo", file, { method: "PUT" });
    working.current = false;
    setBusy(false);
    if (!r.ok) {
      if (r.status === 401) return;
      return setError(
        r.message ??
          (r.status === 0 ? "연결이 끊겼습니다. 인터넷 연결을 확인해 주십시오" : r.status === 403 ? "변경 권한이 없습니다" : "로고를 올리지 못했습니다"),
      );
    }
    setState({ kind: "ok", logo: r.data.logo });
    setToast("로고를 바꿨습니다 · 쇼핑몰에 바로 반영");
  };

  const remove = async () => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    const r = await api<{ logo: Logo }>("/api/seller/shop-content/logo", { method: "DELETE" });
    working.current = false;
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
        <PageHead title="쇼핑몰 정보" />
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
          <>
            {!editable && (
              <div className="msg msg-info" role="status">
                <span>보기만 할 수 있습니다. 로고 변경은 대표자나 쇼핑몰 설정 권한이 있는 직원에게 요청해 주십시오.</span>
              </div>
            )}
            <FormSection title="로고">
              <FormRow label="로고" help="구매자 쇼핑몰 맨 위에 보이는 로고 · 올리면 바로 반영">
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
                      if (f && editable && !busy) void upload(f);
                    }}
                  >
                    {logo ? <img src={logo.url} alt="쇼핑몰 로고" /> : <span className="si-letter">{letter}</span>}
                    {editable && !logo && <span className="si-hint t-c1">{busy ? "올리는 중" : "눌러서 올리기"}</span>}
                  </div>
                  <div className="col" style={{ gap: 8, minWidth: 0, flex: "1 1 200px" }}>
                    <span className="t-l2">
                      {logo ? `${logo.size} × ${logo.size}px · PNG · ${mb(logo.byteSize)}` : "로고 없음 · 쇼핑몰 이름 첫 글자로 표시"}
                    </span>
                    <span className="help">8비트 PNG · 2MB 이하 · 정사각형 512 × 512px 이상(1440px까지) · 끌어다 놓아도 됨</span>
                    {editable && (
                      <div className="row" style={{ gap: 6 }}>
                        <button className="btn btn-sm btn-out" type="button" disabled={busy} onClick={pick}>
                          {busy ? "올리는 중" : logo ? "바꾸기" : "올리기"}
                        </button>
                        {logo && (
                          <button
                            className="btn btn-sm btn-text"
                            type="button"
                            style={{ color: "var(--neg-text)" }}
                            disabled={busy}
                            onClick={() => void remove()}
                          >
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
              </FormRow>
            </FormSection>
            {editable && <BrandColorSection onToast={setToast} />}
            <div style={{ marginTop: 32 }}>
              <FormSection title="구매자 화면 미리보기">
                <FormRow label="쇼핑몰 맨 위" help="쇼핑몰 모든 화면 맨 위에 이렇게 표시됩니다">
                  <div className="si-preview" data-testid="logo-preview">
                    {logo ? <img src={logo.url} alt="" /> : <span className="si-mini-letter">{letter}</span>}
                    <b>{me.shop.name}</b>
                  </div>
                </FormRow>
              </FormSection>
            </div>
          </>
        )}
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
