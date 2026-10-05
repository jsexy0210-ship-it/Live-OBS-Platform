"use client";

import { useEffect, useState } from "react";

// 상품 상세 맨 위 「이 상품이 지금 방송 중이에요」 줄(보드 SH-003-IA). 「방송 보기」는 방송 연결 주소(/live의 watchUrl)가 있을 때만.
// 「방송에서 n명이 주문을 기다려요」는 서버 값이 없어 넣지 않는다.
export default function LiveNotice({ slug }: { slug: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/shop/${encodeURIComponent(slug)}/live`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { watchUrl?: string | null } | null) => live && setUrl(d?.watchUrl ?? null))
      .catch(() => null);
    return () => {
      live = false;
    };
  }, [slug]);
  return (
    <div className="pd-livebar" role="status">
      <span className="live-dot" aria-hidden="true" />
      <b>LIVE</b>
      <span className="pd-livebar-t">이 상품이 지금 방송 중이에요</span>
      {url && (
        <a className="btn btn-sm" href={url} target="_blank" rel="noopener noreferrer">
          방송 보기
        </a>
      )}
    </div>
  );
}
