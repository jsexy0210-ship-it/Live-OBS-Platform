"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead, useConfirm } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { formatDate, formatDateTime } from "../../../../../../lib/client/format";
import { adminApi, failMessage } from "../../../_components/api";
import { AdminTopbar } from "../../../_components/AdminShell";

// MA-120 인프라 · 비용(GET /api/admin/infra/{status,cost,connections}, PUT …/prices·connections/{key}/expiry). 최고관리자만(infra.manage, 메뉴·셸이 막음).
// 정본: design/project/MA-120.dc.html(FINAL v308). 서버가 직접 재서 1분마다 보고하고 화면은 1분마다 자동 새로고침한다. 못 잰 값(null)과 아직 연결 안 된 값은 지어내지 않고 「측정 전」「준비 중」.
type Used = { totalBytes: number | null; usedBytes: number | null; usedPct: number | null };
type Snap = {
  takenAt: string;
  instance: string;
  disk: Used;
  memory: Used;
  cpu: { count: number | null; load1: number | null; usedPct: number | null };
  db: { sizeBytes: number | null; connections: number | null; maxConnections: number | null; connectionsPct: number | null };
  backup: { lastAt: string | null; count: number | null; totalBytes: number | null };
};
type Signal = { key: "disk" | "memory" | "cpu" | "dbConnections" | "backupStale"; level: "warning" | "critical"; value: number; threshold: number };
type Status = { checkedAt: string; thresholds: { warnPct: number; criticalPct: number; backupMaxAgeHours: number }; current: Snap; signals: Signal[]; snapshots: Snap[] };
type CostItem = { key: string; kind: "fixed" | "usage"; status: "estimated" | "no_price" | "not_measured"; unitPrice: number | null; usage: { value: number; unit: string } | null; accruedWon: number | null; projectedWon: number | null };
type Limited = { key: string; usedWon: number; limitWon: number; stopped: boolean; stoppedAt: string | null };
type Cost = { checkedAt: string; month: string; prices: Record<string, number>; priceVersion: number; items: CostItem[]; limited: Limited[]; totals: { accruedWon: number; projectedWon: number } };
type Conn = { key: string; name: string; purpose: string; expiresOn: string | null; daysLeft: number | null; lastOkAt: string | null; lastAuthErrorAt: string | null; lastAuthErrorCode: string | null; status: "ok" | "expiring" | "auth_error" | "not_connected"; version: number };
type Data = { status: Status; cost: Cost; conns: Conn[] };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; data: Data; at: Date };

const REFRESH_MS = 60_000;
const GIB = 1024 ** 3;
const gib = (b: number | null) => (b === null ? "-" : `${Math.round((b / GIB) * 10) / 10}`);
const won = (n: number | null) => (n === null ? "-" : `${n.toLocaleString("ko-KR")}원`);
const pctText = (n: number | null) => (n === null ? "측정 전" : `${n}%`);
const LEVEL = { ok: { label: "정상", cls: "b-done" }, warn: { label: "경고", cls: "b-warn" }, crit: { label: "위험", cls: "b-fail" }, lost: { label: "수집 실패", cls: "b-gray" } } as const;
const levelOf = (st: Status, ...v: (number | null)[]): keyof typeof LEVEL => {
  const m = Math.max(...v.map((x) => x ?? 0));
  return m >= st.thresholds.criticalPct ? "crit" : m >= st.thresholds.warnPct ? "warn" : "ok";
};
const SIGNAL_TEXT: Record<Signal["key"], string> = { disk: "디스크", memory: "메모리", cpu: "CPU", dbConnections: "DB 연결", backupStale: "백업" };
const SIGNAL_NOTE: Record<Signal["key"], string> = {
  disk: "디스크 기준 초과 · 오래된 로그 · 임시 파일 정리 또는 디스크 증설(승인 필요)",
  memory: "메모리 기준 초과 · 사용량이 큰 작업을 확인해 주십시오",
  cpu: "CPU 기준 초과 · 실시간 감시(MA-100)에서 접속 상태를 확인해 주십시오",
  dbConnections: "DB 연결 기준 초과 · 오래 걸리는 쿼리를 확인해 주십시오",
  backupStale: "마지막 백업이 오래됐습니다 · 백업 작업을 확인해 주십시오",
};
const CONN_STATUS = { ok: { label: "정상", cls: "b-done" }, expiring: { label: "만료 임박", cls: "b-warn" }, auth_error: { label: "인증 오류", cls: "b-fail" }, not_connected: { label: "연결 전", cls: "b-gray" } } as const;
const COST_NAME: Record<string, string> = { server: "서버 (카카오클라우드)", disk: "데이터 디스크", publicIp: "공인 IP", storage: "오브젝트 저장소", traffic: "트래픽", mail: "메일 발송", sms: "문자", alimtalk: "알림톡", pgFee: "결제대행사 수수료" };
const LIMITED_NAME = (k: string) => (k === "assistant" ? "도우미(Gemini)" : k.startsWith("externalApi:") ? `자동 연결 · ${k.slice(12)}` : k);
const COST_STATUS = { estimated: "추정", no_price: "단가 미입력", not_measured: "측정 전" } as const;
const USAGE_UNIT: Record<string, string> = { count: "건", won: "원" };
// 단가 입력 칸(정본 「단가 입력」): 서버가 받는 키와 단위
const PRICE_FIELDS: { key: string; label: string; unit: string; pct?: boolean }[] = [
  { key: "serverMonthlyWon", label: "서버 (월 1대)", unit: "원 / 월 · 대" },
  { key: "diskMonthlyWon", label: "데이터 디스크", unit: "원 / 월" },
  { key: "publicIpMonthlyWon", label: "공인 IP", unit: "원 / 개 · 월" },
  { key: "storageWonPerGbMonth", label: "오브젝트 저장소", unit: "원 / GiB · 월" },
  { key: "trafficWonPerGb", label: "트래픽", unit: "원 / GiB · 기본 제공 30 GiB 초과분" },
  { key: "mailWonEach", label: "메일", unit: "원 / 건" },
  { key: "smsWonEach", label: "문자", unit: "원 / 건" },
  { key: "alimtalkWonEach", label: "알림톡", unit: "원 / 건" },
  { key: "pgFeeRatePct", label: "결제대행사 수수료", unit: "% · 결제액 기준", pct: true },
];

function Bar({ pct, level }: { pct: number | null; level: keyof typeof LEVEL }) {
  return (
    <span className="row" style={{ gap: 8, flexWrap: "nowrap", justifyContent: "center" }}>
      <span style={{ width: 90, height: 8, borderRadius: 4, background: "var(--wds-fill-normal, #eee)", overflow: "hidden", display: "inline-block" }} aria-hidden="true">
        <i style={{ display: "block", height: "100%", width: `${Math.min(100, pct ?? 0)}%`, background: level === "crit" ? "var(--neg-text, #c0262c)" : level === "warn" ? "var(--cau-text, #b25e00)" : "var(--wds-primary-normal, #0f766e)" }} />
      </span>
      <span>{pctText(pct)}</span>
    </span>
  );
}

export default function InfraPage() {
  const { confirm } = useConfirm();
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [expiry, setExpiry] = useState<Record<string, string>>({});
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const [savingExpiry, setSavingExpiry] = useState(false);
  const reqId = useRef(0);
  const dirty = useRef(false);

  const load = useCallback(async (silent: boolean) => {
    const id = ++reqId.current;
    if (!silent) setState({ kind: "loading" });
    else setRefreshing(true);
    const [st, co, cn] = await Promise.all([
      adminApi<Status>("/api/admin/infra/status"),
      adminApi<Cost>("/api/admin/infra/cost"),
      adminApi<{ connections: Conn[] }>("/api/admin/infra/connections"),
    ]);
    if (id !== reqId.current) return;
    setRefreshing(false);
    if (!st.ok || !co.ok || !cn.ok) {
      if (!silent) setState({ kind: "error" });
      return;
    }
    // 입력 중인 값은 자동 새로고침이 덮어쓰지 않는다
    if (!dirty.current) {
      setExpiry(Object.fromEntries(cn.data.connections.map((c) => [c.key, c.expiresOn ?? ""])));
      setPrices(Object.fromEntries(PRICE_FIELDS.map((f) => [f.key, co.data.prices[f.key] === undefined ? "" : String(co.data.prices[f.key])])));
    }
    setState({ kind: "ok", data: { status: st.data, cost: co.data, conns: cn.data.connections }, at: new Date() });
  }, []);
  useEffect(() => {
    void load(false);
    const t = setInterval(() => void load(true), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const data = state.kind === "ok" ? state.data : null;

  const saveExpiry = async () => {
    if (!data) return;
    const changed = data.conns.filter((c) => (expiry[c.key] ?? "") !== (c.expiresOn ?? ""));
    if (changed.length === 0) return;
    setSavingExpiry(true);
    let failed = "";
    for (const c of changed) {
      const r = await adminApi(`/api/admin/infra/connections/${encodeURIComponent(c.key)}/expiry`, { method: "PUT", json: { expiresOn: expiry[c.key] || null, expectedVersion: c.version } });
      if (!r.ok) {
        failed = r.status === 409 ? `${c.name}: 다른 곳에서 먼저 바뀌었습니다. 새로 불러옵니다.` : `${c.name}: ${failMessage(r, "저장하지 못했습니다.")}`;
        break;
      }
    }
    setSavingExpiry(false);
    dirty.current = false;
    setToast(failed ? { text: failed, neg: true } : { text: "만료일을 저장했습니다 · 로그 추적에 남겼습니다" });
    void load(true);
  };

  const savePrices = async () => {
    if (!data) return;
    const current = data.cost.prices;
    const changes = PRICE_FIELDS.filter((f) => (prices[f.key] ?? "") !== (current[f.key] === undefined ? "" : String(current[f.key])));
    if (changes.length === 0) return;
    const bad = changes.find((f) => prices[f.key] !== "" && !(Number(prices[f.key]) >= 0 && Number.isFinite(Number(prices[f.key]))));
    if (bad) return setToast({ text: `${bad.label} 단가는 0 이상의 숫자로 입력해 주십시오.`, neg: true });
    const values = Object.fromEntries(changes.map((f) => [f.key, prices[f.key] === "" ? null : Number(prices[f.key])]));
    const ok = await confirm({
      title: "단가를 저장하시겠습니까?",
      body: `${changes.map((f) => `${f.label} ${current[f.key] === undefined ? "미입력" : current[f.key]} → ${prices[f.key] === "" ? "지움" : prices[f.key]}`).join(" · ")}. 이번 달 추정 금액이 다시 계산됩니다. 로그 추적에 남습니다.`,
      confirmLabel: "저장",
      run: async () => {
        const r = await adminApi("/api/admin/infra/prices", { method: "PUT", json: { expectedVersion: data.cost.priceVersion, prices: values } });
        if (!r.ok) return r.status === 409 ? "다른 곳에서 먼저 바뀌었습니다. 새로 불러온 뒤 다시 입력해 주십시오." : failMessage(r, "단가를 저장하지 못했습니다. 입력한 값을 확인해 주십시오.");
        return undefined;
      },
    });
    if (!ok) return void load(true);
    dirty.current = false;
    setToast({ text: "단가를 저장했습니다 · 로그 추적에 남겼습니다" });
    void load(true);
  };

  // 서버별 최신 값: 지금 잰 이 서버 + 같은 DB에 스냅숏을 남긴 다른 서버의 마지막 값(스냅숏은 시간별이라 3시간 넘게 없으면 수집 실패)
  const servers = (() => {
    if (!data) return [];
    const rows = new Map<string, Snap>();
    for (const s of data.status.snapshots) rows.set(s.instance, s);
    rows.set(data.status.current.instance, data.status.current);
    return [...rows.values()];
  })();
  const now = data ? new Date(data.status.checkedAt).getTime() : 0;
  const signals = data?.status.signals ?? [];
  const connWarn = data?.conns.filter((c) => c.status === "expiring" || c.status === "auth_error") ?? [];
  const limitStopped = data?.cost.limited.filter((l) => l.stopped) ?? [];
  const critical = signals.filter((s) => s.level === "critical").length + connWarn.filter((c) => c.status === "auth_error" || (c.daysLeft !== null && c.daysLeft <= 7)).length;
  const warning = signals.filter((s) => s.level === "warning").length + limitStopped.length + connWarn.length - (critical - signals.filter((s) => s.level === "critical").length);
  const cur = data?.status.current;
  const diskLevel = data && cur ? levelOf(data.status, cur.disk.usedPct) : "ok";

  return (
    <>
      <AdminTopbar crumb="운영 › 인프라 · 비용" />
      <main className="main">
        <PageHead description="서버 용량과 사용 비용, 외부 연결의 만료·오류 상태를 확인합니다." title="인프라 · 비용" />
        {state.kind === "loading" && <LoadingRows rows={5} />}
        {state.kind === "error" && <ErrorState title="불러오지 못했습니다." onRetry={() => void load(false)} />}
        {data && cur && state.kind === "ok" && (
          <div className="col" style={{ gap: 24 }}>
            <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
              <span className="t-l2 c-alt" data-testid="infra-refreshed">
                마지막 갱신 {formatDateTime(state.at)} · 1분마다 자동 새로고침
              </span>
              <button className="btn btn-sm btn-out" type="button" onClick={() => void load(true)} disabled={refreshing}>
                {refreshing ? "새로고침 중" : "지금 새로고침"}
              </button>
              <span className="t-c1 c-alt">최고관리자만 볼 수 있습니다 · 조회 전용 · 각 서버가 스스로 재서 보고합니다(외부 유료 감시 서비스 없음) · 기준을 넘으면 홈 「오늘 처리할 일」과 알림에 올라갑니다</span>
            </div>

            <div className={`note ${critical > 0 ? "neg" : warning > 0 ? "cau" : "pos"}`} data-testid="infra-status">
              <b>{critical + warning === 0 ? "정상" : `${critical > 0 ? `긴급 ${critical}` : ""}${critical > 0 && warning > 0 ? " · " : ""}${warning > 0 ? `경고 ${warning}` : ""}`}</b>{" "}
              {critical + warning === 0
                ? "모든 항목이 기준 아래입니다 · 홈 「오늘 처리할 일」에 올라가지 않습니다"
                : [
                    ...signals.map((s) => `${SIGNAL_TEXT[s.key]} ${s.value}${s.key === "backupStale" ? "시간" : "%"}`),
                    ...connWarn.map((c) => `${c.name} ${c.status === "auth_error" ? "인증 오류" : `만료 ${c.daysLeft}일 남음`}`),
                    ...limitStopped.map((l) => `${LIMITED_NAME(l.key)} 한도 도달`),
                  ].join(" · ")}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }} data-testid="infra-kpi">
              <div className="card" style={{ padding: 16 }}>
                <div className="t-c1 c-alt">{cur.instance} 디스크</div>
                <div className={`t-h2 fw6 ${diskLevel === "crit" ? "c-neg" : diskLevel === "warn" ? "c-cau" : ""}`}>{pctText(cur.disk.usedPct)}</div>
                <div className="t-c1 c-alt">{diskLevel === "ok" ? "기준 아래" : `기준 ${data.status.thresholds.warnPct}% 초과`}</div>
              </div>
              <div className="card" style={{ padding: 16 }}>
                <div className="t-c1 c-alt">DB 크기 · 연결</div>
                <div className="t-h2 fw6">{cur.db.sizeBytes === null ? "측정 전" : `${gib(cur.db.sizeBytes)} GiB`}</div>
                <div className="t-c1 c-alt">{cur.db.connections === null ? "연결 수 측정 전" : `연결 ${cur.db.connections} / ${cur.db.maxConnections ?? "-"}`}</div>
              </div>
              <div className="card" style={{ padding: 16 }}>
                <div className="t-c1 c-alt">마지막 백업</div>
                <div className="t-h2 fw6">{cur.backup.lastAt ? formatDateTime(cur.backup.lastAt).slice(11) : "측정 전"}</div>
                <div className="t-c1 c-alt">{cur.backup.lastAt ? formatDate(cur.backup.lastAt) : "백업 폴더를 읽을 수 없습니다"}</div>
              </div>
              <div className="card" style={{ padding: 16 }}>
                <div className="t-c1 c-alt">이번 달 누적 요금</div>
                <div className="t-h2 fw6">{won(data.cost.totals.accruedWon)}</div>
                <div className="t-c1 c-alt">추정 · {data.cost.month}</div>
              </div>
              <div className="card" style={{ padding: 16 }}>
                <div className="t-c1 c-alt">월말 예상</div>
                <div className="t-h2 fw6">{won(data.cost.totals.projectedWon)}</div>
                <div className="t-c1 c-alt">승인 월 비용 약 5만 원대 + 부가세 · 트래픽</div>
              </div>
            </div>

            <section className="card" aria-labelledby="infra-cap">
              <div style={{ padding: "12px 16px" }}>
                <h2 className="t-hl1" id="infra-cap">용량 · 서버</h2>
                <span className="t-c1 c-alt">디스크 {data.status.thresholds.warnPct}% · 메모리 {data.status.thresholds.warnPct}% · CPU(1분 부하) {data.status.thresholds.warnPct}% · DB 연결 {data.status.thresholds.warnPct}%를 넘으면 경고, {data.status.thresholds.criticalPct}%를 넘으면 위험</span>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                  <thead>
                    <tr>
                      <th>서버</th>
                      <th>디스크</th>
                      <th>메모리</th>
                      <th>CPU (1분 부하)</th>
                      <th>상태</th>
                      <th>마지막 보고</th>
                      <th>비고</th>
                    </tr>
                  </thead>
                  <tbody>
                    {servers.map((s) => {
                      const isCur = s.instance === cur.instance;
                      const lost = !isCur && now - new Date(s.takenAt).getTime() > 3 * 3_600_000;
                      const lv = lost ? "lost" : levelOf(data.status, s.disk.usedPct, s.memory.usedPct, s.cpu.usedPct);
                      return (
                        <tr key={s.instance} data-testid="infra-server-row">
                          <td className="col-text">
                            <b>{s.instance}</b>
                            {s.cpu.count !== null && <span className="t-c1 c-alt" style={{ display: "block" }}>{s.cpu.count}vCPU · 디스크 {gib(s.disk.totalBytes)} GiB</span>}
                          </td>
                          <td>
                            <Bar pct={lost ? null : s.disk.usedPct} level={levelOf(data.status, s.disk.usedPct)} />
                            <span className="t-c1 c-alt" style={{ display: "block" }}>{gib(s.disk.usedBytes)} / {gib(s.disk.totalBytes)} GiB</span>
                          </td>
                          <td>
                            <Bar pct={lost ? null : s.memory.usedPct} level={levelOf(data.status, s.memory.usedPct)} />
                            <span className="t-c1 c-alt" style={{ display: "block" }}>{gib(s.memory.usedBytes)} / {gib(s.memory.totalBytes)} GiB</span>
                          </td>
                          <td><Bar pct={lost ? null : s.cpu.usedPct} level={levelOf(data.status, s.cpu.usedPct)} /></td>
                          <td><span className={`bdg ${LEVEL[lv].cls}`}>{LEVEL[lv].label}</span></td>
                          <td className="num">{isCur ? formatDateTime(data.status.checkedAt) : formatDateTime(s.takenAt)}</td>
                          <td className="col-text">{lost ? "보고가 3시간 넘게 없습니다 · 서버가 멈췄거나 보고 작업이 죽었을 수 있습니다" : isCur ? data.status.signals.filter((g) => g.key !== "dbConnections" && g.key !== "backupStale").map((g) => SIGNAL_NOTE[g.key]).join(" · ") || "-" : "-"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 24, alignItems: "start" }}>
              <section className="card" aria-labelledby="infra-db" style={{ padding: 16 }}>
                <h2 className="t-hl1" id="infra-db">데이터베이스 · 백업</h2>
                <dl className="col" style={{ gap: 10, margin: "12px 0 0" }}>
                  <div className="row" style={{ gap: 8 }}><dt className="c-alt" style={{ width: 120 }}>DB 크기</dt><dd style={{ margin: 0 }}>{cur.db.sizeBytes === null ? "측정 전" : `${gib(cur.db.sizeBytes)} GiB`}{cur.db.sizeBytes !== null && cur.disk.totalBytes ? ` · 디스크의 ${Math.round((cur.db.sizeBytes / cur.disk.totalBytes) * 100)}%` : ""}</dd></div>
                  <div className="row" style={{ gap: 8 }}><dt className="c-alt" style={{ width: 120 }}>연결 수</dt><dd style={{ margin: 0 }}><Bar pct={cur.db.connectionsPct} level={levelOf(data.status, cur.db.connectionsPct)} />{cur.db.connections !== null && <span className="t-c1 c-alt"> {cur.db.connections} / 최대 {cur.db.maxConnections ?? "-"}</span>}</dd></div>
                  <div className="row" style={{ gap: 8 }}><dt className="c-alt" style={{ width: 120 }}>가장 오래 걸린 쿼리</dt><dd style={{ margin: 0 }} className="c-alt">준비 중</dd></div>
                  <div className="row" style={{ gap: 8 }}><dt className="c-alt" style={{ width: 120 }}>마지막 백업</dt><dd style={{ margin: 0 }}>{cur.backup.lastAt ? `${formatDateTime(cur.backup.lastAt)}` : "측정 전 · 백업 폴더를 읽을 수 없습니다"}</dd></div>
                  <div className="row" style={{ gap: 8 }}><dt className="c-alt" style={{ width: 120 }}>백업 보관</dt><dd style={{ margin: 0 }}>{cur.backup.count === null ? "측정 전" : `${cur.backup.count}개 · 보관 용량 ${gib(cur.backup.totalBytes)} GiB`}</dd></div>
                </dl>
              </section>
              <section className="card" aria-labelledby="infra-obj" style={{ padding: 16 }}>
                <h2 className="t-hl1" id="infra-obj">오브젝트 저장소</h2>
                <dl className="col" style={{ gap: 10, margin: "12px 0 0" }}>
                  <div className="row" style={{ gap: 8 }}><dt className="c-alt" style={{ width: 120 }}>사용량</dt><dd style={{ margin: 0 }} className="c-alt">준비 중</dd></div>
                  <div className="row" style={{ gap: 8 }}><dt className="c-alt" style={{ width: 120 }}>무엇이 차지하나</dt><dd style={{ margin: 0 }} className="c-alt">준비 중</dd></div>
                  <div className="row" style={{ gap: 8 }}><dt className="c-alt" style={{ width: 120 }}>이번 달 트래픽</dt><dd style={{ margin: 0 }} className="c-alt">준비 중</dd></div>
                </dl>
              </section>
            </div>

            <section className="card" aria-labelledby="infra-conn">
              <div style={{ padding: "12px 16px" }}>
                <h2 className="t-hl1" id="infra-conn">외부 연결 · 만료 · 상태</h2>
                <span className="t-c1 c-alt">키 값은 보이지 않습니다 · 만료일은 최고관리자가 발급 화면의 날짜를 적습니다 · 만료 30일 전 · 7일 전 · 인증 오류는 홈 요약 카드와 알림에 올라갑니다</span>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                  <thead>
                    <tr>
                      <th>연결</th>
                      <th>용도</th>
                      <th>만료일</th>
                      <th>남은 일수</th>
                      <th>마지막 정상 호출</th>
                      <th>상태</th>
                      <th>비고</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.conns.map((c) => (
                      <tr key={c.key} data-testid="infra-conn-row">
                        <td className="col-text"><b>{c.name}</b></td>
                        <td className="col-text">{c.purpose}</td>
                        <td>
                          <input className="inp" type="date" aria-label={`${c.name} 만료일`} value={expiry[c.key] ?? ""} onChange={(e) => { dirty.current = true; setExpiry({ ...expiry, [c.key]: e.target.value }); }} />
                        </td>
                        <td className="num">{c.daysLeft === null ? "—" : `${c.daysLeft}일`}</td>
                        <td className="num">{c.lastOkAt ? formatDateTime(c.lastOkAt) : "—"}</td>
                        <td><span className={`bdg ${CONN_STATUS[c.status].cls}`}>{CONN_STATUS[c.status].label}</span></td>
                        <td className="col-text">{c.status === "auth_error" && c.lastAuthErrorAt ? `${formatDateTime(c.lastAuthErrorAt)}부터 인증 실패${c.lastAuthErrorCode ? ` (${c.lastAuthErrorCode})` : ""}` : c.status === "not_connected" ? "연결 전" : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row" style={{ gap: 8, padding: "12px 16px" }}>
                <button className="btn" type="button" onClick={() => void saveExpiry()} disabled={savingExpiry || data.conns.every((c) => (expiry[c.key] ?? "") === (c.expiresOn ?? ""))}>
                  {savingExpiry ? "저장 중" : "만료일 저장"}
                </button>
                <span className="t-c1 c-alt">만료일을 바꾸면 로그 추적에 남습니다 · 남은 일수는 매일 00:00 다시 계산</span>
              </div>
            </section>

            <section className="card" aria-labelledby="infra-cost">
              <div style={{ padding: "12px 16px" }}>
                <h2 className="t-hl1" id="infra-cost">요금 · {data.cost.month}</h2>
                <span className="t-c1 c-alt">「추정」 = 마스터가 적은 단가 × 우리가 센 사용량 · 「실제」 = 카카오클라우드 청구 조회(API 키 발급 뒤) · 부가세 별도</span>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                  <thead>
                    <tr>
                      <th>항목</th>
                      <th>단가</th>
                      <th>사용량 (이번 달)</th>
                      <th>누적</th>
                      <th>월말 예상</th>
                      <th>구분</th>
                      <th>상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.cost.items.map((i) => (
                      <tr key={i.key} data-testid="infra-cost-row">
                        <td className="col-text"><b>{COST_NAME[i.key] ?? i.key}</b></td>
                        <td className="num">{i.unitPrice === null ? "단가 미입력" : i.key === "pgFee" ? `${i.unitPrice}%` : won(i.unitPrice)}</td>
                        <td className="num">{i.usage ? `${i.usage.value.toLocaleString("ko-KR")}${USAGE_UNIT[i.usage.unit] ?? i.usage.unit}` : i.kind === "fixed" ? "고정" : "측정 전"}</td>
                        <td className="num">{won(i.accruedWon)}</td>
                        <td className="num">{won(i.projectedWon)}</td>
                        <td>추정</td>
                        <td>{COST_STATUS[i.status]}</td>
                      </tr>
                    ))}
                    {data.cost.limited.map((l) => (
                      <tr key={l.key} data-testid="infra-cost-row">
                        <td className="col-text"><b>{LIMITED_NAME(l.key)}</b><span className="t-c1 c-alt" style={{ display: "block" }}>월 한도 기능</span></td>
                        <td className="num">-</td>
                        <td className="num">한도 {won(l.limitWon)}</td>
                        <td className="num">{won(l.usedWon)}</td>
                        <td className="num">{won(Math.min(l.limitWon, l.usedWon))}</td>
                        <td>실제</td>
                        <td>{l.stopped ? "한도 도달 · 자동 정지" : `${Math.round((l.usedWon / Math.max(1, l.limitWon)) * 100)}% 사용`}</td>
                      </tr>
                    ))}
                    <tr>
                      <td className="col-text"><b>합계</b></td>
                      <td />
                      <td />
                      <td className="num fw6">{won(data.cost.totals.accruedWon)}</td>
                      <td className="num fw6">{won(data.cost.totals.projectedWon)}</td>
                      <td />
                      <td className="col-text">승인 월 비용(약 5만 원대 · 부가세 · 트래픽 별도) 안</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div style={{ padding: "12px 16px" }}>
                <span className="t-c1 c-alt">실제 청구 금액은 카카오클라우드 청구 조회 API를 연결하면 「실제」로 바뀝니다 · API 키 발급은 대표님 조치 · 그 전까지는 한도 기능(도우미 · 자동 연결)을 뺀 전부 추정입니다</span>
              </div>
            </section>

            <section className="card" aria-labelledby="infra-price" style={{ padding: 16 }}>
              <h2 className="t-hl1" id="infra-price">단가 입력</h2>
              <span className="t-c1 c-alt">최고관리자만 · 공개 단가 기준으로 적습니다 · 바꾸면 추정 금액이 다시 계산되고 로그 추적에 남습니다</span>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12, margin: "12px 0" }}>
                {PRICE_FIELDS.map((f) => (
                  <label key={f.key} className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                    <span style={{ width: 130 }}>{f.label}</span>
                    <input className="inp" style={{ width: 120 }} type="number" min={0} step={f.pct ? 0.01 : 1} inputMode="decimal" aria-label={`${f.label} 단가`} value={prices[f.key] ?? ""} onChange={(e) => { dirty.current = true; setPrices({ ...prices, [f.key]: e.target.value }); }} />
                    <span className="t-c1 c-alt">{f.unit}</span>
                  </label>
                ))}
                <div className="row" style={{ gap: 8 }}>
                  <span style={{ width: 130 }}>월 한도 기능</span>
                  <span className="c-alt">준비 중 · 도우미 한도는 설정 › 도우미 설정에서 바꿉니다</span>
                </div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn" type="button" onClick={() => void savePrices()}>
                  저장
                </button>
                <Link className="btn btn-out" href="/admin/logs">
                  변경 이력
                </Link>
                <span className="t-c1 c-alt">발송 단가(MA-086)와 같은 값이 아니라 이 화면의 추정용 단가입니다</span>
              </div>
            </section>
          </div>
        )}
      </main>
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
