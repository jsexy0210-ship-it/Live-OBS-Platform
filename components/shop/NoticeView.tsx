"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { kstDate } from "./kstDate";
import { call } from "./reviewShared";
import "./Cart.css";
import "./Help.css";

// 공지 상세. 본문은 글자 그대로 그린다(HTML 아님, 줄바꿈 유지).
type Notice = { id: string; title: string; body: string; isPinned: boolean; createdAt: string };
type View = { kind: "loading" } | { kind: "missing" } | { kind: "error" } | { kind: "ok"; notice: Notice };

export default function NoticeView({ slug, noticeId }: { slug: string; noticeId: string }) {
  const base = `/shop/${encodeURIComponent(slug)}`;
  const [view, setView] = useState<View>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    call<{ notice: Notice }>(`/api/shop/${encodeURIComponent(slug)}/notices/${encodeURIComponent(noticeId)}`).then((r) => {
      if (live) setView(r.ok ? { kind: "ok", notice: r.data.notice } : { kind: r.status === 404 ? "missing" : "error" });
    });
    return () => {
      live = false;
    };
  }, [slug, noticeId]);

  return (
    <div className="shop-wrap cart-wrap">
      <div className="cart-head">
        <h1>공지</h1>
      </div>
      {view.kind === "loading" ? (
        <p className="shop-empty" aria-busy="true">
          공지를 불러오고 있어요
        </p>
      ) : view.kind !== "ok" ? (
        <div className="cart-empty">
          <p>{view.kind === "missing" ? "찾을 수 없는 공지예요." : "공지를 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요."}</p>
        </div>
      ) : (
        <article className="help-notice">
          <h2>
            {view.notice.isPinned && <span className="help-tag">고정</span>}
            {view.notice.title}
          </h2>
          <p className="help-date">{kstDate(view.notice.createdAt)}</p>
          <div className="help-body">{view.notice.body}</div>
        </article>
      )}
      <div className="cart-tools">
        <Link className="btn btn-sm btn-out" href={`${base}/help`}>
          목록으로
        </Link>
      </div>
    </div>
  );
}
