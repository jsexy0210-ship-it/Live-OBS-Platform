"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead } from "../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../components/seller/States";
import { adminApi } from "../../_components/api";
import { AdminTopbar } from "../../_components/AdminShell";
import { dayTime } from "../../_components/partners";
import "./notifications.css";

type Status = "OPEN" | "IN_PROGRESS" | "RESOLVED";
type Severity = "URGENT" | "WARNING" | "INFO";
type Alert = { id: string; kind: string; severity: Severity; title: string; body: string | null; linkPath: string; shopName: string | null; occurredAt: string; assignee: { id: string; name: string | null } | null; status: Status; unread: boolean };
type Data = { items: Alert[]; counts: Record<Status, number>; unreadCount: number; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; data: Data };
const statuses: { value: Status; label: string }[] = [{ value: "OPEN", label: "미처리" }, { value: "IN_PROGRESS", label: "처리 중" }, { value: "RESOLVED", label: "해결됨" }];
const severities: { value: Severity; label: string }[] = [{ value: "URGENT", label: "긴급" }, { value: "WARNING", label: "주의" }, { value: "INFO", label: "정보" }];
const kindLabel = (kind: string) => ({ INQUIRY_URGENT: "긴급 문의", INFRA_ALERT: "인프라" })[kind] ?? kind.replaceAll("_", " ");

export default function AdminNotificationsPage() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [selectedStatus, setSelectedStatus] = useState<Status[]>(["OPEN", "IN_PROGRESS"]);
  const [selectedSeverity, setSelectedSeverity] = useState<Severity[]>(["URGENT", "WARNING", "INFO"]);
  const [kind, setKind] = useState("");
  const [seller, setSeller] = useState("");
  const [applied, setApplied] = useState({ statuses: ["OPEN", "IN_PROGRESS"] as Status[], severities: ["URGENT", "WARNING", "INFO"] as Severity[], kind: "", seller: "" });
  const [notice, setNotice] = useState("");
  const reqId = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    setState({ kind: "loading" });
    const r = await adminApi<Data>("/api/admin/alerts");
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error" });
  }, []);
  useEffect(() => void load(), [load]);

  const toggle = <T extends string,>(values: T[], value: T, set: (next: T[]) => void) => set(values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);
  const reset = () => {
    setSelectedStatus(["OPEN", "IN_PROGRESS"]); setSelectedSeverity(["URGENT", "WARNING", "INFO"]); setKind(""); setSeller("");
    setApplied({ statuses: ["OPEN", "IN_PROGRESS"], severities: ["URGENT", "WARNING", "INFO"], kind: "", seller: "" });
  };
  const markAll = async () => {
    const r = await adminApi<{ marked: number }>("/api/admin/alerts/read-all", { method: "POST" });
    setNotice(r.ok ? `${r.data.marked}건을 확인 처리했습니다.` : "확인 처리하지 못했습니다. 다시 시도해 주십시오.");
    if (r.ok) void load();
  };
  const d = state.kind === "ok" ? state.data : null;
  const rows = d?.items.filter((a) => applied.statuses.includes(a.status) && applied.severities.includes(a.severity) && (!applied.kind || a.kind === applied.kind) && (!applied.seller || (a.shopName ?? "").includes(applied.seller.trim()))) ?? [];
  const kinds = [...new Set(d?.items.map((a) => a.kind) ?? [])];
  return <>
    <AdminTopbar crumb="알림 센터" />
    <main className="main admin-notifications">
      <PageHead title="알림 센터" actions={<div className="row" style={{ gap: 8 }}><button className="btn btn-out" type="button" onClick={() => void markAll()} disabled={!d || d.unreadCount === 0}>모두 확인 처리</button><button className="btn btn-out" type="button" disabled title="알림 채널 설정 화면 준비 중">알림 채널 설정</button></div>} />
      {notice && <div className="msg msg-info" role="status">{notice}</div>}
      <section className="card pad notification-search" aria-label="알림 검색">
        <div className="notification-filter-group"><strong>상태</strong><div className="notification-checks">{statuses.map((s) => <label key={s.value}><input type="checkbox" checked={selectedStatus.includes(s.value)} onChange={() => toggle(selectedStatus, s.value, setSelectedStatus)} /> {s.label}</label>)}</div></div>
        <div className="notification-filter-group"><strong>심각도</strong><div className="notification-checks">{severities.map((s) => <label key={s.value}><input type="checkbox" checked={selectedSeverity.includes(s.value)} onChange={() => toggle(selectedSeverity, s.value, setSelectedSeverity)} /> {s.label}</label>)}</div></div>
        <label className="notification-filter-group"><strong>유형</strong><select className="inp" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">전체</option>{kinds.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}</select></label>
        <label className="notification-filter-group"><strong>파트너스 검색</strong><input className="inp" value={seller} onChange={(e) => setSeller(e.target.value)} placeholder="파트너스 이름" /></label>
        <div className="notification-search-actions"><button className="btn" type="button" onClick={() => setApplied({ statuses: selectedStatus, severities: selectedSeverity, kind, seller })}>검색</button><button className="btn btn-out" type="button" onClick={reset}>초기화</button></div>
      </section>
      <section className="card" aria-label="알림 목록">
        <div className="pad row between"><h2 className="t-hl1">알림 목록</h2><span className="t-c1 c-alt">{d ? `읽지 않은 알림 ${d.unreadCount.toLocaleString("ko-KR")}건 · 최근 ${d.items.length}건` : ""}</span></div>
        {state.kind === "loading" && <LoadingRows rows={5} />}
        {state.kind === "error" && <ErrorState title="알림을 불러오지 못했습니다." onRetry={() => void load()} />}
        {d && (rows.length === 0 ? <div className="st"><span className="t">{d.items.length ? "검색 조건에 맞는 알림이 없습니다." : "알림이 없습니다."}</span></div> : <div className="notification-table-scroll"><table className="tbl"><thead><tr><th>심각도</th><th>유형</th><th>파트너스</th><th>내용</th><th>발생 시각</th><th>담당자</th><th>상태</th><th>관리</th></tr></thead><tbody>{rows.map((a) => <tr key={a.id} data-testid="notification-row"><td>{severities.find((s) => s.value === a.severity)?.label}</td><td>{kindLabel(a.kind)}</td><td>{a.shopName ?? "공통"}</td><td className="notification-content"><strong>{a.title}</strong>{a.body && <small>{a.body}</small>}</td><td className="num">{dayTime(a.occurredAt)}</td><td>{a.assignee?.name ?? "미배정"}</td><td>{statuses.find((s) => s.value === a.status)?.label}</td><td><Link className="btn btn-sm btn-out" href={a.linkPath}>열기</Link></td></tr>)}</tbody></table></div>)}
        {d?.nextCursor && <p className="pad t-c1 c-alt">최근 50건만 표시됩니다. 추가 목록 검색은 준비 중입니다.</p>}
      </section>
      <div className="notification-bottom"><section className="card pad"><h2 className="t-hl1">알림 규칙</h2><p className="t-l2 c-alt">알림 발생 규칙과 채널 설정은 조회 화면 연결 준비 중입니다.</p></section><section className="card pad"><h2 className="t-hl1">오늘의 알림 추이</h2><p className="t-l2 c-alt">오늘 발생 건수 집계가 연결되지 않았습니다.</p></section></div>
    </main>
  </>;
}
