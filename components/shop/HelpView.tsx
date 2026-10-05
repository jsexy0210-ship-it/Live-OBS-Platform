"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { kstDate } from "./kstDate";
import { call } from "./reviewShared";
import "./Cart.css";
import "./Help.css";

// SH-030 고객센터(시안 04 SH): 공지 목록 · 자주 묻는 질문. 이용안내 탭은 API가 없어 뺐다. 공지·FAQ API는 로그인 없이 읽는다.
type Notice = { id: string; title: string; isPinned: boolean; createdAt: string };
type Faq = { id: string; category: string; title: string; body: string };
type Tab = "notice" | "faq";

function Notices({ slug }: { slug: string }) {
  const base = `/shop/${encodeURIComponent(slug)}`;
  const api = `/api/shop/${encodeURIComponent(slug)}/notices`;
  const [items, setItems] = useState<Notice[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (next?: string | null) => {
      setBusy(true);
      const r = await call<{ notices: Notice[]; nextCursor: string | null }>(next ? `${api}?cursor=${encodeURIComponent(next)}` : api);
      if (!r.ok) setError(true);
      else {
        setError(false);
        setItems((prev) => (next && prev ? [...prev, ...r.data.notices] : r.data.notices));
        setCursor(r.data.nextCursor);
      }
      setBusy(false);
    },
    [api],
  );
  useEffect(() => void load(), [load]);

  if (error)
    return (
      <div className="cart-empty">
        <p>공지를 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요.</p>
        <button className="btn" type="button" onClick={() => void load()}>
          다시 불러오기
        </button>
      </div>
    );
  if (items === null)
    return (
      <p className="shop-empty" aria-busy="true">
        공지를 불러오고 있어요
      </p>
    );
  if (items.length === 0)
    return (
      <div className="cart-empty">
        <h2>아직 공지가 없어요</h2>
        <p>판매자가 공지를 올리면 여기에 보여요.</p>
      </div>
    );
  return (
    <>
      <table className="cart-tbl help-tbl">
        <thead>
          <tr>
            <th>제목</th>
            <th className="c-date">날짜</th>
          </tr>
        </thead>
        <tbody>
          {items.map((n) => (
            <tr key={n.id}>
              <td>
                {n.isPinned && <span className="help-tag">고정</span>}
                <Link href={`${base}/help/notices/${n.id}`}>{n.title}</Link>
              </td>
              <td className="c-date">{kstDate(n.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {cursor && (
        <div className="cart-tools">
          <button className="btn btn-sm btn-out" type="button" disabled={busy} onClick={() => void load(cursor)}>
            더 보기
          </button>
        </div>
      )}
    </>
  );
}

function Faqs({ slug }: { slug: string }) {
  const api = `/api/shop/${encodeURIComponent(slug)}/faqs`;
  const [faqs, setFaqs] = useState<Faq[] | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [category, setCategory] = useState("");
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [error, setError] = useState(false);
  const [tooShort, setTooShort] = useState(false);

  const load = useCallback(
    async (query: string) => {
      const r = await call<{ faqs: Faq[]; categories: string[] }>(query ? `${api}?q=${encodeURIComponent(query)}` : api);
      if (!r.ok) return setError(true);
      setError(false);
      setFaqs(r.data.faqs);
      if (!query) setCategories(r.data.categories);
    },
    [api],
  );
  useEffect(() => void load(q), [load, q]);

  const shown = (faqs ?? []).filter((f) => !category || f.category === category);
  return (
    <>
      <form
        className="help-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const v = input.trim();
          setTooShort(v.length === 1);
          if (v.length !== 1) setQ(v);
        }}
      >
        <input className="inp" type="search" value={input} onChange={(e) => setInput(e.target.value)} placeholder="궁금한 내용을 검색해요" aria-label="자주 묻는 질문 검색" maxLength={50} />
        <button className="btn" type="submit">
          검색
        </button>
      </form>
      {tooShort && <p className="help-hint">두 글자 이상 적어 주세요</p>}
      {categories.length > 0 && (
        <div className="help-chips" role="group" aria-label="분류">
          {["", ...categories].map((c) => (
            <button key={c || "all"} type="button" className="help-chip" aria-pressed={category === c} onClick={() => setCategory(c)}>
              {c || "전체"}
            </button>
          ))}
        </div>
      )}
      {error ? (
        <div className="cart-empty">
          <p>자주 묻는 질문을 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요.</p>
          <button className="btn" type="button" onClick={() => void load(q)}>
            다시 불러오기
          </button>
        </div>
      ) : faqs === null ? (
        <p className="shop-empty" aria-busy="true">
          불러오고 있어요
        </p>
      ) : shown.length === 0 ? (
        <div className="cart-empty">
          <h2>{q ? "맞는 질문이 없어요" : "아직 자주 묻는 질문이 없어요"}</h2>
          <p>{q ? "다른 말로 검색해 보세요." : "판매자가 질문을 올리면 여기에 보여요."}</p>
        </div>
      ) : (
        <div className="help-faqs">
          {shown.map((f) => (
            <details key={f.id} className="help-faq">
              <summary>
                <span className="help-tag">{f.category}</span>
                {f.title}
              </summary>
              <p>{f.body}</p>
            </details>
          ))}
        </div>
      )}
    </>
  );
}

export default function HelpView({ slug }: { slug: string }) {
  const [tab, setTab] = useState<Tab>("notice");
  return (
    <div className="shop-wrap cart-wrap">
      <div className="cart-head">
        <h1>고객센터</h1>
      </div>
      <div className="help-tabs" role="tablist" aria-label="고객센터">
        {(["notice", "faq"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === "notice" ? "공지" : "자주 묻는 질문"}
          </button>
        ))}
      </div>
      <div role="tabpanel">{tab === "notice" ? <Notices slug={slug} /> : <Faqs slug={slug} />}</div>
    </div>
  );
}
