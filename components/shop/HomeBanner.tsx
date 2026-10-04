"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import "./HomeBanner.css";

// 쇼핑몰 홈 배너 슬라이드(SH-001 「홈 배너 슬라이드」). 5초마다 넘어가고, 손으로 넘기거나 점·화살표로 고를 수 있다.
// 모바일(767px 이하)은 모바일 이미지, 없으면 PC 이미지를 쓴다. 링크가 있으면 눌러서 이동한다(바깥 주소는 새 창).
// 마우스를 올리거나 키보드로 들어오면 자동 넘김을 멈추고, 움직임 줄이기 설정이면 자동으로 넘기지 않는다.
type Img = { url: string; width: number; height: number };
export type HomeBannerItem = { id: string; title: string; link: { href: string; external: boolean } | null; pcImage: Img; mobileImage: Img | null };

const INTERVAL_MS = 5000;

export default function HomeBanner({ banners }: { banners: HomeBannerItem[] }) {
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = banners.length;

  const go = useCallback((i: number) => {
    const el = track.current;
    if (!el) return;
    const n = (i + count) % count;
    el.scrollTo({ left: n * el.clientWidth, behavior: "smooth" });
  }, [count]);

  // 손으로 넘긴 위치를 지금 번호로 맞춘다
  const onScroll = () => {
    const el = track.current;
    if (el && el.clientWidth > 0) setIndex(Math.round(el.scrollLeft / el.clientWidth));
  };

  useEffect(() => {
    if (count < 2 || paused) return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => go(index + 1), INTERVAL_MS);
    return () => clearInterval(t);
  }, [count, paused, index, go]);

  if (count === 0) return null;
  return (
    <section
      className="hb"
      aria-roledescription="carousel"
      aria-label="홈 배너"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className="hb-track" ref={track} onScroll={onScroll}>
        {banners.map((b, i) => {
          const img = (
            <picture>
              {b.mobileImage && <source media="(max-width: 767px)" srcSet={b.mobileImage.url} width={b.mobileImage.width} height={b.mobileImage.height} />}
              <img src={b.pcImage.url} width={b.pcImage.width} height={b.pcImage.height} alt={b.title} loading={i === 0 ? "eager" : "lazy"} draggable={false} />
            </picture>
          );
          return (
            <div key={b.id} className="hb-slide" role="group" aria-roledescription="slide" aria-label={`${i + 1} / ${count}`} aria-hidden={i !== index}>
              {b.link ? (
                <a href={b.link.href} tabIndex={i === index ? 0 : -1} {...(b.link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                  {img}
                </a>
              ) : (
                img
              )}
            </div>
          );
        })}
      </div>
      {count > 1 && (
        <>
          <button className="hb-arrow hb-prev" type="button" aria-label="이전 배너" onClick={() => go(index - 1)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <button className="hb-arrow hb-next" type="button" aria-label="다음 배너" onClick={() => go(index + 1)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
          <div className="hb-dots">
            {banners.map((b, i) => (
              <button key={b.id} type="button" className={i === index ? "on" : ""} aria-label={`${i + 1}번째 배너 보기`} aria-current={i === index} onClick={() => go(i)} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
