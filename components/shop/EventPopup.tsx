"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import "./EventPopup.css";

// 쇼핑몰 이벤트 팝업(SH-001 「이벤트 팝업 · 가운데」「상단 띠 팝업」, 관리 SA-065). 서버가 기간·대상 화면으로 고른 팝업을 받아,
// 기기(768px 이상 PC, 그 아래 모바일)와 「보지 않기」(이 브라우저에 저장, KST 날짜 기준)로 한 번 더 고른다.
// - 이미지·글 팝업: 화면 가운데에 목록 순서대로 하나씩 띄운다.
// - 상단 띠: 쇼핑몰 머리 아래 한 줄로 첫 번째 것만 보인다. ×를 누르면 「보지 않기」 기간만큼 숨긴다.
type Img = { url: string; width: number; height: number };
export type EventPopupItem = {
  id: string;
  kind: "IMAGE" | "TEXT" | "BAR";
  title: string;
  body: string | null;
  image: Img | null;
  link: { href: string; external: boolean } | null;
  linkLabel: string | null;
  showOnPc: boolean;
  showOnMobile: boolean;
  // 0=닫기만(매번 표시), 1=오늘 하루, 7=7일
  dismissDays: number;
  version: string;
};

const PC_QUERY = "(min-width: 768px)";
const DAY = 86_400_000;
const hideKey = (p: EventPopupItem) => `onq.popup.hide.${p.id}.${p.version}`;
// KST 날짜(YYYY-MM-DD). 더하는 날 수만큼 뒤 날짜.
const kstDate = (plusDays = 0) => new Date(Date.now() + 9 * 3600_000 + plusDays * DAY).toISOString().slice(0, 10);
const dismissLabel = (days: number) => (days === 7 ? "7일 동안 보지 않기" : "오늘 하루 보지 않기");

// 저장한 값은 숨김이 끝나는 KST 날짜(그날까지 숨김)
function dismissed(p: EventPopupItem): boolean {
  if (p.dismissDays === 0) return false;
  try {
    const until = window.localStorage.getItem(hideKey(p));
    return !!until && kstDate() <= until;
  } catch {
    return false;
  }
}

function remember(p: EventPopupItem) {
  if (p.dismissDays === 0) return;
  try {
    window.localStorage.setItem(hideKey(p), kstDate(p.dismissDays - 1));
  } catch {
    // 저장할 수 없는 브라우저(사생활 보호 모드 등)는 이번만 닫는다
  }
}

const linkAttrs = (l: { external: boolean }) => (l.external ? { target: "_blank", rel: "noopener noreferrer" } : {});

export default function EventPopup({ popups }: { popups: EventPopupItem[] }) {
  // 처음 그릴 때는 비워 두고(서버 렌더와 맞춤) 브라우저에서 고른다
  const [queue, setQueue] = useState<EventPopupItem[]>([]);
  const [bar, setBar] = useState<EventPopupItem | null>(null);
  const [hide, setHide] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const pc = typeof window.matchMedia === "function" ? window.matchMedia(PC_QUERY).matches : true;
    const shown = popups.filter((p) => (pc ? p.showOnPc : p.showOnMobile) && !dismissed(p));
    setQueue(shown.filter((p) => p.kind !== "BAR"));
    setBar(shown.find((p) => p.kind === "BAR") ?? null);
  }, [popups]);

  const current = queue[0];

  useEffect(() => {
    if (!current) return;
    setHide(false);
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setQueue((q) => q.slice(1));
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current?.id]);

  const close = () => {
    if (!current) return;
    if (hide) remember(current);
    setQueue((q) => q.slice(1));
  };

  return (
    <>
      {bar && (
        <div className="ep-bar" role="region" aria-label="알림">
          {bar.link ? (
            <a className="t-l2 fw6 ep-bar-text" href={bar.link.href} {...linkAttrs(bar.link)}>
              {bar.title}
            </a>
          ) : (
            <span className="t-l2 fw6 ep-bar-text">{bar.title}</span>
          )}
          <button
            className="ep-bar-x"
            type="button"
            aria-label={bar.dismissDays === 0 ? "닫기" : `닫기 · ${dismissLabel(bar.dismissDays)}`}
            onClick={() => {
              remember(bar);
              setBar(null);
            }}
          >
            ×
          </button>
        </div>
      )}
      {current && (
        <div className="ep-dim" onClick={(e) => e.target === e.currentTarget && setQueue((q) => q.slice(1))}>
          <div className="ep" role="dialog" aria-modal="true" aria-labelledby={`ep-t-${current.id}`}>
            {current.kind === "IMAGE" &&
              current.image &&
              (current.link ? (
                <a href={current.link.href} {...linkAttrs(current.link)}>
                  <img className="ep-img" src={current.image.url} width={current.image.width} height={current.image.height} alt={current.title} />
                </a>
              ) : (
                <img className="ep-img" src={current.image.url} width={current.image.width} height={current.image.height} alt={current.title} />
              ))}
            <div className="ep-body">
              <h2 className={current.kind === "IMAGE" ? "sr" : "t-hl2"} id={`ep-t-${current.id}`}>
                {current.title}
              </h2>
              {current.body && <p className="t-l2 c-alt ep-text">{current.body}</p>}
              {current.link && (
                <a className="btn btn-block" href={current.link.href} {...linkAttrs(current.link)}>
                  {current.linkLabel}
                </a>
              )}
            </div>
            <div className="ep-foot t-c1">
              {current.dismissDays > 0 ? (
                <label className="row ep-hide">
                  <input className="cbx" type="checkbox" checked={hide} onChange={(e) => setHide(e.target.checked)} />
                  {dismissLabel(current.dismissDays)}
                </label>
              ) : (
                <span />
              )}
              <button ref={closeRef} className="btn btn-sm btn-ghost" type="button" onClick={close}>
                닫기
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// 홈이 아닌 구매자 화면(ShopFrame)에서 「모든 화면」 대상 팝업을 불러와 띄운다. 홈은 서버에서 받은 값으로 따로 그린다.
export function EventPopupForPage() {
  const pathname = usePathname() ?? "";
  const m = pathname.match(/^\/shop\/([^/]+)(\/.*)?$/);
  const slug = m?.[1];
  const isHome = !!m && (!m[2] || m[2] === "/");
  const [popups, setPopups] = useState<EventPopupItem[]>([]);
  useEffect(() => {
    if (!slug || isHome) return;
    let alive = true;
    fetch(`/api/shop/${slug}/shop-content?page=other`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { popups?: EventPopupItem[] } | null) => alive && d?.popups && setPopups(d.popups))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [slug, isHome]);
  return popups.length > 0 ? <EventPopup popups={popups} /> : null;
}
