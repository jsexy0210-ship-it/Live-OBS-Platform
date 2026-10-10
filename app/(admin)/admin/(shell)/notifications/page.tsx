"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead } from "../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../components/seller/States";
import { adminApi } from "../../_components/api";
import { AdminTopbar, useAdmin } from "../../_components/AdminShell";
import { dayTime } from "../../_components/partners";
import { adminCan } from "../../../../../lib/server/authz/permissions";
import "./notifications.css";

type Status = "OPEN" | "IN_PROGRESS" | "RESOLVED";
type Severity = "URGENT" | "WARNING" | "INFO";
type Alert = { id: string; kind: string; severity: Severity; title: string; body: string | null; linkPath: string; shopName: string | null; occurredAt: string; assignee: { id: string; name: string | null } | null; status: Status; unread: boolean };
type Data = { items: Alert[]; counts: Record<Status, number>; unreadCount: number; nextCursor: string | null };
type Rule = { eventKey: string; label: string; severity: Severity };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; data: Data };
const statuses: { value: Status; label: string }[] = [{ value: "OPEN", label: "미처리" }, { value: "IN_PROGRESS", label: "처리 중" }, { value: "RESOLVED", label: "해결됨" }];
const severities: { value: Severity; label: string }[] = [{ value: "URGENT", label: "긴급" }, { value: "WARNING", label: "주의" }, { value: "INFO", label: "정보" }];
const summaryEventKeys = new Set(["broadcast_payment_fail_streak", "broadcast_overlay_reconnect_fail", "platform_outage", "payment_callback_stall", "reward_payout_failed", "subscription_payment_failed", "application_overdue_48h", "live_payout_switch_on"]);
const kindLabels: Record<string, string> = { INQUIRY_URGENT: "긴급 문의", INFRA_ALERT: "인프라" };
const kindLabel = (kind: string) => kindLabels[kind] ?? "기타";

export default function AdminNotificationsPage() {
  const { me } = useAdmin();
  const canAssign = adminCan(me.role, "support.assign");
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [changing, setChanging] = useState<string | null>(null);
  const [selectedStatus, setSelectedStatus] = useState<Status[]>(["OPEN", "IN_PROGRESS"]);
  const [selectedSeverity, setSelectedSeverity] = useState<Severity[]>(["URGENT", "WARNING", "INFO"]);
  const [kind, setKind] = useState("");
  const [seller, setSeller] = useState("");
  const [applied, setApplied] = useState({ statuses: ["OPEN", "IN_PROGRESS"] as Status[], severities: ["URGENT", "WARNING", "INFO"] as Severity[], kind: "", seller: "" });
  const [notice, setNotice] = useState("");
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [rulesError, setRulesError] = useState(false);
  const reqId = useRef(0);
  const load = useCallback(async (cursor?: string) => {
    const id = ++reqId.current;
    if (cursor) setLoadingMore(true);
    else setState({ kind: "loading" });
    const query = new URLSearchParams({ status: applied.statuses.join(","), severity: applied.severities.join(",") });
    if (applied.kind) query.set("kind", applied.kind);
    if (applied.seller.trim()) query.set("seller", applied.seller.trim());
    if (cursor) query.set("cursor", cursor);
    const r = await adminApi<Data>(`/api/admin/alerts?${query}`);
    if (id !== reqId.current) return;
    setLoadingMore(false);
    if (cursor && r.ok) setState((previous) => previous.kind === "ok" ? { kind: "ok", data: { ...r.data, items: [...previous.data.items, ...r.data.items] } } : { kind: "ok", data: r.data });
    else if (!cursor) setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error" });
    else setNotice("다음 알림을 불러오지 못했습니다. 다시 시도해 주십시오.");
  }, [applied]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    let active = true;
    void adminApi<{ routes: Rule[] }>("/api/admin/settings/notifications").then((result) => {
      if (!active) return;
      if (result.ok) setRules(result.data.routes);
      else setRulesError(true);
    });
    return () => { active = false; };
  }, []);

  const toggle = <T extends string,>(values: T[], value: T, set: (next: T[]) => void) => set(values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);
  const reset = () => {
    setSelectedStatus(["OPEN", "IN_PROGRESS"]); setSelectedSeverity(["URGENT", "WARNING", "INFO"]); setKind(""); setSeller("");
    setApplied({ statuses: ["OPEN", "IN_PROGRESS"], severities: ["URGENT", "WARNING", "INFO"], kind: "", seller: "" });
  };
  const markAll = async () => {
    const r = await adminApi<{ marked: number }>("/api/admin/alerts/read-all", { method: "POST" });
    setNotice(r.ok ? `${r.data.marked}건을 확인 처리했습니다.` : "확인 처리하지 못했습니다. 다시 시도해 주십시오.");
    if (r.ok) { window.dispatchEvent(new Event("admin-alerts-changed")); void load(); }
  };
  const changeStatus = async (alert: Alert, status: Status) => {
    setChanging(alert.id);
    const r = await adminApi<{ ok: true }>(`/api/admin/alerts/${alert.id}/status`, { method: "POST", json: { status } });
    setChanging(null);
    setNotice(r.ok ? "알림 상태를 변경했습니다." : "알림 상태를 변경하지 못했습니다. 다시 시도해 주십시오.");
    if (r.ok) { window.dispatchEvent(new Event("admin-alerts-changed")); void load(); }
  };
  const d = state.kind === "ok" ? state.data : null;
  const rows = d?.items ?? [];
  const kinds = [...new Set(["INQUIRY_URGENT", "INFRA_ALERT", ...(kind ? [kind] : []), ...(d?.items.map((a) => a.kind) ?? [])])];
  return <>
    <AdminTopbar crumb="알림 센터" />
    <main className="main admin-notifications">
      <PageHead title="알림 센터" />
      <p className="t-l2 c-alt">알림을 확인하고 담당자와 처리 상태를 관리합니다.</p>
      {!canAssign && <p className="msg msg-info">조회 전용 권한입니다. 상태와 담당자를 변경할 수 없습니다.</p>}
      {notice && <div className="msg msg-info" role="status">{notice}</div>}
      <section className="notification-search" aria-label="알림 검색">
        <div className="notification-filter-group"><strong>상태</strong><div className="notification-checks">{statuses.map((s) => <label key={s.value}><input type="checkbox" checked={selectedStatus.includes(s.value)} onChange={() => toggle(selectedStatus, s.value, setSelectedStatus)} /> {s.label}</label>)}</div></div>
        <div className="notification-filter-group"><strong>심각도</strong><div className="notification-checks">{severities.map((s) => <label key={s.value}><input type="checkbox" checked={selectedSeverity.includes(s.value)} onChange={() => toggle(selectedSeverity, s.value, setSelectedSeverity)} /> {s.label}</label>)}</div></div>
        <label className="notification-filter-group"><strong>유형</strong><select className="inp" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">전체</option>{kinds.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}</select></label>
        <label className="notification-filter-group"><strong>파트너스 검색</strong><input className="inp" value={seller} onChange={(e) => setSeller(e.target.value)} maxLength={80} placeholder="쇼핑몰 이름" /></label>
        <div className="notification-search-actions"><button className="btn" type="button" onClick={() => setApplied({ statuses: selectedStatus, severities: selectedSeverity, kind, seller })}>검색</button><button className="btn btn-out" type="button" onClick={reset}>초기화</button></div>
      </section>
      <p className="t-c1 c-alt">상태나 심각도를 선택하지 않으면 해당 조건 전체를 조회합니다.</p>
      <div className="notification-summary" aria-label="알림 상태 요약">{statuses.map((status) => <div key={status.value}><span>{status.label}</span><strong data-testid={`notification-count-${status.value}`}>{d ? `${d.counts[status.value].toLocaleString("ko-KR")}건` : "—"}</strong></div>)}</div>
      <section aria-label="알림 목록">
        <div className="row between notification-list-head"><h2 className="t-hl1">알림 목록</h2><button className="btn btn-out" type="button" onClick={() => void markAll()} disabled={!d || d.unreadCount === 0}>모두 확인 처리</button></div>
        <p className="t-c1 c-alt" data-testid="notification-count">{d ? `읽지 않은 알림 ${d.unreadCount.toLocaleString("ko-KR")}건 · 현재 ${d.items.length}건` : ""}</p>
        {state.kind === "loading" && <LoadingRows rows={5} />}
        {state.kind === "error" && <ErrorState title="알림을 불러오지 못했습니다." onRetry={() => void load()} />}
        {d && (rows.length === 0 ? <div className="st"><span className="t">검색 조건에 맞는 알림이 없습니다.</span></div> : <div className="notification-table-scroll"><table className="tbl"><thead><tr>{["심각도", "유형", "파트너스", "내용", "발생", "담당", "상태", "관리"].map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{rows.map((a) => <tr key={a.id} data-testid="notification-row"><td>{severities.find((s) => s.value === a.severity)?.label}</td><td>{kindLabel(a.kind)}</td><td>{a.shopName ?? "공통"}</td><td className="notification-content"><strong>{a.title}</strong>{a.body && <small>{a.body}</small>}</td><td className="num">{dayTime(a.occurredAt)}</td><td>{a.assignee?.name ?? "미배정"}</td><td>{statuses.find((s) => s.value === a.status)?.label}</td><td><Link className="btn btn-sm btn-out" href={a.linkPath}>열기</Link>{canAssign && <>{!a.assignee && <button className="btn btn-sm btn-out" type="button" disabled={changing === a.id} onClick={() => void changeStatus(a, "IN_PROGRESS")}>담당</button>}<select className="inp notification-status" aria-label={`${a.title} 상태 변경`} value={a.status} disabled={changing === a.id} onChange={(e) => void changeStatus(a, e.target.value as Status)}>{statuses.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}</select></>}</td></tr>)}</tbody></table></div>)}
        {d?.nextCursor && <div className="pad"><button className="btn btn-out" type="button" disabled={loadingMore} onClick={() => void load(d.nextCursor!)}>{loadingMore ? "불러오는 중" : "더 보기"}</button></div>}
      </section>
      <div className="notification-bottom">
        <section className="card pad"><h2 className="t-hl1">알림 규칙 요약</h2>
          {rules === null ? <p className="t-l2 c-alt">{rulesError ? "규칙을 불러오지 못했습니다." : "규칙을 불러오는 중입니다."}</p> :
            <div className="notification-table-scroll"><table className="tbl"><thead><tr><th scope="col">심각도</th><th scope="col">조건</th></tr></thead><tbody>{severities.map((severity) => <tr key={severity.value}><td>{severity.label}</td><td>{rules.filter((rule) => rule.severity === severity.value && summaryEventKeys.has(rule.eventKey)).map((rule) => <span className="notification-rule" key={rule.eventKey}>{rule.label}</span>)}</td></tr>)}</tbody></table></div>}
          {adminCan(me.role, "system.manage") && <Link href="/admin/settings/notifications">채널 · 수신자 설정</Link>}
          <p className="t-c1 c-alt">채널 라우팅 설정 기준입니다. 화면 알림 생성과 외부 발송은 일부 유형만 연결되어 있습니다.</p>
        </section>
        <section className="card pad"><h2 className="t-hl1">오늘 추이</h2><div className="notification-trends">{["결제 연결 오류", "방송 화면 끊김", "지급 실패", "구독 결제 실패"].map((label) => <div key={label}><span>{label}</span><strong>집계 준비 중</strong></div>)}</div></section>
      </div>
    </main>
  </>;
}
