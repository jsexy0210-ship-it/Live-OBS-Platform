"use client";

import "../../styles/overlay-widgets.css";
import type { CSSProperties } from "react";
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

export function WidgetView({ widget: wd, data, now, editing }: { widget: Widget; data: LiveData; now: number; editing?: boolean }) {
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
  const cls = `ow ow-${wd.type.toLowerCase().replace(/_/g, "-")}${p.glow ? " ow-glow" : ""}${appear}`;
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
      body = (
        <>
          <span className="ow-h">{title ?? "명예의 전당"}</span>
          {list.length === 0 ? (
            <span className="ow-empty">아직 HIT 카드가 없어요</span>
          ) : (
            <ol className="ow-list">
              {list.map((h) => (
                <li key={h.id} className="ow-row">
                  <span className="ow-tx">
                    <span className="ow-nm2">{h.cardName}</span>
                    <span className="ow-pd2">{h.nickname}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </>
      );
      break;
    }
    case "NOTICE":
      body = <span className={`ow-text${p.ticker ? " ow-marquee" : ""}`}>{p.ticker ? <i>{str(p, "text") ?? "공지를 입력해 주세요"}</i> : (str(p, "text") ?? "공지를 입력해 주세요")}</span>;
      break;
    case "SHOP_INFO":
      body = <span className="ow-text">{str(p, "format") ?? title ?? "쇼핑몰 정보"}</span>;
      break;
    case "OPEN_TIMER": {
      const o = data.opening;
      let left: number | null = null;
      if (o?.timerSeconds) {
        const startedMs = o.openingStartedAt ? Date.parse(o.openingStartedAt) : NaN;
        left = Number.isFinite(startedMs) ? o.timerSeconds - (now - startedMs) / 1000 : o.timerSeconds;
      }
      body = (
        <>
          <span className="ow-h">{title ?? "개봉까지"}</span>
          <span className="ow-timer">{left === null ? "--:--" : fmtTimer(left)}</span>
        </>
      );
      break;
    }
    case "NEW_ORDER_ALERT": {
      const v = { first: "첫 주문", repeat: "재주문", vip: "VIP" }[String(p.variant)] ?? "";
      const o = data.opening ?? data.waiting[0];
      const text = (str(p, "format") ?? "{닉네임}님이 {상품} {수량}개를 주문했어요")
        .replaceAll("{닉네임}", o?.nickname ?? "닉네임")
        .replaceAll("{상품}", o?.productLabel ?? "상품")
        .replaceAll("{수량}", String(o?.quantity ?? 1))
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
  return (
    <section className={cls} style={style as CSSProperties} aria-label={wd.type} data-widget={wd.type} data-testid={editing ? undefined : TEST_IDS[wd.type]}>
      {body}
    </section>
  );
}
