"use client";

import { useState } from "react";

// 통계 부품: 지표 칸(직전 기간 대비) · 막대 그래프(SVG, 의존성 없음) · CSV 내려받기.

export const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
export const count = (n: number) => `${n.toLocaleString("ko-KR")}건`;
export const pct = (r: number | null) => (r === null ? "—" : `${(r * 100).toFixed(1)}%`);

// 직전 기간 대비. 직전 값이 0이면 비율 대신 「바로 앞 기간 0」으로 둔다. lowerIsBetter: 취소·환불처럼 줄면 좋은 값.
function Delta({ now, prev, fmt, lowerIsBetter, caption = "바로 앞 기간", compact = false, difference = false }: { now: number | null; prev: number | null; fmt: (n: number) => string; lowerIsBetter?: boolean; caption?: string; compact?: boolean; difference?: boolean }) {
  if (now === null || prev === null) return <span className="d">{compact ? "—" : `${caption} —`}</span>;
  if (difference) return <span className="d">{caption} 대비 {now === prev ? "0" : `${now > prev ? "▲" : "▼"} ${Math.abs(now - prev).toLocaleString("ko-KR")}`}</span>;
  if (prev === 0) return <span className="d">{caption} {fmt(0)}</span>;
  const r = (now - prev) / Math.abs(prev);
  if (r === 0) return <span className="d">{compact ? "0.0%" : `${caption}과 같습니다`}</span>;
  const good = lowerIsBetter ? r < 0 : r > 0;
  return (
    <span className="d">
      {!compact && (caption === "바로 앞 기간" ? "바로 앞 기간보다 " : `${caption} 대비 `)}
      <b className={good ? "sts-up" : "sts-down"}>
        {r > 0 ? "▲" : "▼"} {Math.abs(r * 100).toFixed(1)}%
      </b>
    </span>
  );
}

// compare: false면 비교 줄을 빼고 note(있으면)를 둔다(비교 기간이 없는 지표)
export type Kpi = { label: string; now: number | null; prev: number | null; fmt: (n: number) => string; lowerIsBetter?: boolean; text?: string; compare?: false; note?: string };

export function Kpis({ items, caption, compact = false, difference = false }: { items: Kpi[]; caption?: string; compact?: boolean; difference?: boolean }) {
  return (
    <div className="sts-kpis">
      {items.map((k) => (
        <div key={k.label} className="stat" data-testid="stats-kpi">
          <span className="t-l2 c-alt">{k.label}</span>
          <span className="v">{k.text ?? (k.now === null ? "—" : k.fmt(k.now))}</span>
          {k.compare === false ? <span className="d">{k.note ?? "\u00a0"}</span> : compact ? <span className="home-kpi-note"><Delta now={k.now} prev={k.prev} fmt={k.fmt} lowerIsBetter={k.lowerIsBetter} caption={caption} compact difference={difference} />{k.note && <> {k.note}</>}</span> : <Delta now={k.now} prev={k.prev} fmt={k.fmt} lowerIsBetter={k.lowerIsBetter} caption={caption} difference={difference} />}
        </div>
      ))}
    </div>
  );
}

// 묶음 표기(공용 서식 「2026.10.05」): 일 2026.10.04 · 주 2026.10.05 주(그 주 시작일) · 월 2026.10
export function bucketLabel(bucket: string, unit: "day" | "week" | "month") {
  const [y, m, d] = bucket.split("-");
  if (unit === "month") return `${y}.${m}`;
  const day = `${y}.${m}.${d}`;
  return unit === "week" ? `${day} 주` : day;
}

const nice = (max: number) => {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  const f = max / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
};
const short = (n: number) => (n >= 100_000_000 ? `${+(n / 100_000_000).toFixed(1)}억` : n >= 10_000 ? `${+(n / 10_000).toFixed(1)}만` : n.toLocaleString("ko-KR"));

// 단일 계열 막대 그래프. 값 이름은 제목이 말하고, 막대에 올리면 값이 보인다. 같은 값은 아래 표에도 있다.
// 막대는 늘어나는 SVG로, 축 글자는 HTML로 그린다(SVG를 가로로 늘리면 글자가 찌그러진다).
// bare: 카드·제목 없이 그래프만(요약 화면의 칸 안에 넣을 때)
export function BarChart({ title, points, fmt, bare, compact = false }: { title: string; points: { label: string; value: number }[]; fmt: (n: number) => string; bare?: boolean; compact?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  if (compact) {
    const max = Math.max(1, ...points.map((p) => p.value));
    return <div className="home-chart card"><div className="home-chart-head"><b>{title}</b><span>합계 {fmt(points.reduce((sum, p) => sum + p.value, 0))}</span></div><div className="home-bars" role="img" aria-label={`${title} 그래프`}>{points.map((p, i) => <div key={p.label} title={`${p.label} · ${fmt(p.value)}`}><i style={{ height: `${Math.max(0, p.value / max * 100)}%` }} /><span>{i % Math.ceil(points.length / 8) === 0 ? p.label : "\u00a0"}</span></div>)}</div></div>;
  }
  const W = 1000;
  const H = 200;
  const top = nice(Math.max(0, ...points.map((p) => p.value)));
  const n = Math.max(points.length, 1);
  const slot = W / n;
  const bw = Math.max(2, Math.min(36, slot * 0.7));
  const y = (v: number) => H * (1 - v / top);
  const every = Math.ceil(n / 8);
  const pctX = (i: number) => `${((slot * i + slot / 2) / W) * 100}%`;
  const chart = (
      <div className="sts-chart">
        <div className="sts-plot" onMouseLeave={() => setHover(null)}>
          {[0, 0.5, 1].map((f) => (
            <span key={f} className="sts-y" style={{ top: `${(1 - f) * 100}%` }}>
              {short(top * f)}
            </span>
          ))}
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${title} 그래프`}>
            {[0, 0.5, 1].map((f) => (
              <line key={f} className="grid" x1={0} x2={W} y1={y(top * f)} y2={y(top * f)} vectorEffect="non-scaling-stroke" />
            ))}
            {points.map((p, i) => {
              const x = slot * i + (slot - bw) / 2;
              const h = Math.max(0, H - y(p.value));
              return (
                <g key={i} className={hover === i ? "on" : ""} onMouseEnter={() => setHover(i)}>
                  <rect className="hit" x={slot * i} y={0} width={slot} height={H} />
                  {h > 0 && <path className="bar" d={roundedTop(x, H - h, bw, h, Math.min(4, bw / 2, h))} />}
                </g>
              );
            })}
          </svg>
          {hover !== null && points[hover] && (
            <div className="sts-tip" style={{ left: pctX(hover), top: `${(y(points[hover].value) / H) * 100}%` }}>
              {points[hover].label} · {fmt(points[hover].value)}
            </div>
          )}
        </div>
        <div className="sts-x" aria-hidden="true">
          {points.map((p, i) =>
            i % every === 0 ? (
              <span key={i} style={{ left: pctX(i) }}>
                {p.label}
              </span>
            ) : null,
          )}
        </div>
      </div>
  );
  if (bare) return chart;
  return (
    <div className="card">
      <div className="sts-h">
        <span className="fw6">{title}</span>
      </div>
      {chart}
    </div>
  );
}

// 위쪽 모서리만 둥근 막대(바닥은 기준선에 붙인다)
function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

// 파일 이름은 영문으로 둔다(한글 이름은 브라우저에 따라 「download」로 바뀐다).
// 엑셀에서 한글이 깨지지 않게 BOM을 붙인 CSV로 내려받는다. 값에 쉼표·따옴표·줄바꿈이 있으면 따옴표로 감싼다.
// 수식으로 해석될 수 있는 첫 글자(= + - @)는 앞에 작은따옴표를 붙여 막는다(숫자는 그대로).
export function downloadCsv(filename: string, header: string[], rows: (string | number | null)[][]) {
  const cell = (v: string | number | null) => {
    if (v === null) return "";
    if (typeof v === "number") return String(v);
    const s = /^[=+\-@]/.test(v) ? `'${v}` : v;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = "﻿" + [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 바로 해제하면 브라우저가 파일 이름을 잃고 「download」로 저장한다. 내려받기가 시작된 뒤 해제한다
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
