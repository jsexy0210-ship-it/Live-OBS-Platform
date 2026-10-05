"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { announceCount } from "./pdEvents";
import { call } from "./reviewShared";

// IA ④ 상품 상세 리뷰: 요약(평균·분포·사진 리뷰 수)과 최근 순 목록. GET /api/shop/{slug}/products/{id}/reviews?cursor → { average, total, photoCount, distribution, reviews, nextCursor }.
// 공개(VISIBLE) 리뷰만 센다. 불러오지 못해도 상세는 그대로 쓸 수 있게 이 영역에서만 안내한다.
type Review = {
  id: string;
  author: string;
  rating: number;
  body: string;
  optionName: string;
  images: { id: string; width: number; height: number; url: string }[];
  reply: string | null;
  repliedAt: string | null;
  createdAt: string;
};
type Data = { average: number | null; total: number; photoCount: number; distribution: { rating: number; count: number }[]; reviews: Review[]; nextCursor: string | null };

const kstDate = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${String(d.getUTCDate()).padStart(2, "0")}`;
};
const stars = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);

export default function ProductReviews({ slug, productId }: { slug: string; productId: string }) {
  const api = `/api/shop/${encodeURIComponent(slug)}/products/${productId}/reviews`;
  const [data, setData] = useState<Data | null>(null);
  const [state, setState] = useState<"loading" | "error" | "ok">("loading");
  const [more, setMore] = useState(false);

  const load = useCallback(async () => {
    setState("loading");
    const r = await call<Data>(api);
    if (r.ok) {
      setData(r.data);
      setState("ok");
      announceCount({ key: "reviews", n: r.data.total });
    } else setState("error");
  }, [api]);
  useEffect(() => void load(), [load]);

  async function loadMore() {
    if (!data?.nextCursor || more) return;
    setMore(true);
    const r = await call<Data>(`${api}?cursor=${encodeURIComponent(data.nextCursor)}`);
    if (r.ok) setData({ ...data, reviews: [...data.reviews, ...r.data.reviews], nextCursor: r.data.nextCursor });
    setMore(false);
  }

  return (
    <section className="pd-rv" id="pd-reviews" aria-labelledby="pd-rv-h">
      <h2 id="pd-rv-h">리뷰{data && data.total > 0 ? ` ${data.total.toLocaleString("ko-KR")}` : ""}</h2>
      {state === "loading" && <p className="shop-empty">리뷰를 불러오고 있어요</p>}
      {state === "error" && (
        <p className="shop-empty">
          리뷰를 불러오지 못했어요.{" "}
          <button type="button" className="shop-linkbtn" onClick={() => void load()}>
            다시 불러오기
          </button>
        </p>
      )}
      {state === "ok" && data && data.total === 0 && <p className="shop-empty">아직 리뷰가 없어요. 첫 리뷰를 기다리고 있어요.</p>}
      {state === "ok" && data && data.total > 0 && (
        <>
          <div className="pd-rv-sum">
            <div className="pd-rv-avg">
              <b>{data.average?.toFixed(1)}</b>
              <span aria-hidden="true">{stars(Math.round(data.average ?? 0))}</span>
              <small>사진 리뷰 {data.photoCount.toLocaleString("ko-KR")}개</small>
            </div>
            <ul className="pd-rv-dist" aria-label="별점 분포">
              {data.distribution.map((d) => (
                <li key={d.rating}>
                  <span>{d.rating}점</span>
                  <i aria-hidden="true">
                    <u style={{ width: `${data.total ? Math.round((d.count / data.total) * 100) : 0}%` }} />
                  </i>
                  <span>{d.count.toLocaleString("ko-KR")}</span>
                </li>
              ))}
            </ul>
          </div>
          <ul className="pd-rv-list">
            {data.reviews.map((r) => (
              <li key={r.id}>
                <p className="pd-rv-meta">
                  <span className="pd-rv-stars" role="img" aria-label={`${r.rating}점`}>
                    {stars(r.rating)}
                  </span>
                  <b>{r.author}</b>
                  <span>{kstDate(r.createdAt)}</span>
                </p>
                <p className="pd-rv-opt">{r.optionName}</p>
                <p className="pd-rv-body">{r.body}</p>
                {r.images.length > 0 && (
                  <p className="pd-rv-imgs">
                    {r.images.map((i) => (
                      <Image key={i.id} src={i.url} width={i.width} height={i.height} alt="리뷰 사진" unoptimized />
                    ))}
                  </p>
                )}
                {r.reply && (
                  <p className="pd-rv-reply">
                    <b>판매자 답글</b> {r.reply}
                  </p>
                )}
              </li>
            ))}
          </ul>
          {data.nextCursor && (
            <button type="button" className="btn btn-out pd-rv-more" disabled={more} aria-busy={more} onClick={() => void loadMore()}>
              {more ? "불러오고 있어요" : "리뷰 더 보기"}
            </button>
          )}
        </>
      )}
    </section>
  );
}
