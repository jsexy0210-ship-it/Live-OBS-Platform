"use client";

import { useCallback, useEffect, useState } from "react";
import MarketingConsentDoc, { MARKETING_DOC_VERSION } from "./MarketingConsentDoc";
import ShopState from "./ShopState";

// SH-025 마케팅 정보 수신 설정. 끄면 바로 철회하고, 켜면 서식 전체를 보여 준 뒤 그 서식의 버전(MARKETING_DOC_VERSION)으로 동의한다.
// 서버의 지금 버전(currentVersion)과 다르거나 동의가 consent_outdated로 거절되면 동의를 받지 않고 새로고침을 안내한다(보인 적 없는 서식에 동의 기록 금지).
// 정보통신망법 제50조 제7항: 수신 동의·철회를 처리하면 보낸 곳(쇼핑몰)·처리 결과·처리 날짜를 바로 알린다(한국 날짜).
// 응답을 놓치거나 서버 오류면 지금 상태를 다시 읽어 실제 결과를 보여 준다.
type State = { agreed: boolean; agreedAt: string | null; version: string | null; withdrawnAt: string | null; currentVersion: string };
type Res<T> = { ok: true; data: T } | { ok: false; status: number; error: string; message?: string };

async function call<T>(path: string, init?: { method: string; body: unknown }): Promise<Res<T>> {
  try {
    const res = await fetch(path, {
      method: init?.method ?? "GET",
      headers: init ? { "content-type": "application/json" } : undefined,
      body: init ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, data: data as T };
    const b = data as { error?: string; message?: string };
    return { ok: false, status: res.status, error: b.error ?? "unknown", message: b.message };
  } catch {
    return { ok: false, status: 0, error: "network" };
  }
}

// 한국 날짜(YYYY년 M월 D일)
const kstDate = (iso: string) =>
  new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" }).format(new Date(iso));

export default function MarketingConsent({ slug, shopName }: { slug: string; shopName: string }) {
  const path = `/api/shop/${encodeURIComponent(slug)}/me/marketing-consent`;
  const [view, setView] = useState<{ kind: "loading" } | { kind: "login" } | { kind: "error" } | { kind: "ok"; state: State }>({ kind: "loading" });
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // 화면을 연 뒤 서식이 바뀌어 새로고침해야 한다
  const [outdated, setOutdated] = useState(false);

  const load = useCallback(async () => {
    const r = await call<State>(path);
    if (r.ok) {
      setView({ kind: "ok", state: r.data });
      return r.data;
    }
    setView(r.status === 401 || r.status === 404 ? { kind: "login" } : { kind: "error" });
    return null;
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  const done = (s: State) =>
    setResult(
      s.agreed && s.agreedAt
        ? `${shopName}에서 보내는 마케팅 정보 수신에 동의했어요 · 처리일 ${kstDate(s.agreedAt)}`
        : s.withdrawnAt
          ? `${shopName}에서 보내는 마케팅 정보 수신을 철회했어요 · 처리일 ${kstDate(s.withdrawnAt)}`
          : null,
    );

  const save = async (agreed: boolean) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setResult(null);
    const r = await call<State>(path, { method: "PUT", body: agreed ? { agreed, marketingVersion: MARKETING_DOC_VERSION } : { agreed } });
    setBusy(false);
    if (r.ok) {
      setAsking(false);
      setView({ kind: "ok", state: r.data });
      return done(r.data);
    }
    if (r.status === 401 || r.status === 404) return setView({ kind: "login" });
    if (r.error === "consent_outdated") {
      // 서식이 바뀌었다: 이 화면의 글은 예전 서식이라 새 버전으로 동의를 받지 않고 새로고침하게 한다
      return setOutdated(true);
    }
    // 응답을 놓쳤거나 서버 오류: 지금 상태를 다시 읽어 바뀌었으면 결과를, 아니면 실패를 알린다
    const now = await load();
    if (now && now.agreed === agreed && (!agreed || now.version === MARKETING_DOC_VERSION)) {
      setAsking(false);
      return done(now);
    }
    setFailure(r.message ?? "바꾸지 못했어요. 잠시 뒤 다시 시도해 주세요");
  };

  if (view.kind === "loading") {
    return (
      <section className="card shop-card" aria-busy="true">
        <span className="t-l1 c-alt">알림 설정을 불러오고 있어요</span>
      </section>
    );
  }
  if (view.kind === "login") return <ShopState title="로그인이 필요해요" body="이 쇼핑몰에 로그인하면 알림 설정을 바꿀 수 있어요." />;
  if (view.kind === "error") {
    return (
      <section className="card shop-card col" style={{ gap: 12 }}>
        <span className="t-l1">알림 설정을 불러오지 못했어요</span>
        <button className="btn btn-sm" type="button" style={{ alignSelf: "flex-start" }} onClick={() => void load()}>
          다시 시도
        </button>
      </section>
    );
  }

  const s = view.state;
  // 예전 문구로 동의한 회원은 지금 문구로 다시 동의해야 한다
  const stale = s.agreed && s.version !== s.currentVersion;
  // 이 화면의 서식이 서버의 지금 서식과 다르다(화면을 연 뒤 바뀜)
  const needsReload = outdated || s.currentVersion !== MARKETING_DOC_VERSION;
  return (
    <section className="card shop-card col" style={{ gap: 16 }} aria-labelledby="mc-title">
      <h1 id="mc-title" className="t-h1">
        알림 설정
      </h1>
      {result && (
        <div className="msg msg-info" role="status" style={{ display: "block" }} data-testid="mc-result">
          {result}
        </div>
      )}
      {failure && (
        <div className="msg msg-neg" role="alert" style={{ display: "block" }}>
          {failure}
        </div>
      )}
      <div className="row between" style={{ gap: 12 }}>
        <span className="col" style={{ gap: 2 }}>
          <span className="t-l1 fw6" id="mc-label">
            마케팅 정보 받기
          </span>
          <span className="t-c1 c-alt" id="mc-help">
            {s.agreed ? "새 상품 · 방송 시작 · 할인 소식을 받고 있어요" : "새 상품 · 방송 시작 · 할인 소식을 받지 않아요"}
          </span>
        </span>
        <button
          className={`sw${s.agreed ? " on" : ""}`}
          type="button"
          role="switch"
          aria-checked={s.agreed}
          aria-labelledby="mc-label"
          aria-describedby="mc-help"
          disabled={busy}
          onClick={() => {
            setResult(null);
            setFailure(null);
            if (s.agreed) void save(false);
            else setAsking(true);
          }}
        />
      </div>
      {stale && !asking && (
        <div className="msg msg-cau" style={{ display: "block" }}>
          <span>동의 내용이 바뀌었어요. 계속 받으려면 다시 동의해 주세요.</span>
          <span className="row" style={{ marginTop: 8 }}>
            <button className="btn btn-sm" type="button" onClick={() => setAsking(true)}>
              다시 동의하기
            </button>
          </span>
        </div>
      )}
      {asking && needsReload && (
        <div className="msg msg-cau" role="alert" style={{ display: "block" }} data-testid="mc-reload">
          <span>
            <b>새로고침이 필요해요.</b> 동의 내용이 바뀌었어요. 새로고침한 뒤 바뀐 내용을 확인하고 동의해 주세요.
          </span>
          <span className="row" style={{ gap: 8, marginTop: 8 }}>
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
        <div className="card pad col" style={{ gap: 10, boxShadow: "inset 0 0 0 1px var(--wds-line-normal-normal)" }} data-testid="mc-terms">
          <span className="t-l1 fw6">마케팅 정보 수신 동의 (선택)</span>
          {/* 동의를 받기 전에 서식 전체(이용 목적·항목·보유 기간)를 보여 준다 */}
          <MarketingConsentDoc shopName={shopName} />
          <span className="row" style={{ gap: 8 }}>
            <button className={`btn btn-sm${busy ? " is-loading" : ""}`} type="button" disabled={busy} onClick={() => void save(true)}>
              동의하고 받기
            </button>
            <button
              className="btn btn-sm btn-out"
              type="button"
              disabled={busy}
              onClick={() => {
                setAsking(false);
                setFailure(null);
              }}
            >
              취소
            </button>
          </span>
        </div>
      )}
    </section>
  );
}
