"use client";

import Image, { type StaticImageData } from "next/image";
import { useEffect, useId, useState, type ReactNode } from "react";
import styles from "./Landing.module.css";

export type HeroSlide = { id: string; name: string; label: string; image: StaticImageData; alt: string; position: string };

export function HeroSlides({ slides, fallback, children }: { slides: readonly [HeroSlide, HeroSlide, HeroSlide]; fallback: StaticImageData; children: ReactNode }) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(true);
  const [visible, setVisible] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const noteId = useId();
  const slide = slides[index] ?? slides[0];
  const rotating = playing && !reducedMotion && visible && !hovered && !focused;
  const imageFailed = failed[slide.id];
  const fallbackFailed = failed[`fallback-${slide.id}`];

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const motion = () => setReducedMotion(media.matches);
    const visibility = () => setVisible(document.visibilityState === "visible");
    motion();
    visibility();
    media.addEventListener("change", motion);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      media.removeEventListener("change", motion);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  useEffect(() => {
    if (!rotating) return;
    const timer = window.setTimeout(() => setIndex((current) => (current + 1) % slides.length), 6500);
    return () => window.clearTimeout(timer);
  }, [index, rotating, slides.length]);

  const select = (next: number) => {
    setPlaying(false);
    setIndex((next + slides.length) % slides.length);
  };

  return <div role="region" aria-roledescription="슬라이드" aria-label="방송 예시 슬라이드" aria-describedby={noteId}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
    onKeyDown={(event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        select(index + (event.key === "ArrowRight" ? 1 : -1));
      }
    }}>
    <div className={styles.broadcastHeader}><span className={styles.liveBadge}>LIVE</span><span aria-live={rotating ? "off" : "polite"} aria-atomic="true">{slide.name}</span><span className={styles.exampleLabel}>화면 예시</span></div>
    <div className={styles.stage}>
      {fallbackFailed ? <p className={styles.slideFailure} role="status">방송 예시 이미지를 불러오지 못했어요</p> : <Image key={`${slide.id}-${imageFailed ? "fallback" : "image"}`} src={imageFailed ? fallback : slide.image}
        alt={imageFailed ? `${slide.name} 이미지를 불러오지 못해 쇼핑 방송 예시로 보여줘요` : slide.alt} fill
        sizes="(max-width: 760px) calc(100vw - 70px), (max-width: 1100px) 65vw, 720px"
        className={`${styles.stagePhoto} ${styles.slidePhoto}`} style={{ objectPosition: imageFailed ? "65% 45%" : slide.position }}
        onError={() => setFailed((current) => ({ ...current, [imageFailed ? `fallback-${slide.id}` : slide.id]: true }))} />}
      {children}
    </div>
    <div className={styles.slideControls}>
      <button type="button" onClick={() => select(index - 1)} aria-label="이전 방송 예시">이전</button>
      <div className={styles.slideChoices} role="group" aria-label="방송 예시 선택">
        {slides.map((item, position) => <button type="button" key={item.id} aria-label={`${item.name} 보기`} aria-pressed={position === index} onClick={() => select(position)}>{item.label}</button>)}
      </div>
      <button type="button" onClick={() => select(index + 1)} aria-label="다음 방송 예시">다음</button>
      <button type="button" disabled={reducedMotion} onClick={() => setPlaying((current) => !current)} aria-label={`방송 예시 자동 전환 ${playing && !reducedMotion ? "일시정지" : "재개"}`}>{playing && !reducedMotion ? "일시정지" : "자동 전환"}</button>
    </div>
    <small className={styles.slideNote} id={noteId}>{imageFailed && !fallbackFailed ? "이미지를 불러오지 못해 쇼핑 방송 예시로 대신 보여줘요 · " : ""}{slide.label === "쇼핑" ? "쇼핑 방송 예시" : `${slide.label} 방송 예시 · AI 이미지`} · 상품과 주문 정보는 샘플이에요</small>
  </div>;
}
