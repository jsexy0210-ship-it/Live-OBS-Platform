"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FormFoot, FormRow, FormSection, PageHead, useConfirm } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { Toast } from "../../../../../../components/seller/States";
import { api, apiUpload, failMessage } from "../../../../../../components/seller/api";
import "./shop-info.css";

// SA-060 쇼핑몰 정보(파트너스 관리자, 설정 › 쇼핑몰 설정) (a)구역: 운영 상태·이름·한 줄 소개·로고·대표 색상·주소. 파비콘·공유 카드·도메인·사업자 구역은 이어서 붙인다.
// 이름·한 줄 소개는 아래 저장 줄(저장 앞 확인 창)로 저장한다. API: GET·PUT /api/seller/shop-profile { shopName(1~20자), shopTagline(≤40자) }.
// 로고 상자 자체가 올리는 곳이다(누르거나 끌어다 놓기, 미리보기, 바꾸기·지우기). PNG만, 2MB 이하, 정사각형 512px 이상(1440px까지).
// 보기는 모든 직원, 바꾸기는 대표자·「쇼핑몰 설정」 권한 직원. API: /api/seller/shop-content/logo.
// 대표 색상(쇼핑몰 설정 권한이 있는 계정에만 보임): 시안 칩 8개 중 하나를 누르면 확인 창을 거쳐 저장. GET·PUT /api/seller/brand-color { color: "#RRGGBB" | null }(기본색 칩은 null).
// 화면 문구는 명사형·합니다체.

type Logo = { url: string; size: number; byteSize: number } | null;
const MAX_BYTES = 2 * 1024 * 1024;
const mb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`);

type BrandColor = { color: string | null; contrastOnWhite: number | null };
// 시안(design/project/SA-060.dc.html v256)의 대표 색상 칩 8개. 첫 칸이 플랫폼 기본색이고, 고르면 지운다(null).
const DEFAULT_BRAND = "#5B3DF6";
const BRAND_CHIPS = [DEFAULT_BRAND, "#2A62D9", "#0F766E", "#C0262C", "#B45309", "#1E2B4D", "#7C3AED", "#0891B2"];
// 흰 바탕과의 대비(WCAG 2). 서버가 저장된 색에 주는 값과 같은 식이다. 기본색은 서버 값이 없어 화면에서 계산한다.
function contrastWhite(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return 1.05 / (l + 0.05);
}

// 칩을 누르면 바로 저장한다(로고와 같음). 쇼핑몰 설정 권한이 있는 계정에만 보인다(서버가 조회도 그 권한을 요구).
function BrandColorRow({ onToast }: { onToast: (t: string) => void }) {
  const { confirm } = useConfirm();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error" } | { kind: "ok"; saved: BrandColor }>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ brandColor: BrandColor }>("/api/seller/brand-color");
    setState(r.ok ? { kind: "ok", saved: r.data.brandColor } : { kind: "error" });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === "loading") return null;
  if (state.kind === "error")
    return (
      <FormRow label="대표 색상">
        <span className="err" role="alert">
          대표 색상을 불러오지 못했습니다
        </span>
        <button className="btn btn-sm btn-out" type="button" onClick={() => void load()}>
          다시 시도
        </button>
      </FormRow>
    );

  const saved = state.saved;
  const current = saved.color ?? DEFAULT_BRAND;
  // 시안 밖의 색(예전에 직접 정한 값)은 끝에 칩을 하나 더 두어 지금 값이 보이게 한다
  const chips = BRAND_CHIPS.includes(current) ? BRAND_CHIPS : [...BRAND_CHIPS, current];
  const ratio = saved.color ? (saved.contrastOnWhite ?? contrastWhite(saved.color)) : contrastWhite(DEFAULT_BRAND);

  const pick = async (color: string) => {
    if (busy || color === current) return;
    if (!(await confirm({ title: "대표 색상을 바꾸시겠습니까?", body: "쇼핑몰의 버튼 · 강조 · 오버레이 기본색이 바로 바뀝니다.", confirmLabel: "바꾸기" }))) return;
    setBusy(true);
    setError(null);
    const r = await api<{ brandColor: BrandColor }>("/api/seller/brand-color", { method: "PUT", body: { color: color === DEFAULT_BRAND ? null : color } });
    setBusy(false);
    if (!r.ok) return setError(failMessage(r, "admin", "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오"));
    setState({ kind: "ok", saved: r.data.brandColor });
    onToast("대표 색상을 바꿨습니다 · 쇼핑몰에 바로 반영됩니다");
  };

  return (
    <FormRow label="대표 색상">
      <div className="row" style={{ gap: 4, flexWrap: "wrap", alignItems: "center" }} role="radiogroup" aria-label="대표 색상" aria-busy={busy}>
        {chips.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={c === current}
            aria-label={c === DEFAULT_BRAND ? `${c} (기본색)` : c}
            disabled={busy}
            onClick={() => void pick(c)}
            data-testid="brand-chip"
            style={{
              width: 22,
              height: 22,
              padding: 0,
              border: 0,
              borderRadius: 2,
              background: c,
              cursor: busy ? "default" : "pointer",
              boxShadow: c === current ? "0 0 0 2px #fff, 0 0 0 3px #333" : "inset 0 0 0 1px rgba(0,0,0,.1)",
            }}
          />
        ))}
        <span className="help" data-testid="brand-hint">
          버튼 · 강조 · 오버레이 기본색 · 흰 글자 대비 {ratio.toFixed(1)} : 1 ✓
        </span>
      </div>
      {error && (
        <span className="err" role="alert">
          {error}
        </span>
      )}
    </FormRow>
  );
}

type Profile = { shopName: string; shopTagline: string | null };
const NAME_MAX = 20;
const TAGLINE_MAX = 40;
const len = (v: string) => [...v].length;

export default function ShopInfoPage() {
  const { me, can } = useSeller();
  const { confirm } = useConfirm();
  const editable = can("SHOP_SETTINGS");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [tagline, setTagline] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  const [host, setHost] = useState("");
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
  // 이름·한 줄 소개는 「쇼핑몰 설정」 권한이 있는 계정만 읽고 바꾼다(서버가 조회도 그 권한을 요구)
  const loadProfile = useCallback(async () => {
    const r = await api<{ profile: Profile }>("/api/seller/shop-profile");
    if (!r.ok) return;
    setProfile(r.data.profile);
    setName(r.data.profile.shopName);
    setTagline(r.data.profile.shopTagline ?? "");
  }, []);
  useEffect(() => {
    setHost(window.location.host);
    if (editable) void loadProfile();
  }, [editable, loadProfile]);

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
    setToast("로고를 바꿨습니다 · 쇼핑몰에 바로 반영됩니다");
  };

  const remove = async () => {
    if (working.current) return;
    if (!(await confirm({ title: "로고를 지우시겠습니까?", body: "쇼핑몰에는 쇼핑몰 이름 첫 글자가 대신 표시됩니다.", confirmLabel: "지우기", danger: true }))) return;
    working.current = true;
    setBusy(true);
    setError(null);
    const r = await api<{ logo: Logo }>("/api/seller/shop-content/logo", { method: "DELETE" });
    working.current = false;
    setBusy(false);
    if (!r.ok) return setError(r.status === 403 ? "변경 권한이 없습니다" : "로고를 지우지 못했습니다");
    setState({ kind: "ok", logo: null });
    setToast("로고를 지웠습니다 · 쇼핑몰 이름 첫 글자로 표시됩니다");
  };

  const pick = () => editable && !busy && input.current?.click();
  const logo = state.kind === "ok" ? state.logo : null;
  const shownName = editable && profile ? name.trim() || profile.shopName : me.shop.name;
  const letter = [...shownName.trim()][0] ?? "";
  const nameError = name.trim() === "" ? "쇼핑몰 이름을 적어 주십시오" : len(name.trim()) > NAME_MAX ? `쇼핑몰 이름은 ${NAME_MAX}자까지 쓸 수 있습니다` : null;
  const taglineError = len(tagline.trim()) > TAGLINE_MAX ? `한 줄 소개는 ${TAGLINE_MAX}자까지 쓸 수 있습니다` : null;
  const dirty = !!profile && (name.trim() !== profile.shopName || (tagline.trim() || null) !== profile.shopTagline);
  const shopUrl = `${host}/shop/${me.shop.slug}`;

  const save = async () => {
    if (!profile) return;
    if (nameError || taglineError) {
      setShowErrors(true);
      return;
    }
    if (!(await confirm({ title: "쇼핑몰 정보를 저장하시겠습니까?", body: "쇼핑몰 이름 · 한 줄 소개가 구매자 쇼핑몰에 바로 바뀝니다.", confirmLabel: "저장" }))) return;
    setSaving(true);
    setSaveFailure(null);
    const r = await api<{ profile: Profile }>("/api/seller/shop-profile", { method: "PUT", body: { shopName: name.trim(), shopTagline: tagline.trim() === "" ? null : tagline.trim() } });
    setSaving(false);
    if (!r.ok) return setSaveFailure(failMessage(r, "admin", "저장하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오"));
    setProfile(r.data.profile);
    setName(r.data.profile.shopName);
    setTagline(r.data.profile.shopTagline ?? "");
    setShowErrors(false);
    setToast("쇼핑몰 정보를 저장했습니다 · 쇼핑몰에 바로 반영됩니다");
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.protocol}//${shopUrl}`);
      setToast("쇼핑몰 주소를 복사했습니다");
    } catch {
      setToast("복사하지 못했습니다. 주소를 직접 선택해 복사해 주십시오");
    }
  };

  return (
    <>
      <Topbar crumb="설정 › 쇼핑몰 정보" />
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
            <FormSection title="쇼핑몰 정보">
              <FormRow label="운영 상태" help="준비 중 · 일시 정지는 구매자에게 안내 화면만 보이고 주문 조회만 열립니다">
                <div className="row" role="radiogroup" aria-label="운영 상태" style={{ gap: 24, flexWrap: "wrap" }}>
                  <label className="chk">
                    <input type="radio" name="shop-mode" checked readOnly />
                    운영 중
                  </label>
                  <label className="chk c-alt">
                    <input type="radio" name="shop-mode" disabled />
                    준비 중
                  </label>
                  <label className="chk c-alt">
                    <input type="radio" name="shop-mode" disabled />
                    일시 정지
                  </label>
                  <span className="t-c1 c-alt">준비 중 · 일시 정지는 곧 열립니다</span>
                </div>
              </FormRow>
              {editable && profile ? (
                <>
                  <FormRow label="쇼핑몰 이름" required htmlFor="shop-name">
                    <input id="shop-name" className={`inp${showErrors && nameError ? " is-error" : ""}`} type="text" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 360 }} aria-invalid={showErrors && !!nameError} disabled={saving} />
                    <span className="t-l2 c-alt">{len(name.trim())} / {NAME_MAX}</span>
                    {showErrors && nameError && <span className="err">{nameError}</span>}
                  </FormRow>
                  <FormRow label="한 줄 소개" htmlFor="shop-tagline">
                    <input id="shop-tagline" className={`inp${showErrors && taglineError ? " is-error" : ""}`} type="text" value={tagline} onChange={(e) => setTagline(e.target.value)} style={{ width: 520, maxWidth: "100%" }} aria-invalid={showErrors && !!taglineError} disabled={saving} />
                    <span className="t-l2 c-alt">{len(tagline.trim())} / {TAGLINE_MAX}</span>
                    {showErrors && taglineError && <span className="err">{taglineError}</span>}
                  </FormRow>
                </>
              ) : (
                <FormRow label="쇼핑몰 이름">
                  <span>{me.shop.name}</span>
                </FormRow>
              )}
              <FormRow label="로고" help="칸을 누르거나 파일을 끌어다 놓으면 올라갑니다 · 로고가 없으면 쇼핑몰 이름 첫 글자를 씁니다">
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
                    <span className="help">PNG · 정사각형 · 512px 이상 · 2MB 이하</span>
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
              {editable && <BrandColorRow onToast={setToast} />}
              <FormRow label="쇼핑몰 주소" help="기본 주소 · 언제나 열려 있습니다">
                <span data-testid="shop-url">{shopUrl}</span>
                <button className="btn btn-sm btn-out" type="button" onClick={() => void copy()}>
                  복사
                </button>
                <span className="t-c1 c-pos">연결됨</span>
              </FormRow>
            </FormSection>
            <div style={{ marginTop: 32 }}>
              <FormSection title="구매자 화면 미리보기">
                <FormRow label="쇼핑몰 맨 위" help="쇼핑몰 모든 화면 맨 위에 이렇게 표시됩니다">
                  <div className="si-preview" data-testid="logo-preview">
                    {logo ? <img src={logo.url} alt="" /> : <span className="si-mini-letter">{letter}</span>}
                    <b>{shownName}</b>
                    {editable && tagline.trim() && <span className="t-l2 c-alt"> · {tagline.trim()}</span>}
                  </div>
                </FormRow>
              </FormSection>
            </div>
            {saveFailure && (
              <div className="msg msg-neg" role="alert" style={{ marginTop: 16 }}>
                <span>
                  <b>저장할 수 없습니다.</b> {saveFailure}
                </span>
              </div>
            )}
            <FormFoot>
              {editable && (
                <>
                  <button className="btn btn-lg" type="button" disabled={saving || !dirty} onClick={() => void save()}>
                    {saving ? "저장 중" : "저장"}
                  </button>
                  <button
                    className="btn btn-lg btn-out"
                    type="button"
                    disabled={saving || !dirty}
                    onClick={() => profile && (setName(profile.shopName), setTagline(profile.shopTagline ?? ""), setShowErrors(false), setSaveFailure(null))}
                  >
                    취소
                  </button>
                </>
              )}
              <Link className="btn btn-lg btn-out" href={`/shop/${me.shop.slug}`} target="_blank" rel="noreferrer">
                쇼핑몰 보기
              </Link>
            </FormFoot>
          </>
        )}
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
