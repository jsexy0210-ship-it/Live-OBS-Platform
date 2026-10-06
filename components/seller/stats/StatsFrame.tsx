"use client";

import "./stats.css";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead } from "../../admin-ui";
import { Topbar, planAllows, useSeller } from "../SellerShell";
import { LoadingRows } from "../States";
import { api } from "../api";
import { useUrlState } from "../../../lib/client/navigation";
import { DatePicker } from "../../../components/admin-ui/DatePicker";

// SA-056 통계 화면 공통 틀: 통계 탭 · 기간 선택(오늘·7일·1개월·이번 달·직접 선택, 기본 1개월) · 묶음 단위 · 상태(로딩·데이터 없음·오류·권한 없음).
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
export type Period = { preset: Preset | "custom"; from: string; to: string; unit: Unit; compare: boolean };
type Preset = "today" | "7d" | "30d" | "month";
const MAX_DAYS = 366;
const DAY_MS = 86_400_000;

export const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
export const shift = (d: string, days: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / DAY_MS) + 1;

// 이번 달: 그달 1일(KST)부터 오늘까지(MASTER 결정 2026-10-04)
function presetPeriod(preset: Preset, unit: Unit, compare = true): Period {
  const to = kstToday();
  const from = preset === "today" ? to : preset === "month" ? `${to.slice(0, 8)}01` : shift(to, preset === "7d" ? -6 : -29);
  return { preset, to, from, unit, compare };
}

export type Load<T> = { kind: "loading" } | { kind: "error"; status: number; error: string } | { kind: "ok"; data: T };

// 기간이 바뀌면 다시 부른다. 마지막 요청의 응답만 반영한다.
// skip: true면 부르지 않고 「불러오는 중」으로 둔다(비교 기간이 꺼져 있을 때 앞 기간을 부르지 않는다)
export function useStats<T>(path: string, p: Period, skip = false) {
  const [state, setState] = useState<Load<T>>({ kind: "loading" });
  const reqId = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    setState({ kind: "loading" });
    if (skip) return;
    const q = new URLSearchParams({ from: p.from, to: p.to, unit: p.unit });
    const r = await api<T>(`/api/seller/stats/${path}?${q}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error", status: r.status, error: r.error });
  }, [path, p.from, p.to, p.unit, skip]);
  useEffect(() => void load(), [load]);
  return { state, reload: load };
}

// 기간·묶음 단위·비교는 주소 쿼리가 기준이다(통계 하위 화면 → ← 에서 그대로 돌아온다, docs/IA.md Back 규칙 3항)
const PRESETS: Preset[] = ["today", "7d", "30d", "month"];
const UNITS: Unit[] = ["day", "week", "month"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export function usePeriod(): readonly [Period, (p: Period) => void] {
  const [q, set] = useUrlState({ preset: "30d", from: "", to: "", unit: "day", compare: "1" });
  const unit = (UNITS as string[]).includes(q.unit) ? (q.unit as Unit) : "day";
  const compare = q.compare !== "0";
  const fromUrl: Period =
    q.preset === "custom" && DATE.test(q.from) && DATE.test(q.to) && q.from <= q.to
      ? { preset: "custom", from: q.from, to: q.to, unit, compare }
      : presetPeriod((PRESETS as string[]).includes(q.preset) ? (q.preset as Preset) : "30d", unit, compare);
  // 주소가 바뀌기 전에도 선택이 바로 보이도록 고른 값을 잠시 들고, 주소가 따라오면(뒤로 가기 등 바깥 변경 포함) 주소 값으로 돌아간다
  const [picked, setPicked] = useState<Period | null>(null);
  const urlKey = `${q.preset}|${q.from}|${q.to}|${q.unit}|${q.compare}`;
  useEffect(() => setPicked(null), [urlKey]);
  const period = picked ?? fromUrl;
  const setPeriod = (p: Period) => {
    setPicked(p);
    set({ preset: p.preset, from: p.preset === "custom" ? p.from : "", to: p.preset === "custom" ? p.to : "", unit: p.unit, compare: p.compare ? "1" : "0" });
  };
  return [period, setPeriod] as const;
}

export function StatsFrame({ title, heading, sub, period, setPeriod, onDownload, download, units = true, comparable, children }: {
  title: string;
  // 제목을 따로 줄 때(요약은 「통계」). 없으면 「{title} 통계」
  heading?: string;
  // 내려받기 버튼 자리를 화면이 직접 그릴 때
  download?: React.ReactNode;
  sub: string;
  period: Period;
  setPeriod: (p: Period) => void;
  onDownload?: () => void;
  // 묶음 단위(일·주·월) 선택을 보일지. 기간 합계만 보는 화면(상품·방송)은 끈다
  units?: boolean;
  // 「직전 기간과 비교」 선택을 보일지(비교 값을 그리는 화면만)
  comparable?: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { me } = useSeller();
  const [draft, setDraft] = useState({ from: period.from, to: period.to });
  const [rangeError, setRangeError] = useState<string | null>(null);
  // 직접 입력한 날짜를 「조회」로 적용한다. 프리셋 칩은 누르는 즉시 조회한다
  const apply = () => {
    if (!draft.from || !draft.to) return setRangeError("시작일과 종료일을 입력해 주십시오");
    if (draft.to < draft.from) return setRangeError("종료일을 시작일과 같거나 뒤 날짜로 바꿔 주십시오");
    if (daysBetween(draft.from, draft.to) > MAX_DAYS) return setRangeError("날짜를 직접 정할 때는 최대 12개월까지 볼 수 있습니다. 기간을 줄여 주십시오");
    setRangeError(null);
    setPeriod({ ...period, preset: "custom", from: draft.from, to: draft.to });
  };
  const presets = [
    { key: "today", label: "오늘" },
    { key: "7d", label: "7일" },
    { key: "30d", label: "1개월" },
    { key: "month", label: "이번 달" },
  ] as const;
  const unitOptions: { key: Unit; label: string }[] = [
    { key: "day", label: "일" },
    { key: "week", label: "주" },
    { key: "month", label: "월" },
  ];

  return (
    <>
      <Topbar crumb={`통계 › ${title}`} />
      <main className="main">
        <PageHead title={heading ?? `통계 · ${title}`} actions={download ?? (onDownload && <button className="btn btn-out" type="button" onClick={onDownload}>엑셀 파일로 받기</button>)} />
        <nav className="tabs sts-tabs" aria-label="통계 종류">
          {STATS_TABS.filter((t) => planAllows(me.features, t.plan)).map((t) => (
            <Link key={t.href} href={t.href} className={`tab${(t.href === "/seller/stats" ? pathname === t.href : pathname.startsWith(t.href)) ? " on" : ""}`}>
              {t.label}
            </Link>
          ))}
        </nav>
        <form
          className="sts-period"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <table className="au-ft">
            <tbody>
              <tr>
                <th scope="row">기간</th>
                <td>
                  <div className="au-ft-v">
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
                          setPeriod({ ...next, compare: period.compare });
                        }}
                      >
                        {x.label}
                      </button>
                    ))}
                    <DatePicker aria-label="시작일" value={draft.from} max={draft.to || undefined} onChange={(v) => setDraft({ ...draft, from: v })} />
                    <span className="c-alt">~</span>
                    <DatePicker aria-label="종료일" value={draft.to} min={draft.from || undefined} onChange={(v) => setDraft({ ...draft, to: v })} />
                    {comparable && (
                      <label className="chk t-l2">
                        <input className="cbx" type="checkbox" checked={period.compare} onChange={(e) => setPeriod({ ...period, compare: e.target.checked })} />
                        바로 앞 기간과 비교
                      </label>
                    )}
                    <button className="btn" type="submit">
                      기간 보기
                    </button>
                    {units && (
                      <div className="seg" role="group" aria-label="합계를 나누는 단위">
                        {unitOptions.map((u) => (
                          <button key={u.key} type="button" className={period.unit === u.key ? "on" : ""} aria-pressed={period.unit === u.key} onClick={() => setPeriod({ ...period, unit: u.key })}>
                            {u.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {rangeError && (
                    <p className="err au-ft-help" role="alert">
                      {rangeError}
                    </p>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </form>
        <p className="t-c1 c-alt sts-sub-note">{sub}</p>
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
      ? ["지금 이용권에서는 통계를 볼 수 없습니다", "쇼핑몰까지 쓰는 이용권에서 볼 수 있습니다"]
      : state.status === 403
        ? ["통계를 볼 수 없는 계정입니다", "대표자에게 「매출 보기」를 허용해 달라고 요청해 주십시오"]
        : state.status === 402
          ? ["이용 기간이 끝나 통계를 볼 수 없습니다", "구독 후 다시 이용할 수 있습니다"]
          : state.status === 400
            ? ["볼 수 없는 기간입니다", "날짜를 직접 정할 때는 최대 12개월까지 볼 수 있습니다. 기간을 줄여 주십시오"]
            : ["통계를 불러오지 못했습니다", "인터넷 연결을 확인한 뒤 「다시 시도」를 눌러 주십시오"];
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
