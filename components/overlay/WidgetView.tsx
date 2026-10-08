"use client";

import "../../styles/overlay-widgets.css";
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { type LiveData, type PropValue, type Widget } from "./layout";

// 위젯 한 개를 그린다(오버레이 화면과 편집기 미리보기가 같은 그림을 쓴다). 위치·크기는 부모(1080×1920 또는 1920×1080 무대) 대비 %.
const str = (p: Record<string, PropValue>, k: string): string | undefined => (typeof p[k] === "string" && p[k] !== "" ? (p[k] as string) : undefined);
const num = (p: Record<string, PropValue>, k: string): number | undefined => (typeof p[k] === "number" ? (p[k] as number) : undefined);

// #RRGGBB + 투명도(0~1) → rgba. 색을 안 정했으면 undefined(CSS 기본색)
function withOpacity(hex: string | undefined, opacity: number | undefined): string | undefined {
  if (!hex) return undefined;
  if (opacity === undefined) return hex;
  const m = /^#([0-9a-f]{6})/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${opacity})`;
}

const TEST_IDS: Partial<Record<Widget["type"], string>> = { CURRENT_ORDER: "overlay-opening", QUEUE: "overlay-queue" };

export function fmtTimer(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const hitDateFormat = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit" });
const hitDate = (iso?: string): string | null => {
  if (!iso || Number.isNaN(Date.parse(iso))) return null;
  const parts = hitDateFormat.formatToParts(new Date(iso));
  return `${parts.find((p) => p.type === "month")?.value}.${parts.find((p) => p.type === "day")?.value}`;
};

function HallTicker({ hits, freshHitIds, enabled, flowSec }: { hits: LiveData["hits"]; freshHitIds?: string[]; enabled: boolean; flowSec?: number }) {
  const viewport = useRef<HTMLDivElement>(null);
  const cycle = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const view = viewport.current;
    const content = cycle.current;
    if (!view || !content) return;
    const measure = () => setOverflows(content.getBoundingClientRect().height > view.getBoundingClientRect().height + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(view);
    observer.observe(content);
    return () => observer.disconnect();
  }, [hits.length]);
  const scrolling = enabled && overflows;
  const renderRows = (duplicate: boolean) => hits.map((h, i) => {
    const date = hitDate(h.createdAt);
    return <div key={`${h.id}-${i}`} className={`ow-hall-row${freshHitIds?.includes(h.id) ? " ow-hit-new" : ""}`} aria-hidden={duplicate || undefined} data-fresh={freshHitIds?.includes(h.id) && !duplicate ? "1" : undefined}>
      <span className="ow-hall-rank">{i + 2}</span>
      {date && <time>{date}</time>}
      <span className="ow-hall-name">{h.nickname}</span><span className="ow-hall-card">{h.cardName}</span>
    </div>;
  });
  return <div className="ow-hall-ticker" ref={viewport}>
    <div className={`ow-hall-track${scrolling ? "" : " ow-hall-static"}`} style={scrolling ? { animationDuration: `${flowSec ?? hits.length * 3.2}s` } : undefined}>
      <div ref={cycle}>{renderRows(false)}</div>
      {scrolling && <div aria-hidden="true">{renderRows(true)}</div>}
    </div>
  </div>;
}

export function fmtEventTimer(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const kstDay = (ms: number) => Math.floor(Date.parse(new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)) / 86_400_000);
const kstDateTime = (ms: number) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map(({ type, value }) => [type, value]));
  return `${parts.year}.${parts.month}.${parts.day} ${parts.hour}:${parts.minute}`;
};

export function WidgetView({ widget: wd, data, now, editing, landscape = false, stateReceivedAt = now }: { widget: Widget; data: LiveData; now: number; editing?: boolean; landscape?: boolean; stateReceivedAt?: number }) {
  const p = wd.props;
  const style: Record<string, string | number | undefined> = {
    left: `${wd.x}%`,
    top: `${wd.y}%`,
    width: `${wd.w}%`,
    height: `${wd.h}%`,
    zIndex: wd.z,
    "--w-accent": str(p, "accentColor"),
    "--w-title": str(p, "titleColor"),
    "--w-nick": str(p, "nicknameColor"),
    "--w-body": str(p, "bodyColor"),
    "--w-title-bg": withOpacity(str(p, "titleBgColor"), num(p, "titleBgOpacity")),
    "--w-card-bg": withOpacity(str(p, "cardBgColor"), num(p, "cardBgOpacity")),
    "--w-border": str(p, "borderColor"),
    "--w-radius": num(p, "radius") === undefined ? undefined : `${num(p, "radius")}px`,
    "--w-fs": num(p, "fontSize") === undefined ? undefined : `${num(p, "fontSize")}px`,
    "--w-fw": num(p, "fontWeight"),
    "--w-appear": num(p, "appearSec") === undefined ? undefined : `${num(p, "appearSec")}s`,
    "--w-flow": num(p, "flowSec") === undefined ? undefined : `${num(p, "flowSec")}s`,
    "--w-event-scale": wd.type === "EVENT_CARD" ? Math.min(1, wd.h / (landscape ? 14 : 18)) : undefined,
    "--w-q-open-title": str(p, "openTitleColor"),
    "--w-q-open-nick": str(p, "openNicknameColor"),
    "--w-q-open-prod": str(p, "openProductColor"),
    "--w-q-open-border": str(p, "openBorderColor"),
    "--w-q-wait-title": str(p, "waitTitleColor"),
    "--w-q-wait-nick": str(p, "waitNicknameColor"),
    "--w-q-wait-prod": str(p, "waitProductColor"),
    "--w-q-wait-border": str(p, "waitBorderColor"),
    "--w-q-wait-idx": str(p, "waitIndexColor"),
    "--w-q-wait-cnt": str(p, "waitCountColor"),
  };
  for (const k of Object.keys(style)) if (style[k] === undefined) delete style[k];
  const appear = typeof p.appear === "string" && p.appear !== "none" && !editing ? ` ow-ap-${p.appear}` : "";
  let cls = `ow ow-${wd.type.toLowerCase().replace(/_/g, "-")}${p.glow ? " ow-glow" : ""}${appear}`;
  const title = str(p, "title");
  const rows = Math.max(1, Math.min(10, num(p, "rows") ?? 5));

  let body: React.ReactNode = null;
  switch (wd.type) {
    case "CURRENT_ORDER": {
      const o = data.opening;
      body = o ? (
        <>
          {o.gradeSnapshot && <span className="ow-grade">{o.gradeSnapshot}</span>}
          <span className={`ow-nm${p.marquee ? " ow-marquee" : ""}`} data-testid="ow-current-name">
            <i>{o.nickname}</i>
          </span>
          <span className="ow-pd">
            {o.productLabel} ×{o.quantity}
          </span>
        </>
      ) : (
        <span className="ow-empty">{title ?? "현재 주문"}을 기다리고 있어요</span>
      );
      break;
    }
    case "QUEUE": {
      const list = data.waiting.slice(0, rows);
      body = (
        <>
          <span className="ow-h">{title ?? "주문대기"}</span>
          {list.length === 0 ? (
            <span className="ow-empty">대기 중인 주문이 없어요</span>
          ) : (
            <ol className="ow-list">
              {list.map((w, i) => (
                <li key={w.id} className="ow-row">
                  <span className="ow-no">{i + 1}</span>
                  <span className="ow-tx">
                    <span className="ow-nm2">{w.nickname}</span>
                    <span className="ow-pd2">
                      {w.productLabel} ×{w.quantity}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </>
      );
      break;
    }
    case "HALL_OF_FAME": {
      const list = data.hits.slice(0, rows);
      const [first, ...rest] = list;
      const firstDate = hitDate(first?.createdAt);
      body = (
        <>
          <span className="ow-h ow-hall-heading">{title ?? "명예의 전당"}<small>최근 당첨 순</small></span>
          {!first ? (
            <span className="ow-empty">아직 HIT 카드가 없어요</span>
          ) : (
            <>
              <div className={`ow-hall-first${data.freshHitIds?.includes(first.id) ? " ow-hit-new" : ""}`} data-fresh={data.freshHitIds?.includes(first.id) ? "1" : undefined}>
                <span className="ow-hall-rank">1</span>
                <span className="ow-hall-person"><span className="ow-hall-line"><span className="ow-hall-name">{first.nickname}</span>{firstDate && <time>{firstDate}</time>}</span><span className="ow-hall-card">{first.cardName}</span></span>
              </div>
              {rest.length > 0 && <HallTicker hits={rest} freshHitIds={data.freshHitIds} enabled={p.ticker !== false} flowSec={num(p, "flowSec")} />}
            </>
          )}
        </>
      );
      break;
    }
    case "NOTICE":
      body = <span className={`ow-text${p.ticker ? " ow-marquee" : ""}`}>{p.ticker ? <i>{str(p, "text") ?? "공지를 입력해 주세요"}</i> : (str(p, "text") ?? "공지를 입력해 주세요")}</span>;
      break;
    case "SHOP_INFO": {
      const d = new Date(now || Date.now());
      const date = d.toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short", timeZone: "Asia/Seoul" });
      const time = d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Seoul" });
      const addr = data.shop?.url ? data.shop.url.replace(/^https?:\/\//, "") : "";
      const text = (str(p, "format") ?? "{주소} · {날짜} {시각}")
        .replaceAll("{이름}", data.shop?.name ?? "")
        .replaceAll("{주소}", addr)
        .replaceAll("{날짜}", date)
        .replaceAll("{시각}", time);
      body = <span className="ow-text">{text.replace(/^[\s·]+|[\s·]+$/g, "")}</span>;
      break;
    }
    case "OPEN_TIMER": {
      const o = data.opening;
      let left: number | null = null;
      if (o?.timerSeconds && o.timerSeconds > 0) {
        const startedMs = o.openingStartedAt ? Date.parse(o.openingStartedAt) : NaN;
        left = Number.isFinite(startedMs) ? o.timerSeconds - (now - startedMs) / 1000 : o.timerSeconds;
      }
      const progress = left === null || !o?.timerSeconds ? 0 : Math.max(0, Math.min(100, (left / o.timerSeconds) * 100));
      if (left !== null && left > 0 && left <= 10) cls += " ow-timer-urgent";
      body = (
        <>
          <span className="ow-timer-label">{title ?? "오픈까지"}</span>
          <span className="ow-timer">{left === null ? "--:--" : fmtTimer(left)}</span>
          <span className="ow-timer-bar" role="progressbar" aria-label="오픈까지 남은 시간" aria-valuemin={0} aria-valuemax={100} aria-valuenow={left === null ? undefined : Math.round(progress)}><i style={{ width: `${progress}%` }} /></span>
        </>
      );
      break;
    }
    case "EVENT_CARD": {
      const e = data.eventCard;
      if (!e) break;
      const remainingSeconds = editing
        ? e.remainingSeconds
        : Math.max(0, e.remainingSeconds - Math.floor(Math.max(0, now - stateReceivedAt) / 1000));
      const active = remainingSeconds > 0;
      const endAt = Date.parse(e.endsAt);
      const daysLeft = Math.max(0, kstDay(endAt - 1) - kstDay(now));
      const urgency = remainingSeconds < 3600 ? "soon" : daysLeft === 0 ? "today" : "days";
      const badge = urgency === "soon" ? "곧 끝나요" : daysLeft === 0 ? "오늘 마감" : `${daysLeft}일 남음`;
      const endDate = kstDateTime(endAt - 1);
      body = (
        <>
          <span className="ow-ev-main">
            {active && <span className="ow-ev-sub ow-ev-sub-port">{title ?? "지금 방송 상품 · 이벤트 할인"}</span>}
            {active && <span className="ow-ev-sub ow-ev-sub-land">{title ?? `이벤트 할인 · ${daysLeft === 1 ? "내일까지" : badge}`}</span>}
            <span className="ow-ev-name">{e.productName}</span>
            {active && <s className="ow-ev-was">정가 {e.price.toLocaleString("ko-KR")}원</s>}
          </span>
          <span className="ow-ev-price">
            {active && e.discountRate !== null && <b className="ow-ev-rate">{e.discountRate}%</b>}
            <b className="ow-ev-now">{(active ? e.discountedPrice : e.price).toLocaleString("ko-KR")}원</b>
          </span>
          {active && (
            <span className={`ow-ev-meta ${urgency}`}>
              <span className={`ow-ev-clock ${urgency}`}>
                <span className="ow-ev-badge">{badge}</span>
                <b className="ow-ev-timer">{fmtEventTimer(remainingSeconds)}</b>
                <span className="ow-ev-countdown-suffix">남았어요</span>
              </span>
              <span className="ow-ev-remaining">{endDate}까지</span>
            </span>
          )}
        </>
      );
      break;
    }
    case "PURCHASE_RANKING": {
      const list = (data.purchaseRanking ?? []).slice(0, rows);
      body = (
        <>
          <span className="ow-h">{title ?? "구매 랭킹"}</span>
          {list.length === 0 ? (
            <span className="ow-empty">아직 구매한 분이 없어요</span>
          ) : (
            <ol className="ow-list">
              {list.map((r, i) => (
                <li key={`${r.rank}:${r.nickname}:${i}`} className="ow-row">
                  <span className="ow-no">{r.rank}</span>
                  <span className="ow-tx">
                    <span className="ow-nm2">{r.nickname}</span>
                    <span className="ow-pd2">{r.quantity}개</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </>
      );
      break;
    }
    case "NEW_ORDER_ALERT": {
      const ev = data.alert;
      const v = ev ? { FIRST: "첫 주문", REPEAT: "재주문", VIP: "VIP" }[ev.kind] : "";
      const product = ev ? `${ev.productLabel}${ev.moreItems > 0 ? ` 외 ${ev.moreItems}건` : ""}` : "상품";
      const text = (str(p, "format") ?? "{닉네임}님이 {상품} {수량}개를 주문했어요")
        .replaceAll("{닉네임}", ev?.nickname ?? "닉네임")
        .replaceAll("{상품}", product)
        .replaceAll("{수량}", String(ev?.quantity ?? 1))
        .replaceAll("{등급}", v)
        .replaceAll("{카드명}", data.hits[0]?.cardName ?? "카드")
        .replaceAll("{건수}", String(data.waiting.length));
      body = (
        <>
          <span className="ow-grade">{v}</span>
          <span className="ow-text">{text}</span>
        </>
      );
      break;
    }
  }
  // 방송 화면에서는 내용이 없는 공지·쇼핑몰 정보 띠를 그리지 않는다(편집기에서는 자리 표시로 보인다)
  if (!editing && ((wd.type === "EVENT_CARD" && !data.eventCard) || (wd.type === "PURCHASE_RANKING" && (data.purchaseRanking?.length ?? 0) === 0))) return null;
  if (!editing && ((wd.type === "NOTICE" && !str(p, "text")) || (wd.type === "SHOP_INFO" && !data.shop?.url && !str(p, "format")))) return null;
  return (
    <section className={cls} style={style as CSSProperties} aria-label={wd.type} data-widget={wd.type} data-testid={editing ? undefined : TEST_IDS[wd.type]}>
      {body}
    </section>
  );
}
