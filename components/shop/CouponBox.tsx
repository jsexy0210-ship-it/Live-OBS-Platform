"use client";

import { useCallback, useEffect, useState } from "react";
import ShopState from "./ShopState";
import "./CouponBox.css";

// SH-028 내 쿠폰함. 코드 등록(방송 채팅·문자로 받은 코드), 쓸 수 있어요 · 받을 수 있어요 · 지난 쿠폰 탭.
// 쿠폰은 주문서에서 고르면 서버가 할인 금액을 계산한다(주문당 1장). API: /api/shop/{slug}/coupons.
type Coupon = {
  couponId: string;
  name: string;
  benefit: "AMOUNT" | "RATE" | "FREE_SHIPPING";
  value: number | null;
  maxDiscount: number | null;
  minOrderAmount: number;
  excludeDiscounted: boolean;
  allowWithReward: boolean;
  productScoped: boolean;
  startsAt: string;
  endsAt: string;
  validDays: number | null;
};
type Mine = Coupon & { issuedAt: string; expiresAt: string; usedAt: string | null; state: "usable" | "upcoming" | "used" | "expired" };
type Box = { usable: Mine[]; claimable: Coupon[]; claimableMore: boolean; past: Mine[]; now: string; shopOpen: boolean };
const PAGE = 50;
type Tab = "usable" | "claimable" | "past";

const DAY = 86_400_000;
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const md = (iso: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric" }).format(new Date(iso)).replace(/\.\s?/g, "/").replace(/\/$/, "");
const amountText = (c: Coupon) => (c.benefit === "FREE_SHIPPING" ? "배송비 무료" : c.benefit === "AMOUNT" ? won(c.value ?? 0) : `${c.value}%`);

function conditions(c: Coupon): string {
  const parts: string[] = [];
  if (c.benefit === "RATE" && c.maxDiscount) parts.push(`최대 ${won(c.maxDiscount)} 할인`);
  parts.push(c.minOrderAmount > 0 ? `${won(c.minOrderAmount)} 이상 주문` : "금액 조건 없음");
  if (c.productScoped) parts.push("일부 상품만");
  if (c.excludeDiscounted) parts.push("할인 중 상품 제외");
  return parts.join(" · ");
}

function MineItem({ c, now }: { c: Mine; now: number }) {
  const left = Math.ceil((new Date(c.expiresAt).getTime() - now) / DAY);
  const past = c.state === "used" || c.state === "expired";
  return (
    <li className={`cb-item${past ? " is-past" : ""}`}>
      <div className="cb-amt">
        <span className="t-h2 fw7">{amountText(c)}</span>
      </div>
      <div className="cb-body">
        <span className="t-b2 fw6">{c.name}</span>
        <span className="t-l2 c-alt">{conditions(c)}</span>
        <span className="t-c1 c-alt">
          {c.state === "used" && c.usedAt
            ? `${md(c.usedAt)} 사용`
            : c.state === "expired"
              ? `${md(c.expiresAt)} 기간 지남`
              : c.state === "upcoming"
                ? `${md(c.startsAt)}부터 쓸 수 있어요`
                : `${md(c.expiresAt)}까지 · ${left}일 남았어요`}
        </span>
      </div>
      <div className="cb-side">
        {c.state === "used" ? (
          <span className="cb-tag">사용함</span>
        ) : c.state === "expired" ? (
          <span className="cb-tag">기간 지남</span>
        ) : c.state === "usable" && left <= 3 ? (
          <span className="cb-tag is-soon">곧 끝나요</span>
        ) : null}
      </div>
    </li>
  );
}

async function call<T>(path: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; status: number; message?: string }> {
  try {
    const res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, data: data as T };
    return { ok: false, status: res.status, message: (data as { message?: string }).message };
  } catch {
    return { ok: false, status: 0 };
  }
}

export default function CouponBox({ slug }: { slug: string }) {
  const base = `/api/shop/${encodeURIComponent(slug)}/coupons`;
  const [view, setView] = useState<{ kind: "loading" } | { kind: "login" } | { kind: "error" } | { kind: "ok"; box: Box }>({ kind: "loading" });
  const [tab, setTab] = useState<Tab>("usable");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // 받을 수 있는 쿠폰을 몇 개까지 볼지(「더 보기」로 50개씩)
  const [limit, setLimit] = useState(PAGE);

  const load = useCallback(async () => {
    const r = await call<Box>(`${base}?claimable=${limit}`);
    if (r.ok) return setView({ kind: "ok", box: r.data });
    setView(r.status === 401 || r.status === 404 ? { kind: "login" } : { kind: "error" });
  }, [base, limit]);

  useEffect(() => {
    void load();
  }, [load]);

  const take = async (key: string, path: string, body: unknown) => {
    if (busy) return;
    setBusy(key);
    setMsg(null);
    const r = await call(path, body);
    setBusy(null);
    if (r.ok) {
      setMsg({ ok: true, text: "쿠폰을 받았어요 · 주문서에서 바로 쓸 수 있어요" });
      setCode("");
      setTab("usable");
      return load();
    }
    if (r.status === 401) return setView({ kind: "login" });
    setMsg({ ok: false, text: r.message ?? "쿠폰을 받지 못했어요. 잠시 뒤 다시 해 주세요" });
    if (r.status === 404 || r.status === 409) void load();
  };

  if (view.kind === "loading") {
    return (
      <section className="card shop-card" aria-busy="true">
        <span className="t-l1 c-alt">쿠폰함을 불러오고 있어요</span>
      </section>
    );
  }
  if (view.kind === "login") return <ShopState title="로그인이 필요해요" body="이 쇼핑몰에 로그인하면 쿠폰함을 볼 수 있어요." />;
  if (view.kind === "error") {
    return (
      <section className="card shop-card col" style={{ gap: 12 }}>
        <span className="t-l1">쿠폰함을 불러오지 못했어요</span>
        <button className="btn btn-sm" type="button" style={{ alignSelf: "flex-start" }} onClick={() => void load()}>
          다시 시도
        </button>
      </section>
    );
  }

  const { box } = view;
  const now = new Date(box.now).getTime();
  return (
    <section className="card shop-card col cb" aria-labelledby="cb-title">
      <h1 id="cb-title" className="t-h1">
        내 쿠폰함
      </h1>
      {box.shopOpen && (
        <form
          className="col"
          style={{ gap: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) void take("code", `${base}/code`, { code });
          }}
        >
          <label className="t-l2 fw6" htmlFor="cb-code">
            쿠폰 코드
          </label>
          <div className="cb-code">
            <input id="cb-code" className="inp" value={code} maxLength={16} autoComplete="off" placeholder="코드를 입력해 주세요" onChange={(e) => setCode(e.target.value)} />
            <button className="btn" type="submit" disabled={!code.trim() || busy !== null}>
              등록
            </button>
          </div>
          <span className="t-c1 c-alt">방송 채팅 · 문자로 받은 코드를 넣으면 쿠폰함에 들어와요</span>
        </form>
      )}
      {msg && (
        <p className={`msg ${msg.ok ? "msg-pos" : "msg-neg"} t-l2`} role={msg.ok ? "status" : "alert"}>
          {msg.text}
        </p>
      )}
      <div className="tabs" role="tablist">
        {(
          [
            ["usable", "쓸 수 있어요", box.usable.length],
            ["claimable", "받을 수 있어요", box.claimable.length],
            ["past", "지난 쿠폰", null],
          ] as const
        ).map(([k, label, n]) => (
          <button key={k} className={`tab${tab === k ? " on" : ""}`} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {label}
            {n !== null && <span className="cnt">{n}</span>}
          </button>
        ))}
      </div>
      {tab === "usable" &&
        (box.usable.length === 0 ? (
          <div className="cb-empty col" style={{ gap: 4 }}>
            <span className="t-b2 fw6">쓸 수 있는 쿠폰이 없어요</span>
            <span className="t-l2 c-alt">방송 중 채팅 코드나 받을 수 있는 쿠폰으로 혜택을 받아 보세요</span>
          </div>
        ) : (
          <>
            <ul className="cb-list">
              {box.usable.map((c) => (
                <MineItem key={c.couponId} c={c} now={now} />
              ))}
            </ul>
            <span className="t-c1 c-alt">주문서에서 쿠폰을 고르면 바로 할인돼요. 주문당 1장만 쓸 수 있어요.</span>
          </>
        ))}
      {tab === "claimable" &&
        (box.claimable.length === 0 ? (
          <div className="cb-empty">
            <span className="t-b2 fw6">지금 받을 수 있는 쿠폰이 없어요</span>
          </div>
        ) : (
          <ul className="cb-list">
            {box.claimable.map((c) => (
              <li key={c.couponId} className="cb-item">
                <div className="cb-amt">
                  <span className="t-h2 fw7">{amountText(c)}</span>
                </div>
                <div className="cb-body">
                  <span className="t-b2 fw6">{c.name}</span>
                  <span className="t-l2 c-alt">{conditions(c)}</span>
                  <span className="t-c1 c-alt">{c.validDays ? `받은 날부터 ${c.validDays}일` : `${md(c.endsAt)}까지`}</span>
                </div>
                <div className="cb-side">
                  <button className="btn btn-sm" type="button" disabled={busy !== null} onClick={() => void take(c.couponId, `${base}/${c.couponId}/download`, {})}>
                    {busy === c.couponId ? "받는 중" : "받기"}
                  </button>
                </div>
              </li>
            ))}
            {box.claimableMore && (
              <li>
                <button className="btn btn-out btn-block" type="button" onClick={() => setLimit((n) => n + PAGE)}>
                  더 보기
                </button>
              </li>
            )}
          </ul>
        ))}
      {tab === "past" &&
        (box.past.length === 0 ? (
          <div className="cb-empty">
            <span className="t-b2 fw6">지난 쿠폰이 없어요</span>
          </div>
        ) : (
          <ul className="cb-list">
            {box.past.map((c) => (
              <MineItem key={c.couponId} c={c} now={now} />
            ))}
          </ul>
        ))}
    </section>
  );
}
