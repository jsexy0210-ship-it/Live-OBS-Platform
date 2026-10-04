"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import "./EventPopup.css";

// 쇼핑몰 이벤트 팝업(SH-001 「이벤트 팝업 · 가운데」). 서버가 기간·대상 화면으로 고른 팝업을 받아,
// 기기(768px 이상 PC, 그 아래 모바일)와 「오늘 하루 보지 않기」(이 브라우저에 저장, KST 날짜 기준)로 한 번 더 고른 뒤 순서대로 하나씩 띄운다.
type Img = { url: string; width: number; height: number };
export type EventPopupItem = {
  id: string;
  title: string;
  body: string | null;
  image: Img | null;
  link: { href: string; external: boolean } | null;
  linkLabel: string | null;
  showOnPc: boolean;
  showOnMobile: boolean;
  allowHideToday: boolean;
  version: string;
};

const PC_QUERY = "(min-width: 768px)";
const hideKey = (p: EventPopupItem) => `onq.popup.hide.${p.id}.${p.version}`;
// KST 오늘 날짜(YYYY-MM-DD)
const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

function hiddenToday(p: EventPopupItem): boolean {
  try {
    return p.allowHideToday && window.localStorage.getItem(hideKey(p)) === kstToday();
  } catch {
    return false;
  }
}

export default function EventPopup({ popups }: { popups: EventPopupItem[] }) {
  // 처음 그릴 때는 비워 두고(서버 렌더와 맞춤) 브라우저에서 고른다
  const [queue, setQueue] = useState<EventPopupItem[]>([]);
  const [hideToday, setHideToday] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const pc = typeof window.matchMedia === "function" ? window.matchMedia(PC_QUERY).matches : true;
    setQueue(popups.filter((p) => (pc ? p.showOnPc : p.showOnMobile) && !hiddenToday(p)));
  }, [popups]);

  const current = queue[0];

  useEffect(() => {
    if (!current) return;
    setHideToday(false);
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current?.id]);

  function close(remember: boolean) {
    if (!current) return;
    if (remember && current.allowHideToday) {
      try {
        window.localStorage.setItem(hideKey(current), kstToday());
      } catch {
        // 저장할 수 없는 브라우저(사생활 보호 모드 등)는 이번만 닫는다
      }
    }
    setQueue((q) => q.slice(1));
  }

  if (!current) return null;
  return (
    <div className="ep-dim" onClick={(e) => e.target === e.currentTarget && close(false)}>
      <div className="ep" role="dialog" aria-modal="true" aria-labelledby={`ep-t-${current.id}`}>
        {current.image &&
          (current.link ? (
            <a href={current.link.href} {...(current.link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
              <img className="ep-img" src={current.image.url} width={current.image.width} height={current.image.height} alt="" />
            </a>
          ) : (
            <img className="ep-img" src={current.image.url} width={current.image.width} height={current.image.height} alt="" />
          ))}
        <div className="ep-body">
          <h2 className="t-l1 fw7" id={`ep-t-${current.id}`}>
            {current.title}
          </h2>
          {current.body && <p className="t-l2 c-alt ep-text">{current.body}</p>}
          {current.link && (
            <a className="btn btn-block" href={current.link.href} {...(current.link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
              {current.linkLabel}
            </a>
          )}
        </div>
        <div className="ep-foot t-c1">
          {current.allowHideToday ? (
            <label className="row ep-hide">
              <input className="cbx" type="checkbox" checked={hideToday} onChange={(e) => setHideToday(e.target.checked)} />
              오늘 하루 보지 않기
            </label>
          ) : (
            <span />
          )}
          <button ref={closeRef} className="btn btn-sm btn-ghost" type="button" onClick={() => close(hideToday)}>
            닫기
          </button>
        </div>
      </div>
    </div>
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
