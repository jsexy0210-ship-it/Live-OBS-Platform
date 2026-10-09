"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FormFoot, FormRow, FormSection, PageHead, useConfirm } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { Toast } from "../../../../../../components/seller/States";
import { api, apiUpload, failMessage } from "../../../../../../components/seller/api";
import { cleanText, textLength, type TextKind } from "../../../../../../lib/server/text/clean";
import { useUnsavedGuard } from "../../../../../../lib/client/navigation";
import { BusinessSection } from "./BusinessSection";
import { DomainSection } from "./DomainSection";
import type { SectionHandle } from "./sectionSave";
import "./shop-info.css";

// SA-060 쇼핑몰 정보(파트너스 관리자, 설정 › 쇼핑몰 설정) (a)구역: 운영 상태·이름·한 줄 소개·로고·대표 색상·주소. 파비콘·공유 카드·도메인·사업자 구역은 이어서 붙인다.
// ②구역: 탭 아이콘(GET·PUT·DELETE /api/seller/favicon, PNG 정사각형 64~1024px·256KB 이하, 올리면 바로 반영)과 공유 제목·설명(GET·PUT /api/seller/share-preview)·미리보기.
// 공유 제목·설명도 같은 저장 줄에서 저장한다. 공유 카드 이미지 올리기는 서버(이미지 저장소)가 정해진 뒤 연다.
// 이름·한 줄 소개는 아래 저장 줄(저장 앞 확인 창)로 저장한다. API: GET·PUT /api/seller/shop-profile { shopName(1~20자), shopTagline(≤40자) }.
// 로고 상자 자체가 올리는 곳이다(누르거나 끌어다 놓기, 미리보기, 바꾸기·지우기). PNG만, 2MB 이하, 정사각형 512px 이상(1440px까지).
// 보기는 모든 직원, 바꾸기는 대표자·「쇼핑몰 설정」 권한 직원. API: /api/seller/shop-content/logo.
// 대표 색상(쇼핑몰 설정 권한이 있는 계정에만 보임): 시안 칩 8개 중 하나를 누르면 확인 창을 거쳐 저장. GET·PUT /api/seller/brand-color { color: "#RRGGBB" | null }(기본색 칩은 null).
// 화면 문구는 명사형·합니다체.

type Favicon = { source: "UPLOADED" | "LOGO" | null; urls: Record<string, string> | null; uploaded: { width: number; byteSize: number } | null };
type Share = { title: string | null; description: string | null };
const SHARE_TITLE_MAX = 60;
const SHARE_DESC_MAX = 160;
const FAVICON_MAX_BYTES = 256 * 1024;
// 서버(lib/server/shop/sharePreview.ts)와 같은 기준: NFKC 뒤 글자 수, 그리고 cleanText가 받지 않는 글자(줄바꿈·제어 문자 등)
function shareProblem(v: string, max: number, kind: TextKind): string | null {
  if (v.trim() === "" || cleanText(v, max, kind) !== null) return null;
  if (textLength(v) > max) return `${max}자까지 쓸 수 있습니다`;
  return /[\r\n]/.test(v) ? "줄바꿈 없이 써 주십시오" : "사용할 수 없는 문자가 있습니다";
}
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

type OperatingState = "OPEN" | "PREPARING" | "PAUSED";
type Primary = "DEFAULT" | "CUSTOM";
type Profile = { shopName: string; shopTagline: string | null; operatingState: OperatingState; topNotice: string | null; homeBenefitBannerVisible: boolean; usageGuide: string | null; primaryAddress: Primary; primaryDomain: string | null };
const MODE_LABEL: Record<OperatingState, string> = { OPEN: "운영 중", PREPARING: "준비 중", PAUSED: "일시 정지" };
const NAME_MAX = 20;
const TAGLINE_MAX = 40;
const TOP_NOTICE_MAX = 60;
const USAGE_GUIDE_MAX = 1000;
const len = (v: string) => [...v].length;

export default function ShopInfoPage() {
  const { me, can } = useSeller();
  const { confirm } = useConfirm();
  const editable = can("SHOP_SETTINGS");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [tagline, setTagline] = useState("");
  const [mode, setMode] = useState<OperatingState>("OPEN");
  const [topNotice, setTopNotice] = useState("");
  const [benefit, setBenefit] = useState(true);
  const [usageGuide, setUsageGuide] = useState("");
  const [primary, setPrimary] = useState<Primary>("DEFAULT");
  const [primaryDomain, setPrimaryDomain] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  const [host, setHost] = useState("");
  const [share, setShare] = useState<Share | null>(null);
  const [shareTitle, setShareTitle] = useState("");
  const [shareDesc, setShareDesc] = useState("");
  const [favicon, setFavicon] = useState<Favicon | null>(null);
  const [faviconBusy, setFaviconBusy] = useState(false);
  const [faviconError, setFaviconError] = useState<string | null>(null);
  const faviconInput = useRef<HTMLInputElement>(null);
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
    setMode(r.data.profile.operatingState);
    setTopNotice(r.data.profile.topNotice ?? "");
    setBenefit(r.data.profile.homeBenefitBannerVisible);
    setUsageGuide(r.data.profile.usageGuide ?? "");
    setPrimary(r.data.profile.primaryAddress);
    setPrimaryDomain(r.data.profile.primaryDomain);
  }, []);
  // 도메인을 확인하거나 해제하면 「대표 주소」로 고를 수 있는 도메인만 다시 읽는다(입력 중인 값은 건드리지 않는다)
  const reloadPrimaryDomain = useCallback(async () => {
    const r = await api<{ profile: Profile }>("/api/seller/shop-profile");
    if (!r.ok) return;
    setProfile((p) => (p ? { ...p, primaryDomain: r.data.profile.primaryDomain, primaryAddress: r.data.profile.primaryAddress } : p));
    setPrimaryDomain(r.data.profile.primaryDomain);
    setPrimary((cur) => (cur === "CUSTOM" && !r.data.profile.primaryDomain ? "DEFAULT" : cur));
  }, []);
  const loadShare = useCallback(async () => {
    const r = await api<{ preview: Share }>("/api/seller/share-preview");
    if (!r.ok) return;
    setShare(r.data.preview);
    setShareTitle(r.data.preview.title ?? "");
    setShareDesc(r.data.preview.description ?? "");
  }, []);
  const loadFavicon = useCallback(async () => {
    const r = await api<{ favicon: Favicon }>("/api/seller/favicon");
    if (r.ok) setFavicon(r.data.favicon);
  }, []);
  useEffect(() => {
    setHost(window.location.host);
    if (editable) {
      void loadProfile();
      void loadShare();
      void loadFavicon();
    }
  }, [editable, loadProfile, loadShare, loadFavicon]);

  const uploadFavicon = async (file: File) => {
    if (faviconInput.current) faviconInput.current.value = "";
    setFaviconError(null);
    if (faviconBusy) return;
    if (file.size > FAVICON_MAX_BYTES) return setFaviconError(`256KB를 넘었습니다 · 지금 파일은 ${mb(file.size)}입니다`);
    setFaviconBusy(true);
    const r = await apiUpload<{ favicon: Favicon }>("/api/seller/favicon", file, { method: "PUT" });
    setFaviconBusy(false);
    if (!r.ok) {
      if (r.status === 401) return;
      return setFaviconError(r.message ?? (r.status === 0 ? "연결이 끊겼습니다. 인터넷 연결을 확인해 주십시오" : r.status === 403 ? "변경 권한이 없습니다" : "탭 아이콘을 올리지 못했습니다"));
    }
    setFavicon(r.data.favicon);
    setToast("탭 아이콘을 바꿨습니다 · 쇼핑몰에 바로 반영됩니다");
  };
  const removeFavicon = async () => {
    if (faviconBusy) return;
    if (!(await confirm({ title: "탭 아이콘을 지우시겠습니까?", body: "로고가 있으면 로고에서 자동으로 만들어 쓰고, 로고도 없으면 기본 아이콘을 씁니다.", confirmLabel: "지우기", danger: true }))) return;
    setFaviconBusy(true);
    setFaviconError(null);
    const r = await api<{ favicon: Favicon }>("/api/seller/favicon", { method: "DELETE" });
    setFaviconBusy(false);
    if (!r.ok) return setFaviconError(r.status === 403 ? "변경 권한이 없습니다" : "탭 아이콘을 지우지 못했습니다");
    setFavicon(r.data.favicon);
    setToast("탭 아이콘을 지웠습니다");
  };

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
  const titleProblem = shareProblem(shareTitle, SHARE_TITLE_MAX, "name");
  const descProblem = shareProblem(shareDesc, SHARE_DESC_MAX, "memo");
  const topNoticeError = len(topNotice.trim()) > TOP_NOTICE_MAX ? `상단 공지는 ${TOP_NOTICE_MAX}자까지 쓸 수 있습니다` : topNotice.includes("\n") ? "상단 공지는 한 줄로 써 주십시오" : null;
  const guideError = len(usageGuide.trim()) > USAGE_GUIDE_MAX ? `이용안내는 ${USAGE_GUIDE_MAX.toLocaleString("ko-KR")}자까지 쓸 수 있습니다` : null;
  const modeDirty = !!profile && mode !== profile.operatingState;
  const textDirty = !!profile && (name.trim() !== profile.shopName || (tagline.trim() || null) !== profile.shopTagline);
  const noticeDirty = !!profile && ((topNotice.trim() || null) !== profile.topNotice || benefit !== profile.homeBenefitBannerVisible || (usageGuide.trim() || null) !== profile.usageGuide);
  const primaryDirty = !!profile && primary !== profile.primaryAddress;
  const profileDirty = textDirty || modeDirty || noticeDirty || primaryDirty;
  const shareDirty = !!share && ((share.title ?? "") !== shareTitle.trim() || (share.description ?? "") !== shareDesc.trim());
  // 내 도메인 · 사업자·고객센터 구역은 자기 상태를 알려 오고, 「저장」 하나가 바뀐 구역만 차례로 저장한다
  const sections = useRef<Record<string, SectionHandle>>({});
  const [sectionDirty, setSectionDirty] = useState<Record<string, boolean>>({});
  const onSection = useCallback((key: string, h: SectionHandle) => {
    sections.current[key] = h;
    setSectionDirty((p) => (p[key] === h.dirty ? p : { ...p, [key]: h.dirty }));
  }, []);
  const sectionsDirty = Object.values(sectionDirty).some(Boolean);
  const dirty = profileDirty || shareDirty || sectionsDirty;
  useUnsavedGuard(dirty); // 링크·브라우저 Back·새로고침에 같은 확인(docs/IA.md Back 규칙 7항)
  const previewTitle = cleanText(shareTitle, SHARE_TITLE_MAX, "name") ?? shownName;
  const previewDesc = cleanText(shareDesc, SHARE_DESC_MAX, "memo") ?? (tagline.trim() || "");
  const faviconUrl = favicon?.urls?.["32"] ?? "/branding/onq-32.png";
  const shopUrl = `${host}/shop/${me.shop.slug}`;

  const save = async () => {
    if (!profile) return;
    const changed = Object.values(sections.current).filter((h) => h.dirty);
    const sectionsOk = changed.map((h) => h.validate()).every(Boolean);
    if (nameError || taglineError || topNoticeError || guideError || titleProblem || descProblem || !sectionsOk) {
      setShowErrors(true);
      return;
    }
    const sectionNames = changed.map((h) => h.label).join(" · ");
    const others = (textDirty || shareDirty ? " 이름 · 소개 · 공유 문구 변경도 함께 저장됩니다." : "") + (changed.length ? ` ${sectionNames} 변경도 함께 저장됩니다.` : "");
    const ok = modeDirty
      ? await confirm({
          title: `쇼핑몰을 「${MODE_LABEL[mode]}」${mode === "PAUSED" ? "로" : "으로"} 바꾸시겠습니까?`,
          body:
            mode === "OPEN"
              ? `구매자가 다시 주문하고 결제할 수 있습니다.${others}`
              : `구매자에게는 ${MODE_LABEL[mode]} 안내만 보이고 주문 조회만 열립니다. 진행 중인 방송 주문대기는 계속 처리할 수 있고, 이미 받은 주문은 결제 · 처리할 수 있습니다.${others}`,
          confirmLabel: "전환",
          danger: mode !== "OPEN",
        })
      : await confirm({
          title: "쇼핑몰 정보를 저장하시겠습니까?",
          body:
            (shareDirty ? "쇼핑몰 이름 · 한 줄 소개 · 공유 제목 · 공유 설명이 구매자 쇼핑몰과 공유 화면에 바로 바뀝니다." : textDirty || modeDirty ? "쇼핑몰 이름 · 한 줄 소개가 구매자 쇼핑몰에 바로 바뀝니다." : noticeDirty || primaryDirty ? "공지 · 이용안내 · 대표 주소가 구매자 쇼핑몰에 바로 바뀝니다." : "") +
            (changed.length ? `${profileDirty || shareDirty ? " " : ""}${sectionNames} 변경이 구매자 쇼핑몰에 바로 바뀝니다.` : ""),
          confirmLabel: "저장",
        });
    if (!ok) return;
    setSaving(true);
    setSaveFailure(null);
    // 구역마다 따로인 API를 차례로 부르고, 실패한 구역은 이름과 함께 모아서 보인다(성공한 구역은 저장된 상태로 남는다)
    const failures: string[] = [];
    if (profileDirty) {
      const r = await api<{ profile: Profile }>("/api/seller/shop-profile", { method: "PUT", body: {
          shopName: name.trim(),
          shopTagline: tagline.trim() === "" ? null : tagline.trim(),
          operatingState: mode,
          // 공지 · 이용안내 · 대표 주소는 바뀐 것만 보낸다(서버는 보낸 키만 바꾼다)
          ...(profile.topNotice !== (topNotice.trim() || null) ? { topNotice: topNotice.trim() === "" ? null : topNotice.trim() } : {}),
          ...(profile.homeBenefitBannerVisible !== benefit ? { homeBenefitBannerVisible: benefit } : {}),
          ...(profile.usageGuide !== (usageGuide.trim() || null) ? { usageGuide: usageGuide.trim() === "" ? null : usageGuide.trim() } : {}),
          ...(primaryDirty ? { primaryAddress: primary } : {}),
        },
      });
      if (!r.ok) {
        failures.push(`쇼핑몰 정보: ${failMessage(r, "admin", "저장하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오")}`);
      } else {
        setProfile(r.data.profile);
        setName(r.data.profile.shopName);
        setTagline(r.data.profile.shopTagline ?? "");
        setMode(r.data.profile.operatingState);
        setTopNotice(r.data.profile.topNotice ?? "");
        setBenefit(r.data.profile.homeBenefitBannerVisible);
        setUsageGuide(r.data.profile.usageGuide ?? "");
        setPrimary(r.data.profile.primaryAddress);
        setPrimaryDomain(r.data.profile.primaryDomain);
      }
    }
    if (shareDirty) {
      const r = await api<{ preview: Share }>("/api/seller/share-preview", { method: "PUT", body: { title: shareTitle.trim() || null, description: shareDesc.trim() || null } });
      if (!r.ok) {
        failures.push(`공유 제목 · 설명: ${failMessage(r, "admin", "저장하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오")}`);
      } else {
        setShare(r.data.preview);
        setShareTitle(r.data.preview.title ?? "");
        setShareDesc(r.data.preview.description ?? "");
      }
    }
    for (const h of changed) {
      const m = await h.save();
      if (m) failures.push(`${h.label}: ${m}`);
    }
    setSaving(false);
    if (failures.length > 0) return setSaveFailure(`저장하지 못한 구역이 있습니다 · ${failures.join(" / ")}`);
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
                  {(["OPEN", "PREPARING", "PAUSED"] as const).map((m) => (
                    <label key={m} className="chk">
                      <input
                        type="radio"
                        name="shop-mode"
                        checked={(editable && profile ? mode : "OPEN") === m}
                        disabled={!editable || !profile || saving}
                        onChange={() => setMode(m)}
                      />
                      {MODE_LABEL[m]}
                    </label>
                  ))}
                </div>
              </FormRow>
              {editable && profile ? (
                <>
                  <FormRow label="쇼핑몰 이름" required htmlFor="shop-name">
                    <input id="shop-name" placeholder="쇼핑몰 이름" className={`inp${showErrors && nameError ? " is-error" : ""}`} type="text" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 360 }} aria-invalid={showErrors && !!nameError} disabled={saving} />
                    <span className="t-l2 c-alt">{len(name.trim())} / {NAME_MAX}</span>
                    {showErrors && nameError && <span className="err">{nameError}</span>}
                  </FormRow>
                  <FormRow label="한 줄 소개" htmlFor="shop-tagline">
                    <input id="shop-tagline" placeholder="한 줄 소개 (40자)" className={`inp${showErrors && taglineError ? " is-error" : ""}`} type="text" value={tagline} onChange={(e) => setTagline(e.target.value)} style={{ width: 520, maxWidth: "100%" }} aria-invalid={showErrors && !!taglineError} disabled={saving} />
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
                    className={`si-logo${logo ? " has-logo" : ""}${over ? " is-over" : ""}${editable ? " is-editable" : ""}`}
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
            {editable && profile && share && (
              <div style={{ marginTop: 32 }}>
                <FormSection title="파비콘 · 공유 카드" actions={<span className="t-l2 c-alt">브라우저 탭과 메신저 공유 때 보이는 모양</span>}>
                  <FormRow label="탭 아이콘(파비콘)" help="없으면 로고에서 자동 생성 (정사각형 가운데 맞춤 · 32 · 180 · 512px)">
                    <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className="si-fav"
                        aria-label={favicon?.source === "UPLOADED" ? "탭 아이콘 바꾸기" : "탭 아이콘 올리기"}
                        data-testid="favicon-box"
                        disabled={faviconBusy}
                        onClick={() => faviconInput.current?.click()}
                      >
                        {favicon?.source ? <img src={favicon.urls?.["180"] ?? faviconUrl} alt="탭 아이콘" /> : <b>+</b>}
                      </button>
                      <div className="col" style={{ gap: 6 }}>
                        <span className="help">PNG · 정사각형 · 64~1024px · 256KB 이하</span>
                        <div className="row" style={{ gap: 6 }}>
                          <button className="btn btn-sm btn-out" type="button" disabled={faviconBusy} onClick={() => faviconInput.current?.click()}>
                            {faviconBusy ? "올리는 중" : favicon?.source === "UPLOADED" ? "바꾸기" : "올리기"}
                          </button>
                          {favicon?.source === "UPLOADED" && (
                            <button className="btn btn-sm btn-text" type="button" style={{ color: "var(--neg-text)" }} disabled={faviconBusy} onClick={() => void removeFavicon()}>
                              지우기
                            </button>
                          )}
                        </div>
                        {faviconError && (
                          <span className="err" role="alert">
                            {faviconError}
                          </span>
                        )}
                      </div>
                      <input ref={faviconInput} type="file" accept="image/png" hidden aria-label="탭 아이콘 파일" onChange={(e) => e.target.files?.[0] && void uploadFavicon(e.target.files[0])} />
                    </div>
                  </FormRow>
                  <FormRow label="공유 제목" htmlFor="share-title" help={`비우면 쇼핑몰 이름 · ${SHARE_TITLE_MAX}자`}>
                    <input id="share-title" placeholder="공유 카드 제목 (60자)" className={`inp${showErrors && titleProblem ? " is-error" : ""}`} value={shareTitle} onChange={(e) => setShareTitle(e.target.value)} style={{ width: 360 }} aria-invalid={!!titleProblem} disabled={saving} />
                    <span className="t-l2 c-alt">{textLength(shareTitle)} / {SHARE_TITLE_MAX}</span>
                    {titleProblem && <span className="err">{titleProblem}</span>}
                  </FormRow>
                  <FormRow label="공유 설명" htmlFor="share-desc" help={`비우면 한 줄 소개 · ${SHARE_DESC_MAX}자`}>
                    <input id="share-desc" placeholder="공유 카드 설명 한 줄" className={`inp${showErrors && descProblem ? " is-error" : ""}`} value={shareDesc} onChange={(e) => setShareDesc(e.target.value)} style={{ width: 520, maxWidth: "100%" }} aria-invalid={!!descProblem} disabled={saving} />
                    <span className="t-l2 c-alt">{textLength(shareDesc)} / {SHARE_DESC_MAX}</span>
                    {descProblem && <span className="err">{descProblem}</span>}
                  </FormRow>
                  <FormRow label="공유 카드 이미지" help="없으면 쇼핑몰 이름 · 로고로 기본 카드를 만듭니다 · 상품 상세는 상품 이미지가 우선">
                    <div className="si-card-up" aria-disabled="true">
                      <b>+</b>
                      <span>공유 카드 이미지</span>
                      <span className="t-c1">1200×630 · JPG · PNG · 2MB</span>
                    </div>
                    <span className="t-c1 c-alt">곧 열립니다</span>
                  </FormRow>
                  <FormRow label="미리보기" help="입력하면 저장 전에도 아래 미리보기에 바로 반영됩니다 · 파비콘은 카드 왼쪽 위에 함께 보입니다">
                    <div className="row" style={{ gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
                      <div className="sp-card" data-testid="sp-card">
                        <img className="sp-card-img" src={`/api/shop/${encodeURIComponent(me.shop.slug)}/og.png`} alt="" width={1200} height={630} />
                        <div className="sp-card-body col">
                          <span className="sp-card-title row" style={{ gap: 8, alignItems: "center" }}>
                            <img src={faviconUrl} alt="" width={16} height={16} />
                            {previewTitle}
                          </span>
                          {previewDesc && <span className="sp-card-desc">{previewDesc}</span>}
                          <span className="sp-card-host">{host}</span>
                        </div>
                      </div>
                      <div className="si-tab" data-testid="tab-preview">
                        <img src={faviconUrl} alt="" width={14} height={14} />
                        {previewTitle} <span className="t-c1 c-alt">· 브라우저 탭</span>
                      </div>
                    </div>
                  </FormRow>
                </FormSection>
              </div>
            )}
            {editable && (
              <DomainSection
                onToast={setToast}
                onSection={onSection}
                disabled={saving}
                onChanged={() => void reloadPrimaryDomain()}
                primary={primary}
                onPrimary={setPrimary}
                primaryDomain={primaryDomain}
                defaultAddress={shopUrl}
              />
            )}
            {editable && <BusinessSection onSection={onSection} disabled={saving} />}
            {editable && profile && (
              <div style={{ marginTop: 32 }} data-testid="notice-section">
                <FormSection title="공지 · 이용안내">
                  <FormRow label="상단 공지 (한 줄)" htmlFor="top-notice" help="모든 쇼핑몰 화면 맨 위에 한 줄로 보입니다 · 비우면 보이지 않습니다 · 홈 띠 고정 공지는 「쇼핑몰 공지 · 질문」에서 관리">
                    <input id="top-notice" placeholder="상단 공지 한 줄" className={`inp${showErrors && topNoticeError ? " is-error" : ""}`} value={topNotice} onChange={(e) => setTopNotice(e.target.value)} style={{ width: 520, maxWidth: "100%" }} aria-invalid={showErrors && !!topNoticeError} disabled={saving} />
                    <span className="t-l2 c-alt">{len(topNotice.trim())} / {TOP_NOTICE_MAX}</span>
                    {showErrors && topNoticeError && <span className="err" role="alert">{topNoticeError}</span>}
                  </FormRow>
                  <FormRow label="홈 혜택 배너" help="「등급 혜택」 「인기 카드」 배너 2장 · 적립금을 끄면 자동으로 숨깁니다">
                    <div className="row" role="radiogroup" aria-label="홈 혜택 배너" style={{ gap: 24 }}>
                      {([true, false] as const).map((v) => (
                        <label key={String(v)} className="chk">
                          <input type="radio" name="home-benefit" checked={benefit === v} disabled={saving} onChange={() => setBenefit(v)} />
                          {v ? "보이기" : "숨기기"}
                        </label>
                      ))}
                    </div>
                  </FormRow>
                  <FormRow label="이용안내 · 교환 · 환불 정책" htmlFor="usage-guide" help="구매자에게 보이는 글이라 해요체로 씁니다 · 줄바꿈이 그대로 보입니다">
                    <div className="col" style={{ gap: 4, width: "100%" }}>
                      <textarea id="usage-guide" placeholder="예: 개봉 전 주문은 취소할 수 있어요. 개봉하면 단순 변심으로는 취소 · 환불이 안 돼요." className={`inp${showErrors && guideError ? " is-error" : ""}`} rows={6} style={{ width: "100%", maxWidth: 820, padding: "10px 12px" }} value={usageGuide} onChange={(e) => setUsageGuide(e.target.value)} aria-invalid={showErrors && !!guideError} disabled={saving} />
                      <span className="t-l2 c-alt">{len(usageGuide.trim()).toLocaleString("ko-KR")} / {USAGE_GUIDE_MAX.toLocaleString("ko-KR")}</span>
                      {showErrors && guideError && <span className="err" role="alert">{guideError}</span>}
                    </div>
                  </FormRow>
                </FormSection>
              </div>
            )}
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
                    onClick={() => {
                      if (profile) (setName(profile.shopName), setTagline(profile.shopTagline ?? ""), setMode(profile.operatingState), setTopNotice(profile.topNotice ?? ""), setBenefit(profile.homeBenefitBannerVisible), setUsageGuide(profile.usageGuide ?? ""), setPrimary(profile.primaryAddress));
                      if (share) (setShareTitle(share.title ?? ""), setShareDesc(share.description ?? ""));
                      Object.values(sections.current).forEach((h) => h.reset());
                      setShowErrors(false);
                      setSaveFailure(null);
                    }}
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
