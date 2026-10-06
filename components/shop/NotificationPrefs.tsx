"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useConfirm } from "../admin-ui/ConfirmDialog";
import MarketingConsentDoc, { MARKETING_DOC_VERSION } from "./MarketingConsentDoc";
import MyMenu from "./MyMenu";
import ShopBack from "./ShopBack";
import { call } from "./reviewShared";
import "./Cart.css";
import "./MyMenu.css";
import "./NotificationPrefs.css";

// SH-025 알림 설정(보드 SH-025-IA FINAL): 「알림 종류 × 알림톡·문자 / 이메일」 표. 주문·결제와 내 차례는 끌 수 없고, 배송은 채널별, 방송 시작·할인·재입고·혜택은 이메일만(광고성).
// 혜택 · 이벤트 이메일 칸 = 마케팅 수신 동의 그 자체: 켜면 동의 서식 전체를 보여 준 뒤 그 서식의 버전(MARKETING_DOC_VERSION)으로 동의하고, 끄면 철회한다.
// 서버의 지금 서식 버전과 다르거나 동의가 consent_outdated로 거절되면 동의를 받지 않고 새로고침을 안내한다(보인 적 없는 서식에 동의 기록 금지).
// 정보통신망법 제50조 제7항: 수신 동의·철회를 처리하면 보낸 곳(쇼핑몰)·처리 결과·처리 날짜를 바로 알린다(한국 날짜). 응답을 놓치면 지금 상태를 다시 읽어 실제 결과를 보여 준다.
// API: GET·PUT /api/shop/{slug}/me/notification-prefs.
type Kind = "ORDER" | "QUEUE" | "SHIPPING" | "BROADCAST_START" | "DISCOUNT_RESTOCK" | "BENEFIT";
type Item = { kind: Kind; required: boolean; ad: boolean; message: boolean | null; email: boolean | null };
type State = { items: Item[]; marketing: { agreed: boolean; agreedAt: string | null; version: string | null; withdrawnAt: string | null; currentVersion: string } };
type Cells = Partial<Record<Kind, { message?: boolean; email?: boolean }>>;
type View = { kind: "loading" } | { kind: "login" } | { kind: "error" } | { kind: "ok"; state: State };

const ROWS: Record<Kind, { title: string; sub: string }> = {
  ORDER: { title: "주문 · 결제", sub: "주문 접수 · 입금 확인 · 결제 실패 · 끌 수 없어요" },
  QUEUE: { title: "내 차례 알림", sub: "방송에서 내 차례가 가까워지면 알려 드려요 · 끌 수 없어요" },
  SHIPPING: { title: "배송", sub: "송장 등록 · 배송 완료" },
  BROADCAST_START: { title: "방송 시작", sub: "판매자가 방송을 시작하면" },
  DISCOUNT_RESTOCK: { title: "할인 · 재입고", sub: "찜한 상품의 할인 · 재입고 소식" },
  BENEFIT: { title: "혜택 · 이벤트 (선택)", sub: "쿠폰 · 등급 · 이벤트 안내" },
};
const kstDate = (iso: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" }).format(new Date(iso));

export default function NotificationPrefs({ slug, shopName }: { slug: string; shopName: string }) {
  const { confirm } = useConfirm();
  const base = `/shop/${encodeURIComponent(slug)}`;
  const path = `/api/shop/${encodeURIComponent(slug)}/me/notification-prefs`;
  const [view, setView] = useState<View>({ kind: "loading" });
  const [draft, setDraft] = useState<Cells>({});
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [outdated, setOutdated] = useState(false);

  const load = useCallback(async () => {
    const r = await call<State>(path);
    if (r.ok) {
      setView({ kind: "ok", state: r.data });
      setDraft({});
      return r.data;
    }
    setView({ kind: r.status === 401 || r.status === 404 ? "login" : "error" });
    return null;
  }, [path]);
  useEffect(() => void load(), [load]);

  if (view.kind === "loading")
    return (
      <Shell base={base} slug={slug}>
        <p className="shop-empty" aria-busy="true">
          알림 설정을 불러오고 있어요
        </p>
      </Shell>
    );
  if (view.kind === "login")
    return (
      <Shell base={base} slug={slug}>
        <div className="cart-empty">
          <h2>로그인이 필요해요</h2>
          <p>이 쇼핑몰에 로그인하면 알림 설정을 바꿀 수 있어요.</p>
          <Link className="btn" href={`${base}/login?next=${encodeURIComponent(`${base}/me/notifications`)}`}>
            로그인
          </Link>
        </div>
      </Shell>
    );
  if (view.kind === "error")
    return (
      <Shell base={base} slug={slug}>
        <div className="cart-empty">
          <p>불러오지 못했어요. 네트워크를 확인하고 다시 시도해 주세요.</p>
          <button className="btn" type="button" onClick={() => void load()}>
            다시 불러오기
          </button>
        </div>
      </Shell>
    );

  const s = view.state;
  const item = (k: Kind) => s.items.find((i) => i.kind === k)!;
  const cur = (k: Kind, ch: "message" | "email"): boolean => draft[k]?.[ch] ?? item(k)[ch] ?? false;
  const benefitOn = cur("BENEFIT", "email");
  // 예전 문구로 동의한 회원은 지금 문구로 다시 동의해야 한다
  const stale = s.marketing.agreed && s.marketing.version !== s.marketing.currentVersion;
  const needsReload = outdated || s.marketing.currentVersion !== MARKETING_DOC_VERSION;

  const set = (k: Kind, ch: "message" | "email", v: boolean) => {
    setResult(null);
    setFailure(null);
    setDraft((d) => {
      const next = { ...d, [k]: { ...d[k], [ch]: v } };
      // 혜택 · 이벤트를 끄면 광고성 메일은 함께 꺼진다
      if (k === "BENEFIT" && !v) {
        next.BROADCAST_START = { email: false };
        next.DISCOUNT_RESTOCK = { email: false };
      }
      return next;
    });
  };

  const done = (st: State, benefitChanged: boolean) => {
    if (benefitChanged) {
      setResult(
        st.marketing.agreed && st.marketing.agreedAt
          ? `${shopName}에서 보내는 혜택·이벤트 알림 받기에 동의했어요 · 동의한 날 ${kstDate(st.marketing.agreedAt)}`
          : st.marketing.withdrawnAt
            ? `${shopName}에서 보내는 혜택·이벤트 알림을 껐어요 · 처리한 날 ${kstDate(st.marketing.withdrawnAt)} · 다시 켜면 언제든 받을 수 있어요`
            : "알림 설정을 저장했어요",
      );
    } else setResult("알림 설정을 저장했어요");
  };

  const save = async (withConsent: boolean) => {
    if (busy) return;
    const prefs: Record<string, { message?: boolean; email?: boolean }> = {};
    for (const [k, v] of Object.entries(draft)) {
      const changed: { message?: boolean; email?: boolean } = {};
      for (const ch of ["message", "email"] as const) {
        const nv = v?.[ch];
        if (nv !== undefined && nv !== item(k as Kind)[ch]) changed[ch] = nv;
      }
      if (Object.keys(changed).length > 0) prefs[k] = changed;
    }
    const benefitChanged = prefs.BENEFIT?.email !== undefined;
    if (Object.keys(prefs).length === 0) return setResult("바뀐 내용이 없어요");
    if (prefs.BENEFIT?.email === true && !withConsent) return setAsking(true);
    if (prefs.BENEFIT?.email === false) {
      const ok = await confirm({ tone: "shop", title: "혜택 · 이벤트 알림을 그만 받을까요?", body: "방송 시작 · 할인 · 재입고 · 혜택 소식이 오지 않아요. 언제든 다시 켤 수 있어요.", confirmLabel: "그만 받기" });
      if (!ok) return;
    }
    setBusy(true);
    setFailure(null);
    setResult(null);
    const r = await call<State>(path, { method: "PUT", body: prefs.BENEFIT?.email === true ? { prefs, marketingVersion: MARKETING_DOC_VERSION } : { prefs } });
    setBusy(false);
    if (r.ok) {
      setAsking(false);
      setView({ kind: "ok", state: r.data });
      setDraft({});
      return done(r.data, benefitChanged);
    }
    if (r.status === 401 || r.status === 404) return setView({ kind: "login" });
    // 서식이 바뀌었다: 이 화면의 글은 예전 서식이라 새 버전으로 동의를 받지 않고 새로고침하게 한다
    if (r.error === "consent_outdated") return setOutdated(true);
    // 응답을 놓쳤거나 서버 오류: 지금 상태를 다시 읽어 바뀌었으면 결과를, 아니면 실패를 알린다
    const before = draft;
    const now = await load();
    if (now) {
      const applied = Object.entries(prefs).every(([k, v]) => Object.entries(v).every(([ch, nv]) => now.items.find((i) => i.kind === k)?.[ch as "message" | "email"] === nv));
      if (applied) {
        setAsking(false);
        return done(now, benefitChanged);
      }
      setDraft(before);
    }
    setFailure(r.message ?? "저장하지 못했어요. 잠시 뒤 다시 시도해 주세요");
  };

  return (
    <Shell base={base} slug={slug}>
      {result && (
        <p className="msg msg-info t-l2" role="status" style={{ display: "block" }} data-testid="mc-result">
          {result}
        </p>
      )}
      {failure && (
        <p className="msg msg-neg t-l2" role="alert" style={{ display: "block" }}>
          {failure}
        </p>
      )}
      <table className="cart-tbl np-tbl">
        <thead>
          <tr>
            <th className="np-l">알림</th>
            <th className="np-c">알림톡 · 문자</th>
            <th className="np-c">이메일</th>
          </tr>
        </thead>
        <tbody>
          {s.items.map((i) => {
            const row = ROWS[i.kind];
            const fixed = i.required;
            // 방송 시작 · 할인 · 재입고 메일은 혜택 · 이벤트(마케팅 수신)를 켜야 받는다
            const emailLocked = i.ad && i.kind !== "BENEFIT" && !benefitOn;
            return (
              <tr key={i.kind}>
                <td className="np-l">
                  <b>{row.title}</b>
                  <span className="np-sub">{row.sub}</span>
                </td>
                <td className="np-c">
                  {i.message === null ? (
                    <span className="np-sub">— (메일만)</span>
                  ) : (
                    <input type="checkbox" aria-label={`${row.title} 알림톡·문자`} checked={cur(i.kind, "message")} disabled={fixed || busy} title={fixed ? "끌 수 없어요" : undefined} onChange={(e) => set(i.kind, "message", e.target.checked)} />
                  )}
                </td>
                <td className="np-c">
                  <input
                    type="checkbox"
                    aria-label={`${row.title} 이메일`}
                    checked={cur(i.kind, "email")}
                    disabled={fixed || busy || emailLocked}
                    title={fixed ? "끌 수 없어요" : emailLocked ? "혜택 · 이벤트를 켜면 받을 수 있어요" : undefined}
                    onChange={(e) => (i.kind === "BENEFIT" && e.target.checked ? setAsking(true) : set(i.kind, "email", e.target.checked))}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="msg msg-info t-l2" style={{ display: "block" }}>
        앱 알림(푸시)은 없어요 · 알림톡이 안 되면 문자로 보내요 · 방송 시작 · 할인 · 혜택 같은 광고성 소식은 메일로만 보내요 · <span style={{ whiteSpace: "nowrap" }}>야간(21~08시)에는</span> 보내지 않아요
      </p>
      {stale && !asking && (
        <p className="msg msg-cau t-l2" style={{ display: "block" }}>
          동의 내용이 바뀌었어요. 계속 받으려면{" "}
          <button className="shop-linkbtn" type="button" onClick={() => setAsking(true)}>
            다시 동의하기
          </button>
        </p>
      )}
      {asking && needsReload && (
        <div className="msg msg-cau" role="alert" style={{ display: "block" }} data-testid="mc-reload">
          <span>
            <b>새로고침이 필요해요.</b> 동의 내용이 바뀌었어요. 새로고침한 뒤 바뀐 내용을 확인하고 동의해 주세요.
          </span>
          <span className="np-btns">
            <button className="btn btn-sm" type="button" onClick={() => window.location.reload()}>
              새로고침
            </button>
            <button className="btn btn-sm btn-out" type="button" onClick={() => setAsking(false)}>
              취소
            </button>
          </span>
        </div>
      )}
      {asking && !needsReload && (
        <div className="np-terms" data-testid="mc-terms">
          <b>혜택 · 이벤트 알림 받기 (선택)</b>
          {/* 동의를 받기 전에 서식 전체(이용 목적·항목·보유 기간)를 보여 준다 */}
          <MarketingConsentDoc shopName={shopName} />
          <span className="np-btns">
            <button
              className={`btn btn-sm${busy ? " is-loading" : ""}`}
              type="button"
              disabled={busy}
              onClick={() => {
                set("BENEFIT", "email", true);
                // draft 반영 뒤 저장: 같은 틱에 상태를 읽지 못하므로 값을 직접 넣어 보낸다
                void saveWithBenefit();
              }}
            >
              동의하고 받기
            </button>
            <button className="btn btn-sm btn-out" type="button" disabled={busy} onClick={() => setAsking(false)}>
              취소
            </button>
          </span>
        </div>
      )}
      <div className="np-actions">
        <button className="btn" type="button" disabled={busy} aria-busy={busy} onClick={() => void save(false)}>
          {busy ? "저장하고 있어요" : "저장"}
        </button>
      </div>
    </Shell>
  );

  // 「동의하고 받기」: 지금까지 바꾼 칸과 함께 혜택 · 이벤트 동의를 한 번에 저장한다
  async function saveWithBenefit() {
    if (busy) return;
    const merged: Cells = { ...draft, BENEFIT: { ...draft.BENEFIT, email: true } };
    const prefs: Record<string, { message?: boolean; email?: boolean }> = {};
    for (const [k, v] of Object.entries(merged)) {
      const changed: { message?: boolean; email?: boolean } = {};
      for (const ch of ["message", "email"] as const) {
        const nv = v?.[ch];
        if (nv !== undefined && nv !== item(k as Kind)[ch]) changed[ch] = nv;
      }
      if (Object.keys(changed).length > 0) prefs[k] = changed;
    }
    if (!prefs.BENEFIT) prefs.BENEFIT = { email: true };
    setBusy(true);
    setFailure(null);
    setResult(null);
    const r = await call<State>(path, { method: "PUT", body: { prefs, marketingVersion: MARKETING_DOC_VERSION } });
    setBusy(false);
    if (r.ok) {
      setAsking(false);
      setView({ kind: "ok", state: r.data });
      setDraft({});
      return done(r.data, true);
    }
    if (r.status === 401 || r.status === 404) return setView({ kind: "login" });
    if (r.error === "consent_outdated") return setOutdated(true);
    const now = await load();
    if (now?.marketing.agreed && now.marketing.version === MARKETING_DOC_VERSION) {
      setAsking(false);
      return done(now, true);
    }
    setFailure(r.message ?? "저장하지 못했어요. 잠시 뒤 다시 시도해 주세요");
  }
}

function Shell({ base, slug, children }: { base: string; slug: string; children: React.ReactNode }) {
  return (
    <div className="shop-wrap cart-wrap">
      <ShopBack fallback={`${base}/me`} label="내 정보" />
      <div className="cart-head">
        <h1>알림 설정</h1>
      </div>
      <div className="my-wrap">
        <MyMenu slug={slug} />
        <div className="np-main">{children}</div>
      </div>
    </div>
  );
}
