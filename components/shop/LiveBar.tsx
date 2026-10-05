"use client";

import { useEffect, useState } from "react";

// IA ① LIVE 전면: 방송 중이면 쇼핑몰 맨 위에 「지금 라이브 방송 중이에요 [방송 보기]」 띠를 둔다.
// GET /api/shop/{slug}/live → { live, title, startedAt, watchUrl }. watchUrl이 없으면(유튜브 연결이 진행 중이 아님) 「방송 보기」는 숨긴다.
// 레이아웃이 화면을 옮겨도 다시 그려지지 않으므로 30초마다 다시 확인한다(탭이 보일 때만).
type Live = { live: boolean; title: string | null; watchUrl: string | null };

export default function LiveBar({ slug }: { slug: string }) {
  const [s, setS] = useState<Live | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const r = await fetch(`/api/shop/${encodeURIComponent(slug)}/live`, { cache: "no-store" }); // 브라우저 캐시를 쓰지 않는다(서버·CDN이 15초 캐시)
        const d = r.ok ? ((await r.json()) as Live) : null;
        if (alive) setS(d && d.live ? d : null);
      } catch {
        // 끊겨도 띠만 안 보일 뿐이다
      }
    };
    void load();
    const t = window.setInterval(load, 30_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      alive = false;
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", load);
    };
  }, [slug]);
  if (!s) return null;
  return (
    <div className="live-bar" role="status">
      <div className="shop-wrap live-bar-in">
        <span className="live-dot" aria-hidden="true" />
        <b>LIVE</b>
        <span className="live-text">지금 라이브 방송 중이에요{s.title ? ` · ${s.title}` : ""}</span>
        {s.watchUrl && (
          <a className="live-go" href={s.watchUrl} target="_blank" rel="noopener noreferrer">
            방송 보기
          </a>
        )}
      </div>
    </div>
  );
}
