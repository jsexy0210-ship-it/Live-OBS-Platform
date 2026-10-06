"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import MyMenu from "./MyMenu";
import ShopState from "./ShopState";
import "./Cart.css";
import "./CouponBox.css";
import "./MyMenu.css";

// 내 정보 공통 틀: 제목 + PC 왼쪽 메뉴(찜과 같은 구성, 보드 SH-028-IA)
function Frame({ slug, children }: { slug: string; children: React.ReactNode }) {
  return (
    <div className="shop-wrap cart-wrap">
      <div className="cart-head">
        <h1>내 쿠폰함</h1>
      </div>
      <div className="my-wrap">
        <MyMenu slug={slug} />
        <div>{children}</div>
      </div>
    </div>
  );
}

// SH-028 내 쿠폰함(보드 v287). 탭 2(쓸 수 있는 쿠폰 · 사용 · 만료) → 목록 → 쿠폰 번호 입력·등록 → 안내 띠. 쿠폰 받기는 상품 상세 CouponRow.
// 쿠폰은 주문서에서 고르면 서버가 할인 금액을 계산한다(주문당 1장). API: /api/shop/{slug}/coupons.
export type CouponView = {
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
type Mine = CouponView & { issuedAt: string; expiresAt: string; usedAt: string | null; state: "usable" | "upcoming" | "used" | "expired" };
type Box = { usable: Mine[]; claimable: CouponView[]; claimableMore: boolean; past: Mine[]; now: string; shopOpen: boolean };
type Tab = "usable" | "past";

const DAY = 86_400_000;
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
export const couponDate = (iso: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric" }).format(new Date(iso)).replace(/\.\s?/g, "/").replace(/\/$/, "");
export const couponAmountText = (c: CouponView) => (c.benefit === "FREE_SHIPPING" ? "배송비 무료" : c.benefit === "AMOUNT" ? won(c.value ?? 0) : `${c.value}%`);

export function couponConditions(c: CouponView): string {
  const parts: string[] = [];
  if (c.benefit === "RATE" && c.maxDiscount) parts.push(`최대 ${won(c.maxDiscount)} 할인`);
  parts.push(c.minOrderAmount > 0 ? `${won(c.minOrderAmount)} 이상 주문` : "금액 조건 없음");
  if (c.productScoped) parts.push("일부 상품만");
  if (c.excludeDiscounted) parts.push("할인 중 상품 제외");
  return parts.join(" · ");
}

function MineItem({ c, now, slug }: { c: Mine; now: number; slug: string }) {
  const left = Math.ceil((new Date(c.expiresAt).getTime() - now) / DAY);
  const past = c.state === "used" || c.state === "expired";
  return (
    <li className={`cb-item${past ? " is-past" : ""}`}>
      <div className="cb-amt">
        <span className="t-h2 fw7">{couponAmountText(c)}</span>
      </div>
      <div className="cb-body">
        <span className="t-b2 fw6">{c.name}</span>
        <span className="t-l2 c-alt">{couponConditions(c)}</span>
        <span className="t-c1 c-alt">
          {c.state === "used" && c.usedAt
            ? `${couponDate(c.usedAt)} 사용`
            : c.state === "expired"
              ? `${couponDate(c.expiresAt)} 기간 지남`
              : c.state === "upcoming"
                ? `${couponDate(c.startsAt)}부터 쓸 수 있어요`
                : `${couponDate(c.expiresAt)}까지 · ${left}일 남았어요`}
        </span>
      </div>
      <div className="cb-side">
        {c.state === "used" ? (
          <span className="cb-tag">사용함</span>
        ) : c.state === "expired" ? (
          <span className="cb-tag">기간 지남</span>
        ) : c.state === "usable" ? (
          <>
            {left <= 3 && <span className="cb-tag is-soon">곧 끝나요</span>}
            <Link className="btn btn-sm btn-out" href={`/shop/${encodeURIComponent(slug)}/products`}>
              쓰러 가기
            </Link>
          </>
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

  const load = useCallback(async () => {
    const r = await call<Box>(`${base}?claimable=1`);
    if (r.ok) return setView({ kind: "ok", box: r.data });
    setView(r.status === 401 || r.status === 404 ? { kind: "login" } : { kind: "error" });
  }, [base]);

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
    setMsg({
      ok: false,
      text: key === "code" && (r.status === 400 || r.status === 404) ? "없는 쿠폰 번호예요 · 대소문자를 확인해 주세요" : (r.message ?? "쿠폰을 등록하지 못했어요. 잠시 뒤 다시 해 주세요"),
    });
    if (r.status === 404 || r.status === 409) void load();
  };

  if (view.kind === "loading") {
    return (
      <Frame slug={slug}>
        <section aria-busy="true">
          <span className="t-l1 c-alt">쿠폰함을 불러오고 있어요</span>
        </section>
      </Frame>
    );
  }
  if (view.kind === "login") return <ShopState title="로그인이 필요해요" body="이 쇼핑몰에 로그인하면 쿠폰함을 볼 수 있어요." />;
  if (view.kind === "error") {
    return (
      <Frame slug={slug}>
      <section className="col" style={{ gap: 12 }}>
        <span className="t-l1">쿠폰함을 불러오지 못했어요</span>
        <button className="btn btn-sm" type="button" style={{ alignSelf: "flex-start" }} onClick={() => void load()}>
          다시 불러오기
        </button>
      </section>
      </Frame>
    );
  }

  const { box } = view;
  const now = new Date(box.now).getTime();
  const list = tab === "usable" ? box.usable : box.past;
  return (
    <Frame slug={slug}>
      <section className="col cb">
        {!box.shopOpen && (
          <p className="msg msg-info t-l2" role="status">
            지금은 쿠폰 번호를 등록할 수 없어요. 받은 쿠폰은 여기서 볼 수 있어요
          </p>
        )}
        <div className="tabs" role="tablist">
          {(
            [
              ["usable", "쓸 수 있는 쿠폰", box.usable.length],
              ["past", "사용 · 만료", box.past.length],
            ] as const
          ).map(([k, label, n]) => (
            <button key={k} className={`tab${tab === k ? " on" : ""}`} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
              {label}
              <span className="cnt">{n}</span>
            </button>
          ))}
        </div>
        {list.length === 0 ? (
          <div className="cb-empty col" style={{ gap: 4 }}>
            <span className="t-b2 fw6">{tab === "usable" ? "쓸 수 있는 쿠폰이 없어요" : "사용하거나 만료된 쿠폰이 없어요"}</span>
            {tab === "usable" && <span className="t-l2 c-alt">등급이 오르거나 이벤트가 열리면 쿠폰을 드려요</span>}
          </div>
        ) : (
          <ul className="cb-list">
            {list.map((c) => (
              <MineItem key={c.couponId} c={c} now={now} slug={slug} />
            ))}
          </ul>
        )}
        {box.shopOpen && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim()) void take("code", `${base}/code`, { code });
            }}
          >
            <div className="cb-code">
              <input id="cb-code" className="inp" aria-label="쿠폰 번호 입력" value={code} maxLength={16} autoComplete="off" placeholder="쿠폰 번호 입력" onChange={(e) => setCode(e.target.value)} />
              <button className="btn" type="submit" disabled={!code.trim() || busy !== null}>
                등록
              </button>
            </div>
          </form>
        )}
        {msg && (
          <p className={`msg ${msg.ok ? "msg-pos" : "msg-neg"} t-l2`} role={msg.ok ? "status" : "alert"}>
            {msg.text}
          </p>
        )}
        <span className="t-c1 c-alt cb-note">쿠폰은 주문서에서 1장만 쓸 수 있어요 · 적립금과 함께 쓸 수 있어요 · 쿠폰 할인분은 적립 대상에서 빠져요</span>
      </section>
    </Frame>
  );
}
