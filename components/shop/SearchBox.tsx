"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { call } from "./reviewShared";

// IA ⑥ 검색: 검색 화면의 입력(자동완성), 최근 검색어(이 기기), 인기 검색어(서버).
// 자동완성 GET /search/suggest?q → { suggestions: [{ text, kind }] } 최대 8개(1~20자만). 인기 검색어 GET /search/popular → { terms }.
type Suggestion = { text: string; kind: "term" | "product" | "tag" };
const KIND: Record<Suggestion["kind"], string> = { term: "인기", product: "상품", tag: "태그" };
const RECENT_MAX = 10;

const recentKey = (slug: string) => `shop-recent-search:${slug}`;
function readRecent(slug: string): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(recentKey(slug)) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}
function writeRecent(slug: string, list: string[]) {
  try {
    window.localStorage.setItem(recentKey(slug), JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    // 저장하지 못해도 검색은 된다
  }
}

export default function SearchBox({ slug, q, path }: { slug: string; q: string; path: string }) {
  const api = `/api/shop/${encodeURIComponent(slug)}/search`;
  const listId = useId();
  const [value, setValue] = useState(q);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [recent, setRecent] = useState<string[]>([]);
  const [popular, setPopular] = useState<string[]>([]);
  const seq = useRef(0);

  // 검색한 단어를 최근 검색어로 남긴다(맨 앞, 중복 없음)
  useEffect(() => {
    const cur = readRecent(slug);
    if (q) {
      const next = [q, ...cur.filter((x) => x !== q)];
      writeRecent(slug, next);
      setRecent(next.slice(0, RECENT_MAX));
    } else setRecent(cur);
  }, [slug, q]);
  useEffect(() => {
    if (q) return;
    let live = true;
    call<{ terms: string[] }>(`${api}/popular`).then((r) => live && r.ok && setPopular(r.data.terms));
    return () => {
      live = false;
    };
  }, [api, q]);

  useEffect(() => {
    const t = value.trim();
    if (!open || t.length < 1 || t.length > 20) return setItems([]);
    const mine = ++seq.current;
    const timer = window.setTimeout(async () => {
      const r = await call<{ suggestions: Suggestion[] }>(`${api}/suggest?q=${encodeURIComponent(t)}`);
      if (mine === seq.current) {
        setItems(r.ok ? r.data.suggestions : []);
        setActive(-1);
      }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [api, value, open]);

  function go(term: string) {
    window.location.assign(`${path}?q=${encodeURIComponent(term)}`);
  }
  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") return setOpen(false);
    if (!open || items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a <= 0 ? items.length - 1 : a - 1));
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      go(items[active].text);
    }
  }
  function removeRecent(term: string) {
    const next = recent.filter((x) => x !== term);
    setRecent(next);
    writeRecent(slug, next);
  }
  function clearRecent() {
    setRecent([]);
    writeRecent(slug, []);
  }

  return (
    <>
      <form className="shop-searchbox" role="search" action={path}>
        <div className="shop-sb-field">
          <input
            className="inp"
            type="search"
            name="q"
            value={value}
            maxLength={50}
            placeholder="상품 이름으로 찾아보세요"
            aria-label="검색어"
            role="combobox"
            aria-expanded={open && items.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
            autoComplete="off"
            onChange={(e) => {
              setValue(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => window.setTimeout(() => setOpen(false), 150)}
            onKeyDown={onKey}
          />
          {open && items.length > 0 && (
            <ul id={listId} className="shop-sb-list" role="listbox" aria-label="검색어 추천">
              {items.map((s, i) => (
                <li key={`${s.kind}:${s.text}`} id={`${listId}-${i}`} role="option" aria-selected={i === active}>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => go(s.text)}>
                    <span>{s.text}</span>
                    <em>{KIND[s.kind]}</em>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button type="submit" className="btn">
          검색
        </button>
      </form>
      {!q && (recent.length > 0 || popular.length > 0) && (
        <div className="shop-sb-help">
          {recent.length > 0 && (
            <section aria-labelledby="sb-recent">
              <h2 id="sb-recent">
                최근 검색어
                <button type="button" className="shop-linkbtn" onClick={clearRecent}>
                  전체 삭제
                </button>
              </h2>
              <ul className="shop-sb-chips">
                {recent.map((t) => (
                  <li key={t}>
                    <Link href={`${path}?q=${encodeURIComponent(t)}`}>{t}</Link>
                    <button type="button" aria-label={`${t} 삭제`} onClick={() => removeRecent(t)}>
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {popular.length > 0 && (
            <section aria-labelledby="sb-popular">
              <h2 id="sb-popular">인기 검색어</h2>
              <ol className="shop-sb-pop">
                {popular.map((t, i) => (
                  <li key={t}>
                    <Link href={`${path}?q=${encodeURIComponent(t)}`}>
                      <i>{i + 1}</i>
                      {t}
                    </Link>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      )}
    </>
  );
}
