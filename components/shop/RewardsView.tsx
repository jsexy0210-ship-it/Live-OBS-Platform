"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import MyMenu from "./MyMenu";
import ShopBack from "./ShopBack";
import { call, md } from "./reviewShared";
import "./Cart.css";
import "./Help.css";
import "./MyMenu.css";
import "./Rewards.css";

// SH-023 내 적립금(보드 SH-023-IA FINAL): 카드 3개(쓸 수 있는 적립금 · 적립 예정 · 곧 소멸) → 탭(전체 · 적립 · 사용 · 회수 · 소멸) → 표(날짜 · 내용 · 금액).
// API: GET /api/shop/{slug}/me/rewards { balance, pendingEarn, expiringSoon:{amount,expiresAt}|null, useEnabled } · GET /me/reward-ledger?type&cursor&limit(20) { items:[{id,at,type,text,productSummary,amount}], nextCursor }.
type Summary = { balance: number; pendingEarn: number; expiringSoon: { amount: number; expiresAt: string } | null; useEnabled: boolean };
type Entry = { id: string; at: string; type: "earn" | "use" | "clawback" | "expire"; text: string; productSummary: string | null; amount: number };
type Tab = "all" | "earn" | "use" | "clawback" | "expire";
const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "earn", label: "적립" },
  { key: "use", label: "사용" },
  { key: "clawback", label: "회수" },
  { key: "expire", label: "소멸" },
];
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${won(Math.abs(n))}`;
const kstMd = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`;
};

export default function RewardsView({ slug }: { slug: string }) {
  const base = `/shop/${encodeURIComponent(slug)}`;
  const api = `/api/shop/${encodeURIComponent(slug)}/me`;
  const [sum, setSum] = useState<{ kind: "loading" } | { kind: "login" } | { kind: "error" } | { kind: "ok"; s: Summary }>({ kind: "loading" });
  const [tab, setTab] = useState<Tab>("all");
  const [rows, setRows] = useState<{ items: Entry[]; next: string | null; state: "loading" | "ok" | "error" }>({ items: [], next: null, state: "loading" });
  const [more, setMore] = useState(false);

  const loadSummary = useCallback(async () => {
    const r = await call<Summary>(`${api}/rewards`);
    setSum(r.ok ? { kind: "ok", s: r.data } : { kind: r.status === 401 || r.status === 404 ? "login" : "error" });
  }, [api]);
  useEffect(() => void loadSummary(), [loadSummary]);

  const loadRows = useCallback(
    async (t: Tab) => {
      setRows({ items: [], next: null, state: "loading" });
      const r = await call<{ items: Entry[]; nextCursor: string | null }>(`${api}/reward-ledger?type=${t}`);
      setRows(r.ok ? { items: r.data.items, next: r.data.nextCursor, state: "ok" } : { items: [], next: null, state: "error" });
    },
    [api],
  );
  useEffect(() => void loadRows(tab), [loadRows, tab]);

  async function loadMore() {
    if (!rows.next || more) return;
    setMore(true);
    const r = await call<{ items: Entry[]; nextCursor: string | null }>(`${api}/reward-ledger?type=${tab}&cursor=${encodeURIComponent(rows.next)}`);
    setMore(false);
    if (r.ok) setRows((p) => ({ items: [...p.items, ...r.data.items], next: r.data.nextCursor, state: "ok" }));
  }

  let content: React.ReactNode;
  if (sum.kind === "loading")
    content = (
      <p className="shop-empty" aria-busy="true">
        적립금을 불러오고 있어요
      </p>
    );
  else if (sum.kind === "login")
    content = (
      <div className="cart-empty">
        <p>로그인하면 볼 수 있어요</p>
        <Link className="btn" href={`${base}/login?next=${encodeURIComponent(`${base}/me/rewards`)}`}>
          로그인
        </Link>
      </div>
    );
  else if (sum.kind === "error")
    content = (
      <div className="cart-empty">
        <p>불러오지 못했어요. 네트워크를 확인하고 다시 시도해 주세요.</p>
        <button className="btn" type="button" onClick={() => void loadSummary()}>
          다시 불러오기
        </button>
      </div>
    );
  else {
    const s = sum.s;
    content = (
      <>
        <div className="rw-cards">
          <div className="rw-card">
            <span>쓸 수 있는 적립금</span>
            <b>{won(s.balance)}</b>
            <small>이 쇼핑몰에서만 써요</small>
          </div>
          <div className="rw-card">
            <span>적립 예정</span>
            <b>{won(s.pendingEarn)}</b>
            <small>개봉 완료 뒤 들어와요</small>
          </div>
          <div className="rw-card">
            <span>곧 소멸</span>
            <b>{won(s.expiringSoon?.amount ?? 0)}</b>
            <small>{s.expiringSoon ? `${kstMd(s.expiringSoon.expiresAt).replace("월 ", "/").replace("일", "")}까지 쓰지 않으면 사라져요` : "소멸 예정인 적립금이 없어요"}</small>
          </div>
        </div>
        {s.expiringSoon && (
          <p className="msg msg-cau t-l2" style={{ display: "block" }}>
            <b>
              {won(s.expiringSoon.amount)}이 {kstMd(s.expiringSoon.expiresAt)}에 사라져요.
            </b>{" "}
            그 전에 주문에 써 보세요.
          </p>
        )}
        {!s.useEnabled && (
          <p className="msg msg-info t-l2" style={{ display: "block" }}>
            판매자가 적립금 지급을 아직 켜지 않았어요. 켜지면 쌓인 적립 예정분이 한 번에 들어와요
          </p>
        )}
        <div className="help-tabs rw-tabs" role="tablist" aria-label="적립금 내역 종류">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        {rows.state === "loading" ? (
          <p className="shop-empty" aria-busy="true">
            내역을 불러오고 있어요
          </p>
        ) : rows.state === "error" ? (
          <div className="cart-empty">
            <p>불러오지 못했어요. 네트워크를 확인하고 다시 시도해 주세요.</p>
            <button className="btn" type="button" onClick={() => void loadRows(tab)}>
              다시 불러오기
            </button>
          </div>
        ) : rows.items.length === 0 ? (
          <div className="cart-empty">
            <h2>{tab === "all" ? "아직 적립금이 없어요" : "내역이 없어요"}</h2>
            {tab === "all" && <p>주문한 상품이 개봉되면 적립금이 쌓여요</p>}
          </div>
        ) : (
          <>
            <table className="cart-tbl rw-tbl">
              <thead>
                <tr>
                  <th className="c-d">날짜</th>
                  <th>내용</th>
                  <th className="c-a">금액</th>
                </tr>
              </thead>
              <tbody>
                {rows.items.map((e) => (
                  <tr key={e.id}>
                    <td className="c-d">{md(e.at)}</td>
                    <td>
                      <b>{e.text}</b>
                      {e.productSummary && <span className="rw-sub">{e.productSummary}</span>}
                    </td>
                    <td className={`c-a${e.amount > 0 ? " is-plus" : ""}`}>
                      <b>{signed(e.amount)}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.next && (
              <button className="btn btn-sm btn-out rw-more" type="button" disabled={more} onClick={() => void loadMore()}>
                더 보기
              </button>
            )}
          </>
        )}
      </>
    );
  }

  return (
    <div className="shop-wrap cart-wrap">
      <ShopBack fallback={`${base}/me`} label="내 정보" />
      <div className="cart-head">
        <h1>내 적립금</h1>
      </div>
      <div className="my-wrap">
        <MyMenu slug={slug} />
        <div className="rw-main">{content}</div>
      </div>
    </div>
  );
}
