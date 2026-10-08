"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { PageHead, SearchBox, SearchRow } from "../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../components/seller/States";
import { adminApi } from "../../_components/api";
import { useListFilters } from "../../_components/useListFilters";
import { useScrollRestore } from "../../../../../lib/client/navigation";
import { AdminTopbar } from "../../_components/AdminShell";
import { ACTION_GROUPS, ACTOR_LABEL, actionLabel, targetLabel, type ActorType, type AuditRow } from "../../_components/auditLogs";
import { dayTime } from "../../_components/partners";
import { DatePicker } from "../../../../../components/admin-ui/DatePicker";

// MA-070 로그 추적(GET /api/admin/audit-logs, 최고관리자·운영·조회 전용, 조회만). 종류·행위자·기간(KST 날짜) 필터, 파트너스 지정(?sellerId=).
// 50건씩 이어서 불러온다. 바뀐 값은 상세(MA-071)에서만 본다.
const PAGE = 50;
type Filters = { action: string; actorType: string; from: string; to: string; sellerId: string };
type Page = { logs: AuditRow[]; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; items: AuditRow[]; next: string | null };

function query(f: Filters, cursor?: string) {
  const p = new URLSearchParams({ limit: String(PAGE) });
  for (const k of ["action", "actorType", "from", "to", "sellerId"] as const) if (f[k]) p.set(k, f[k]);
  if (cursor) p.set("cursor", cursor);
  return p.toString();
}

function Logs() {
  const empty: Filters = { action: "", actorType: "", from: "", to: "", sellerId: "" };
  const { applied, draft, setDraft, apply } = useListFilters<Filters>(empty);
  const [rangeError, setRangeError] = useState(false);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // 조건을 빨리 바꾸면 이전 응답이 늦게 올 수 있다. 마지막으로 보낸 조건의 응답만 반영한다
  const reqId = useRef(0);
  const load = useCallback(async (f: Filters) => {
    const id = ++reqId.current;
    setMore(false);
    setState({ kind: "loading" });
    const r = await adminApi<Page>(`/api/admin/audit-logs?${query(f)}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", items: r.data.logs, next: r.data.nextCursor } : { kind: "error" });
  }, []);
  useEffect(() => void load(applied), [applied, load]);
  useScrollRestore("admin-logs", state.kind === "ok");

  const search = () => {
    if (draft.from && draft.to && draft.from > draft.to) return setRangeError(true);
    setRangeError(false);
    apply(draft);
  };
  const reset = () => {
    setRangeError(false);
    apply({ ...empty, sellerId: applied.sellerId });
  };
  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    const id = reqId.current;
    const r = await adminApi<Page>(`/api/admin/audit-logs?${query(applied, state.next)}`);
    if (id !== reqId.current) return;
    setMore(false);
    if (r.ok) setState({ kind: "ok", items: [...state.items, ...r.data.logs], next: r.data.nextCursor });
    else setToast("더 불러오지 못했습니다. 다시 눌러 주십시오.");
  };

  const items = state.kind === "ok" ? state.items : [];
  const filtered = !!(applied.action || applied.actorType || applied.from || applied.to || applied.sellerId);

  return (
    <>
      <AdminTopbar crumb="관리자 › 로그 추적" />
      <main className="main">
        <PageHead title="로그 추적" />
        <SearchBox onSearch={search} onReset={reset} busy={state.kind === "loading"}>
          <SearchRow label="종류">
            <select className="inp" aria-label="종류" value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })}>
              <option value="">전체</option>
              {ACTION_GROUPS.map((g) => (
                <option key={g.prefix} value={g.prefix}>
                  {g.label}
                </option>
              ))}
            </select>
          </SearchRow>
          <SearchRow label="행위자">
            <select className="inp" aria-label="행위자" value={draft.actorType} onChange={(e) => setDraft({ ...draft, actorType: e.target.value })}>
              <option value="">전체</option>
              {(Object.keys(ACTOR_LABEL) as ActorType[]).map((a) => (
                <option key={a} value={a}>
                  {ACTOR_LABEL[a]}
                </option>
              ))}
            </select>
          </SearchRow>
          <SearchRow label="기록 기간">
            <DatePicker aria-label="기록 시작일" value={draft.from} onChange={(v) => setDraft({ ...draft, from: v })} />
            <span aria-hidden="true">~</span>
            <DatePicker aria-label="기록 종료일" value={draft.to} onChange={(v) => setDraft({ ...draft, to: v })} />
            {rangeError && (
              <span className="err" role="alert">
                시작일이 종료일보다 늦습니다.
              </span>
            )}
          </SearchRow>
        </SearchBox>
        {applied.sellerId && (
          <div className="row" style={{ gap: 8, margin: "8px 0" }}>
            <span className="t-l2 c-alt">한 파트너스의 기록만 보고 있습니다.</span>
            <button className="btn btn-sm btn-out" type="button" onClick={() => apply({ ...applied, sellerId: "" })}>
              전체 보기
            </button>
          </div>
        )}

        <div className="card">
          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" && <ErrorState title="로그를 불러오지 못했습니다." onRetry={() => void load(applied)} />}
          {state.kind === "ok" &&
            (items.length === 0 ? (
              <div className="st">
                <span className="t">{filtered ? "조건에 맞는 기록이 없습니다." : "아직 기록이 없습니다."}</span>
                {filtered && (
                  <button className="btn btn-sm btn-out" type="button" onClick={reset}>
                    조건 초기화
                  </button>
                )}
              </div>
            ) : (
              <>
                <div style={{ overflowX: "auto" }}>
                  <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                    <thead>
                      <tr>
                        <th>기록 시각</th>
                        <th>종류</th>
                        <th>행위자</th>
                        <th>대상</th>
                        <th>쇼핑몰</th>
                        <th>사유</th>
                        <th>IP</th>
                        <th>상세</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((l) => (
                        <tr key={l.id} data-testid="audit-row">
                          <td className="num">{dayTime(l.createdAt)}</td>
                          <td className="fw6">{actionLabel(l.action)}</td>
                          <td>{ACTOR_LABEL[l.actorType]}</td>
                          <td>{targetLabel(l.targetType)}</td>
                          <td>{l.seller ? <Link href={`/admin/partners/${l.seller.id}`}>{l.seller.shopName}</Link> : "-"}</td>
                          <td className="col-text" style={{ whiteSpace: "normal", maxWidth: 280 }}>{l.reason ?? "-"}</td>
                          <td>{l.ip ?? "-"}</td>
                          <td>
                            <Link className="btn btn-sm btn-out" href={`/admin/logs/${l.id}`}>
                              보기
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="row" style={{ justifyContent: "space-between", padding: "12px 16px" }}>
                  <span className="t-c1 c-alt">{state.next ? `${items.length}건 넘게` : `${items.length}건`}</span>
                  {state.next && (
                    <button className="btn btn-sm btn-out" type="button" onClick={() => void loadMore()} disabled={more}>
                      {more ? "불러오는 중" : "더 보기"}
                    </button>
                  )}
                </div>
              </>
            ))}
        </div>
      </main>
      {toast && <Toast text={toast} neg onDone={() => setToast(null)} />}
    </>
  );
}

export default function LogsPage() {
  return (
    <Suspense fallback={null}>
      <Logs />
    </Suspense>
  );
}
