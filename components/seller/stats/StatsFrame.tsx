"use client";

import "./stats.css";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Topbar, planAllows, useSeller } from "../SellerShell";
import { LoadingRows } from "../States";
import { api } from "../api";

// SA-056 통계 화면 공통 틀: 통계 탭 · 기간 선택(오늘·최근 7일·최근 30일·직접 선택) · 묶음 단위 · 상태(로딩·데이터 없음·오류·권한 없음).
// 날짜는 KST 기준. 서버가 최대 366일까지 받는다(lib/server/stats/range.ts).
// plan: 그 탭을 여는 요금제 기능 권한(서버 stats API와 같은 기준). 없는 탭은 숨긴다(오버레이 전용은 방송만)
export const STATS_TABS = [
  { href: "/seller/stats", label: "요약", plan: "STORE_OPERATIONS" },
  { href: "/seller/stats/orders", label: "주문", plan: "STORE_OPERATIONS" },
  { href: "/seller/stats/sales", label: "매출", plan: "STORE_OPERATIONS" },
  { href: "/seller/stats/products", label: "상품", plan: "STORE_OPERATIONS" },
  { href: "/seller/stats/members", label: "회원", plan: "STORE_OPERATIONS" },
  { href: "/seller/stats/broadcasts", label: "방송", plan: "OVERLAY" },
] as const;

export type Unit = "day" | "week" | "month";
export type Period = { preset: Preset | "custom"; from: string; to: string; unit: Unit };
type Preset = "today" | "7d" | "30d" | "month";
const MAX_DAYS = 366;
const DAY_MS = 86_400_000;

export const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const shift = (d: string, days: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / DAY_MS) + 1;

// 이번 달: 그달 1일(KST)부터 오늘까지(MASTER 결정 2026-10-04)
function presetPeriod(preset: Preset, unit: Unit): Period {
  const to = kstToday();
  const from = preset === "today" ? to : preset === "month" ? `${to.slice(0, 8)}01` : shift(to, preset === "7d" ? -6 : -29);
  return { preset, to, from, unit };
}

export type Load<T> = { kind: "loading" } | { kind: "error"; status: number; error: string } | { kind: "ok"; data: T };

// 기간이 바뀌면 다시 부른다. 마지막 요청의 응답만 반영한다.
export function useStats<T>(path: string, p: Period) {
  const [state, setState] = useState<Load<T>>({ kind: "loading" });
  const reqId = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    setState({ kind: "loading" });
    const q = new URLSearchParams({ from: p.from, to: p.to, unit: p.unit });
    const r = await api<T>(`/api/seller/stats/${path}?${q}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error", status: r.status, error: r.error });
  }, [path, p.from, p.to, p.unit]);
  useEffect(() => void load(), [load]);
  return { state, reload: load };
}

export function usePeriod() {
  return useState<Period>(() => presetPeriod("7d", "day"));
}

export function StatsFrame({ title, heading, sub, period, setPeriod, onDownload, download, units = true, children }: {
  title: string;
  // 제목을 따로 줄 때(요약은 「통계」). 없으면 「{title} 통계」
  heading?: string;
  // 내려받기 버튼 자리를 화면이 직접 그릴 때(요약의 표 고르기)
  download?: React.ReactNode;
  sub: string;
  period: Period;
  setPeriod: (p: Period) => void;
  onDownload?: () => void;
  // 묶음 단위(일·주·월) 선택을 보일지. 기간 합계만 보는 화면(상품·방송)은 끈다
  units?: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { me } = useSeller();
  const [draft, setDraft] = useState({ from: period.from, to: period.to });
  const [rangeError, setRangeError] = useState<string | null>(null);
  const applyCustom = () => {
    if (!draft.from || !draft.to) return setRangeError("시작일과 종료일 입력이 필요합니다");
    if (draft.to < draft.from) return setRangeError("종료일은 시작일 이후여야 합니다");
    if (daysBetween(draft.from, draft.to) > MAX_DAYS) return setRangeError(`직접 선택은 최대 12개월까지 가능합니다 · 선택: ${draft.from} ~ ${draft.to}`);
    setRangeError(null);
    setPeriod({ ...period, preset: "custom", from: draft.from, to: draft.to });
  };
  const presets = [
    { key: "today", label: "오늘" },
    { key: "7d", label: "최근 7일" },
    { key: "30d", label: "최근 30일" },
    { key: "month", label: "이번 달" },
  ] as const;
  const unitOptions: { key: Unit; label: string }[] = [
    { key: "day", label: "일" },
    { key: "week", label: "주" },
    { key: "month", label: "월" },
  ];

  return (
    <>
      <Topbar crumb={heading ? `홈 › ${heading}` : `통계 › ${title}`} />
      <main className="main">
        <div className="ph">
          <div className="col" style={{ gap: 4 }}>
            <h1 className="t-t3">{heading ?? `${title} 통계`}</h1>
            <span className="t-l2 c-alt">{sub}</span>
          </div>
          {download}
          {onDownload && (
            <button className="btn btn-sm btn-out" type="button" onClick={onDownload}>
              엑셀(CSV) 내려받기
            </button>
          )}
        </div>
        <nav className="tabs" aria-label="통계 종류">
          {STATS_TABS.filter((t) => planAllows(me.features, t.plan)).map((t) => (
            <Link key={t.href} href={t.href} className={`tab${(t.href === "/seller/stats" ? pathname === t.href : pathname.startsWith(t.href)) ? " on" : ""}`}>
              {t.label}
            </Link>
          ))}
        </nav>
        <div className="card">
          <div className="sts-bar">
            {presets.map((x) => (
              <button
                key={x.key}
                type="button"
                className={`chip${period.preset === x.key ? " on" : ""}`}
                aria-pressed={period.preset === x.key}
                onClick={() => {
                  const next = presetPeriod(x.key, period.unit);
                  setDraft({ from: next.from, to: next.to });
                  setRangeError(null);
                  setPeriod(next);
                }}
              >
                {x.label}
              </button>
            ))}
            <div className="sts-range">
              <input className="inp inp-sm" type="date" aria-label="시작일" value={draft.from} max={draft.to || undefined} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
              <span className="c-alt">~</span>
              <input className="inp inp-sm" type="date" aria-label="종료일" value={draft.to} min={draft.from || undefined} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
              <button className={`btn btn-sm${period.preset === "custom" ? "" : " btn-out"}`} type="button" onClick={applyCustom}>
                직접 선택
              </button>
            </div>
            <span className="grow" />
            {units && (
              <div className="seg" role="group" aria-label="묶음 단위">
                {unitOptions.map((u) => (
                  <button key={u.key} type="button" className={period.unit === u.key ? "on" : ""} aria-pressed={period.unit === u.key} onClick={() => setPeriod({ ...period, unit: u.key })}>
                    {u.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {rangeError && (
            <div className="err" role="alert" style={{ padding: "0 20px 12px" }}>
              {rangeError}
            </div>
          )}
        </div>
        {children}
      </main>
    </>
  );
}

// 로딩·오류·권한 없음·잠금 상태. ok일 때는 null(화면이 직접 그린다).
export function StatsState<T>({ state, onRetry }: { state: Load<T>; onRetry: () => void }) {
  if (state.kind === "loading") {
    return (
      <div className="card">
        <LoadingRows rows={5} />
      </div>
    );
  }
  if (state.kind === "ok") return null;
  const lock = state.status === 402 || state.status === 403;
  const [t, s] =
    state.status === 403 && state.error === "plan_feature_required"
      ? ["현재 플랜에서 제공하지 않는 기능입니다", "쇼핑몰 통합 플랜에서 통계를 볼 수 있습니다"]
      : state.status === 403
        ? ["통계 조회 권한이 필요합니다", "대표자에게 「매출 보기」 권한 요청이 필요합니다"]
        : state.status === 402
          ? ["이용 기간이 끝나 통계를 볼 수 없습니다", "구독 후 다시 이용할 수 있습니다"]
          : state.status === 400
            ? ["조회할 수 없는 기간입니다", "직접 선택은 최대 12개월까지 가능합니다"]
            : ["통계를 불러오지 못했습니다", "잠시 뒤 다시 시도해 주십시오"];
  return (
    <div className="card">
      <div className="st" style={{ boxShadow: "none" }} role={lock ? undefined : "alert"}>
        <div className={`st-ic${lock ? " lock" : " neg"}`}>!</div>
        <span className="t">{t}</span>
        <span className="s">{s}</span>
        {!lock && state.status !== 400 && (
          <button className="btn btn-sm" type="button" onClick={onRetry}>
            다시 시도
          </button>
        )}
      </div>
    </div>
  );
}

export function EmptyStats({ text, sub = "기간을 바꿔 조회할 수 있습니다" }: { text: string; sub?: string }) {
  return (
    <div className="card">
      <div className="st" style={{ boxShadow: "none" }}>
        <div className="st-ic">0</div>
        <span className="t">{text}</span>
        <span className="s">{sub}</span>
      </div>
    </div>
  );
}
