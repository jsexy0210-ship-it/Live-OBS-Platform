"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useUrlState } from "../../../../../lib/client/navigation";
import { CursorPagination, FormRow, ListTable, Modal, PageHead } from "../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { Toast } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";
import { StateBox, errorText, kstText, stateKind } from "../banners/_shared/ui";
import "./member-grades.css";
import { DatePicker } from "../../../../../components/admin-ui/DatePicker";

// SA-044 회원 등급(파트너스 관리자, 회원 › 회원 등급). 등급 이름 · 승급 기준 금액, 산정 기준(기간 · 주기 · 강등), 지금 재산정, 회원 직접 조정(고정: 기간 · 사유), 최근 변경.
// 조회와 변경은 대표자 · 회원/적립금(MEMBER_POINTS) 권한 직원. 적립률은 적립 정책에서 정하고 여기서는 보기만 한다. API: /api/seller/member-grades.
type Cadence = "MONTHLY" | "WEEKLY" | "DAILY";
type Demotion = "STEP" | "IMMEDIATE" | "NONE";
type ShippingBenefit = "NONE" | "DISCOUNT" | "FREE";
type Grade = {
  id: string;
  displayName: string;
  sortOrder: number;
  minAmount: number;
  isBase: boolean;
  members: number;
  rewardCard: number | null;
  rewardBankTransfer: number | null;
  shippingBenefit: ShippingBenefit;
  shippingDiscount: number;
  promotionCouponId: string | null;
};
type Benefit = { id: string; shippingBenefit: ShippingBenefit; shippingDiscount: string; promotionCouponId: string };
type Change = { id: string; memberId: string; nickname: string; fromName: string; toName: string; reason: string; amount: number | null; createdAt: string };
type ListKey = "recent" | "locked" | "changes";
type History = { page: number; cursors: (string | undefined)[] };
const firstPage = (): History => ({ page: 1, cursors: [undefined] });
type Data = {
  recentNextCursor: string | null;
  lockedNextCursor: string | null;
  grades: Grade[];
  couponOptions: { id: string; name: string; usable: boolean }[];
  memberTotal: number;
  autoEnabled: boolean;
  windowMonths: number;
  cadence: Cadence;
  demotion: Demotion;
  lockedCount: number;
  lastRun: { key: string; promoted: number; demoted: number; ranAt: string } | null;
  nextRunAt: string;
  recent: { id: string; nickname: string; fromName: string; toName: string; reason: "AUTO_UP" | "AUTO_DOWN" | "MANUAL" | "GRADE_REMOVED"; amount: number | null; createdAt: string }[];
  locked: { memberId: string; nickname: string; gradeId: string; until: string | null; reason: string | null }[];
};
type Found = { id: string; broadcastNickname: string; grade: { id: string; displayName: string } };

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const REASON = { AUTO_UP: "자동 승급", AUTO_DOWN: "자동 강등", MANUAL: "직접 조정", GRADE_REMOVED: "등급 삭제로 이동" } as const;
const WINDOWS = [
  { v: 6, label: "최근 6개월 구매 금액" },
  { v: 3, label: "최근 3개월 구매 금액" },
  { v: 12, label: "최근 12개월 구매 금액" },
  { v: 0, label: "누적 구매 금액" },
];
const CADENCES: { v: Cadence; label: string }[] = [
  { v: "MONTHLY", label: "매월 1일" },
  { v: "WEEKLY", label: "매주 월요일" },
  { v: "DAILY", label: "매일" },
];
const DEMOTIONS: { v: Demotion; label: string }[] = [
  { v: "STEP", label: "기준 미달 시 한 단계씩" },
  { v: "IMMEDIATE", label: "기준 미달 시 바로" },
  { v: "NONE", label: "강등 없음 (올라가기만)" },
];
const SHIPPING: { v: ShippingBenefit; label: string }[] = [
  { v: "NONE", label: "없음" },
  { v: "DISCOUNT", label: "정액 할인" },
  { v: "FREE", label: "배송비 무료" },
];
// 혜택 저장 본문: 정액 할인이 아니면 금액은 보내지 않는다(서버가 0으로 둔다). 쿠폰을 비우면 연결을 푼다.
const benefitBody = (b: Benefit | undefined) =>
  b ? { shippingBenefit: b.shippingBenefit, ...(b.shippingBenefit === "DISCOUNT" ? { shippingDiscount: Number(b.shippingDiscount || 0) } : {}), promotionCouponId: b.promotionCouponId || null } : {};
const toBenefit = (g: Grade): Benefit => ({ id: g.id, shippingBenefit: g.shippingBenefit, shippingDiscount: g.shippingDiscount ? String(g.shippingDiscount) : "", promotionCouponId: g.promotionCouponId ?? "" });
const digits = (v: string) => v.replace(/[^0-9]/g, "");
const rate = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const windowText = (m: number) => (m === 0 ? "누적" : `최근 ${m}개월`);
const kstDay = (iso: string) => kstText(iso).slice(5, 10).replace(".", "/");

export default function MemberGradesPage() {
  const { can } = useSeller();
  const canEdit = can("MEMBER_POINTS");
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number; error?: string } | { kind: "ok"; data: Data }>({ kind: "loading" });
  const [editing, setEditing] = useState<{ grade: Grade; displayName: string; minAmount: string; benefit: Benefit } | null>(null);
  const [adding, setAdding] = useState<{ displayName: string; minAmount: string } | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [changes, setChanges] = useState<{ kind: "up" | "down"; rows: Change[]; nextCursor: string | null } | null>(null);
  const [history, setHistory] = useState<Record<ListKey, History>>({ recent: firstPage(), locked: firstPage(), changes: firstPage() });
  const readId = useRef(0), paging = useRef(false);
  const [auto, setAuto] = useState(false);
  const [windowMonths, setWindowMonths] = useState(6);
  const [cadence, setCadence] = useState<Cadence>("MONTHLY");
  const [demotion, setDemotion] = useState<Demotion>("STEP");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"recalc" | { grade: Grade } | null>(null);

  const load = useCallback(async () => {
    const id = ++readId.current;
    paging.current = false;
    setHistory({ recent: firstPage(), locked: firstPage(), changes: firstPage() });
    setChanges(null);
    const r = await api<Data>("/api/seller/member-grades");
    if (id !== readId.current) return;
    if (!r.ok) return setState({ kind: "error", status: r.status, error: r.error });
    setState({ kind: "ok", data: r.data });
    setAuto(r.data.autoEnabled);
    setWindowMonths(r.data.windowMonths);
    setCadence(r.data.cadence);
    setDemotion(r.data.demotion);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const data = state.kind === "ok" ? state.data : null;
  const run = async <T,>(path: string, method: string, body: unknown, done: (d: T) => string) => {
    setBusy(true);
    setFailure(null);
    const r = await api<T>(path, { method, body });
    setBusy(false);
    if (!r.ok) {
      setConfirm(null);
      const text = errorText(r, "저장하지 못했습니다. 잠시 뒤 다시 시도해 주십시오");
      if (editing || adding) setModalError(text);
      else setFailure(text);
      return false;
    }
    setConfirm(null);
    setEditing(null);
    setAdding(null);
    setModalError(null);
    setToast(done(r.data));
    await load();
    return true;
  };

  // 저장 본문: 산정 기준은 화면의 값, 등급은 저장된 값(수정 창에서 바꾼 등급만 덮어씀)
  const gradesBody = (g: Grade[], override?: { id: string; displayName: string; minAmount: number; benefit: Benefit }) =>
    g.map((x) => (override && override.id === x.id ? { id: x.id, displayName: override.displayName, minAmount: override.minAmount, ...benefitBody(override.benefit) } : { id: x.id, displayName: x.displayName, minAmount: x.minAmount, ...benefitBody(toBenefit(x)) }));
  const saveCriteria = () => data && void run("/api/seller/member-grades", "PUT", { autoEnabled: auto, windowMonths, cadence, demotion, grades: gradesBody(data.grades) }, () => "등급 설정을 저장했습니다");
  const resetCriteria = () => {
    if (!data) return;
    setAuto(data.autoEnabled);
    setWindowMonths(data.windowMonths);
    setCadence(data.cadence);
    setDemotion(data.demotion);
  };
  const saveGrade = () =>
    data && editing && void run("/api/seller/member-grades", "PUT", { autoEnabled: data.autoEnabled, windowMonths: data.windowMonths, cadence: data.cadence, demotion: data.demotion, grades: gradesBody(data.grades, { id: editing.grade.id, displayName: editing.displayName, minAmount: Number(editing.minAmount || 0), benefit: editing.benefit }) }, () => "등급 설정을 저장했습니다");
  const showChanges = async (kind: "up" | "down") => {
    if (paging.current) return;
    paging.current = true;
    const id = ++readId.current;
    const r = await api<{ changes: Change[]; nextCursor: string | null }>(`/api/seller/member-grades/changes?kind=${kind}`);
    if (id !== readId.current) return;
    paging.current = false;
    if (!r.ok) return setFailure(errorText(r, "변동 회원을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주십시오"));
    setHistory(h => ({ ...h, changes: firstPage() }));
    setChanges({ kind, rows: r.data.changes, nextCursor: r.data.nextCursor });
  };
  const turnList = async (key: ListKey, target: number) => {
    const h = history[key];
    if (!data || paging.current || target === h.page || target < 1 || target > h.cursors.length + 1) return;
    const next = key === "changes" ? changes?.nextCursor : key === "recent" ? data.recentNextCursor : data.lockedNextCursor;
    const cursor = target <= h.cursors.length ? h.cursors[target - 1] : next;
    if (target > 1 && !cursor) return;
    paging.current = true;
    const id = ++readId.current;
    if (key === "changes") {
      if (!changes) { paging.current = false; return; }
      const r = await api<{ changes: Change[]; nextCursor: string | null }>(`/api/seller/member-grades/changes?kind=${changes.kind}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (id !== readId.current) return;
      paging.current = false;
      if (!r.ok) return setFailure(errorText(r, "변동 회원을 불러오지 못했습니다"));
      setChanges({ kind: changes.kind, rows: r.data.changes, nextCursor: r.data.nextCursor });
    } else {
      const r = await api<Data>(`/api/seller/member-grades?${key}Cursor=${encodeURIComponent(cursor ?? "")}`);
      if (id !== readId.current) return;
      paging.current = false;
      if (!r.ok) return setFailure(errorText(r, "목록을 불러오지 못했습니다"));
      setState({ kind: "ok", data: { ...data, ...(key === "recent" ? { recent: r.data.recent, recentNextCursor: r.data.recentNextCursor } : { locked: r.data.locked, lockedNextCursor: r.data.lockedNextCursor }) } });
    }
    setHistory(all => ({ ...all, [key]: { page: target, cursors: target > h.cursors.length ? [...h.cursors, cursor ?? undefined] : h.cursors } }));
  };
  const listPager = (key: ListKey, next: string | null | undefined) => history[key].page > 1 || next ? <CursorPagination page={history[key].page} visited={history[key].cursors.length} hasNext={!!next} onChange={n => void turnList(key, n)} onNext={() => void turnList(key, history[key].page + 1)} /> : null;
  const add = () => adding && void run("/api/seller/member-grades", "POST", { displayName: adding.displayName, minAmount: Number(adding.minAmount || 0) }, () => "등급을 추가했습니다");

  return (
    <>
      <Topbar crumb="회원 › 회원 등급" />
      <main className="main">
        <PageHead
          title="회원 등급"
          actions={
            <>
              <Link className="btn btn-out" href="/seller/rewards">
                적립 정책
              </Link>
              <Link className="btn btn-out" href="/seller/coupons">
                쿠폰
              </Link>
            </>
          }
        />
        {state.kind === "loading" && <StateBox kind="loading" what="회원 등급" />}
        {state.kind === "error" && <StateBox kind={stateKind(state.status, state.error)} what="회원 등급" onRetry={() => void load()} />}
        {data && !canEdit && (
          <div className="msg msg-info" role="status">
            <span>보기만 할 수 있습니다. 등급 변경은 대표자나 회원 · 적립금 권한이 있는 직원에게 요청해 주십시오.</span>
          </div>
        )}
        {failure && (
          <div className="msg msg-neg" role="alert">
            <span>
              <b>저장할 수 없습니다.</b> {failure}
            </span>
          </div>
        )}
        {data && (
          <>
            <section className="card mg-sum" aria-label="요약">
              <div>
                <span className="t-l2 c-alt">회원</span>
                <b className="num">{data.memberTotal.toLocaleString("ko-KR")}명</b>
              </div>
              <div>
                <span className="t-l2 c-alt">다음 재산정</span>
                <b className="num">{data.autoEnabled ? kstText(data.nextRunAt) : "꺼짐"}</b>
              </div>
              <div>
                <span className="t-l2 c-alt">지난 재산정{data.lastRun ? ` (${data.lastRun.key})` : ""}</span>
                {data.lastRun ? (
                  <>
                    <button className="mg-link num" type="button" onClick={() => void showChanges("up")}>
                      승급 {data.lastRun.promoted}
                    </button>
                    <button className="mg-link mg-link-sub t-c1 num" type="button" onClick={() => void showChanges("down")}>
                      강등 {data.lastRun.demoted}
                    </button>
                  </>
                ) : (
                  <b className="num">없음</b>
                )}
              </div>
              <div>
                <span className="t-l2 c-alt">수동 고정</span>
                <b className="num">{data.lockedCount}명</b>
              </div>
            </section>

            <section className="mg-sec" aria-label="등급표">
              <div className="mg-sec-h">
                <h2 className="t-hl1">
                  등급표 <span className="t-l2 c-alt fw5">높은 등급부터 판정 · 하나만</span>
                </h2>
                {canEdit && (
                  <span className="row" style={{ gap: 8 }}>
                    <button className="btn btn-sm btn-out" type="button" disabled={busy} onClick={() => { setModalError(null); setAdding({ displayName: "", minAmount: "" }); }}>
                      등급 추가
                    </button>
                    <button className="btn btn-sm btn-out" type="button" disabled={busy} onClick={() => setConfirm("recalc")}>
                      지금 재산정
                    </button>
                  </span>
                )}
              </div>
              <ListTable aria-label="등급표">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>등급</th>
                      <th>기준</th>
                      <th>적립률</th>
                      <th>등급 쿠폰</th>
                      <th>배송비</th>
                      <th>회원 수</th>
                      {canEdit && <th>관리</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.grades].reverse().map((g, i) => (
                      <tr key={g.id} data-testid="grade-row">
                        <td>
                          <span className={`bdg nodot ${g.isBase || i >= 2 ? "b-gray" : i === 0 ? "b-info" : "b-warn"}`}>{g.displayName}</span>
                        </td>
                        <td className="col-text">{g.isBase ? "가입 즉시" : `${windowText(data.windowMonths)} ${won(g.minAmount)} 이상`}</td>
                        <td className="num">{g.rewardCard === null && g.rewardBankTransfer === null ? "—" : `카드 ${rate(g.rewardCard ?? 0)}% · 무통장 ${rate(g.rewardBankTransfer ?? 0)}%`}</td>
                        <td>{g.promotionCouponId ? (data.couponOptions.find((c) => c.id === g.promotionCouponId)?.name ?? "—") : "—"}</td>
                        <td>{g.shippingBenefit === "FREE" ? "항상 무료" : g.shippingBenefit === "DISCOUNT" ? `${won(g.shippingDiscount)} 할인` : "기본"}</td>
                        <td className="num">
                          {g.members.toLocaleString("ko-KR")} ({data.memberTotal > 0 ? ((g.members / data.memberTotal) * 100).toFixed(1) : "0.0"}%)
                        </td>
                        {canEdit && (
                          <td>
                            <button className="btn btn-sm btn-out" type="button" aria-label={`${g.displayName} 수정`} disabled={busy} onClick={() => { setModalError(null); setEditing({ grade: g, displayName: g.displayName, minAmount: String(g.minAmount), benefit: toBenefit(g) }); }}>
                              수정
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ListTable>
              <span className="t-c1 c-alt">적립률 수정은 적립 정책에서 · 등급 쿠폰은 쿠폰 관리의 「등급 달성 시 자동 지급」과 연결 · 등급은 10개까지</span>
            </section>

            <section className="mg-sec" aria-label="산정 기준">
              <div className="mg-sec-h">
                <h2 className="t-hl1">산정 기준</h2>
              </div>
              <table className="au-ft">
                <tbody>
                  <tr>
                    <th scope="row">
                      <label htmlFor="mg-window" className="req">
                        기준 금액
                      </label>
                    </th>
                    <td>
                      <div className="au-ft-v">
                        <select id="mg-window" className="inp" disabled={!canEdit} value={windowMonths} onChange={(e) => setWindowMonths(Number(e.target.value))}>
                          {WINDOWS.map((w) => (
                            <option key={w.v} value={w.v}>
                              {w.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <p className="help au-ft-help">취소 · 환불 · 반품 제외 · 적립금 사용분 제외</p>
                    </td>
                    <th scope="row">
                      <label htmlFor="mg-cadence" className="req">
                        재산정 주기
                      </label>
                    </th>
                    <td>
                      <div className="au-ft-v">
                        <select id="mg-cadence" className="inp" disabled={!canEdit} value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>
                          {CADENCES.map((c) => (
                            <option key={c.v} value={c.v}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">
                      <label htmlFor="mg-demotion">강등</label>
                    </th>
                    <td>
                      <div className="au-ft-v">
                        <select id="mg-demotion" className="inp" disabled={!canEdit} value={demotion} onChange={(e) => setDemotion(e.target.value as Demotion)}>
                          {DEMOTIONS.map((d) => (
                            <option key={d.v} value={d.v}>
                              {d.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </td>
                    <th scope="row">
                      <span id="mg-auto-label">자동 재산정</span>
                    </th>
                    <td>
                      <div className="au-ft-v">
                        <button className={`sw${auto ? " on" : ""}`} type="button" role="switch" aria-checked={auto} aria-labelledby="mg-auto-label" disabled={!canEdit} onClick={() => setAuto(!auto)} />
                      </div>
                      <p className="help au-ft-help">끄면 주기가 와도 재산정하지 않습니다 · 고정한 회원은 제외</p>
                    </td>
                  </tr>
                </tbody>
              </table>
              {canEdit && (
                <div className="au-ff">
                  <button className="btn btn-lg" type="button" disabled={busy} onClick={saveCriteria}>
                    {busy ? "저장 중" : "저장"}
                  </button>
                  <button className="btn btn-lg btn-out" type="button" disabled={busy} onClick={resetCriteria}>
                    취소
                  </button>
                </div>
              )}
            </section>

            {canEdit && <MemberAdjust data={data} pager={listPager("locked", data.lockedNextCursor)} />}

            {changes && (
              <section className="card" aria-label={changes.kind === "up" ? "승급 회원" : "강등 회원"} data-testid="grade-changes">
                <div className="row between" style={{ padding: "12px 16px" }}>
                  <span className="t-hl2">{changes.kind === "up" ? "승급 회원" : "강등 회원"} 현재 {changes.rows.length}명</span>
                  <button className="btn btn-sm btn-text" type="button" onClick={() => setChanges(null)}>
                    닫기
                  </button>
                </div>
                {changes.rows.length === 0 ? (
                  <div className="st" style={{ boxShadow: "none" }}>
                    <span className="t">해당하는 회원이 없습니다</span>
                  </div>
                ) : (
                  changes.rows.map((h) => (
                    <div key={h.id} className="mg-log" data-testid="grade-change-row">
                      <span>
                        {h.nickname} · {h.fromName} → {h.toName}
                      </span>
                      <span className="t-c1 c-alt num">{kstText(h.createdAt)}</span>
                    </div>
                  ))
                )}
                {listPager("changes", changes.nextCursor)}
              </section>
            )}

            <section className="card" aria-label="최근 변경">
              <div style={{ padding: "12px 16px" }}>
                <span className="t-hl2">최근 변경</span>
              </div>
              {data.recent.length === 0 ? (
                <div className="st" style={{ boxShadow: "none" }}>
                  <span className="t">등급 변경 기록이 없습니다</span>
                </div>
              ) : (
                data.recent.map((h) => (
                  <div key={h.id} className="mg-log" data-testid="grade-log">
                    <span className="col" style={{ gap: 2 }}>
                      <span>
                        {h.nickname} · {h.fromName} → {h.toName}
                      </span>
                      <span className="t-c1 c-alt">
                        {REASON[h.reason]}
                        {h.amount !== null ? ` · ${windowText(data.windowMonths)} ${won(h.amount)}` : ""}
                      </span>
                    </span>
                    <span className="t-c1 c-alt num">{kstText(h.createdAt)}</span>
                  </div>
                ))
              )}
              {listPager("recent", data.recentNextCursor)}
            </section>
          </>
        )}
      </main>
      {editing && data && (
        <Modal labelId="mg-edit-title" busy={busy} onClose={() => setEditing(null)}>
          <div className="modal-h">
            <h2 className="modal-t" id="mg-edit-title">
              등급 수정
            </h2>
          </div>
          <div className="modal-b col" style={{ gap: 12 }}>
            <table className="au-ft">
              <tbody>
                <FormRow label="등급 이름" required htmlFor="mg-edit-name">
                  <input id="mg-edit-name" className="inp" maxLength={12} value={editing.displayName} onChange={(e) => setEditing({ ...editing, displayName: e.target.value })} />
                </FormRow>
                <FormRow label="기준 금액" required htmlFor="mg-edit-amount">
                  <input id="mg-edit-amount" className="inp num" inputMode="numeric" disabled={editing.grade.isBase} value={editing.grade.isBase ? "0" : editing.minAmount} onChange={(e) => setEditing({ ...editing, minAmount: digits(e.target.value) })} />
                  <span className="t-l2">원 이상</span>
                </FormRow>
                <FormRow label="배송비 혜택" htmlFor="mg-edit-ship">
                  <select id="mg-edit-ship" className="inp" value={editing.benefit.shippingBenefit} onChange={(e) => setEditing({ ...editing, benefit: { ...editing.benefit, shippingBenefit: e.target.value as ShippingBenefit } })}>
                    {SHIPPING.map((o) => (
                      <option key={o.v} value={o.v}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </FormRow>
                <FormRow label="할인 금액" htmlFor="mg-edit-discount">
                  <input
                    id="mg-edit-discount"
                    className="inp num"
                    inputMode="numeric"
                    placeholder="0"
                    disabled={editing.benefit.shippingBenefit !== "DISCOUNT"}
                    value={editing.benefit.shippingBenefit === "DISCOUNT" ? editing.benefit.shippingDiscount : ""}
                    onChange={(e) => setEditing({ ...editing, benefit: { ...editing.benefit, shippingDiscount: digits(e.target.value) } })}
                  />
                  <span className="t-l2">원</span>
                </FormRow>
                <FormRow label="등급 쿠폰" htmlFor="mg-edit-coupon" help="승급할 때 한 번만 지급하고 같은 쿠폰은 다시 지급하지 않습니다">
                  <select id="mg-edit-coupon" className="inp" disabled={editing.grade.isBase} value={editing.benefit.promotionCouponId} onChange={(e) => setEditing({ ...editing, benefit: { ...editing.benefit, promotionCouponId: e.target.value } })}>
                    <option value="">없음</option>
                    {data.couponOptions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.usable ? "" : " (종료·중지)"}
                      </option>
                    ))}
                  </select>
                </FormRow>
              </tbody>
            </table>
            <div className="msg msg-info" role="note">
              <span>적립률은 적립 정책에서 등급별로 수정합니다. 여기서는 기준 · 쿠폰 · 배송비 혜택만 바꿉니다.</span>
            </div>
            {modalError && (
              <div className="msg msg-neg" role="alert">
                <span>{modalError}</span>
              </div>
            )}
          </div>
          <div className="modal-f">
            {!editing.grade.isBase && (
              <button className="btn btn-out" type="button" style={{ marginRight: "auto", color: "var(--neg-text)" }} disabled={busy} onClick={() => setConfirm({ grade: editing.grade })}>
                삭제
              </button>
            )}
            <button className="btn btn-out" type="button" disabled={busy} onClick={() => setEditing(null)}>
              취소
            </button>
            <button className="btn" type="button" disabled={busy || !editing.displayName.trim()} onClick={saveGrade}>
              {busy ? "저장 중" : "저장"}
            </button>
          </div>
        </Modal>
      )}
      {adding && data && (
        <Modal labelId="mg-add-title" busy={busy} onClose={() => setAdding(null)}>
          <div className="modal-h">
            <h2 className="modal-t" id="mg-add-title">
              등급 추가
            </h2>
          </div>
          <div className="modal-b col" style={{ gap: 12 }}>
            <table className="au-ft">
              <tbody>
                <FormRow label="등급 이름" required htmlFor="mg-add-name">
                  <input id="mg-add-name" className="inp" placeholder="플래티넘" maxLength={12} value={adding.displayName} onChange={(e) => setAdding({ ...adding, displayName: e.target.value })} />
                </FormRow>
                <FormRow label="기준 금액" required htmlFor="mg-add-amount">
                  <input id="mg-add-amount" className="inp num" inputMode="numeric" placeholder="3,000,000" value={adding.minAmount} onChange={(e) => setAdding({ ...adding, minAmount: digits(e.target.value) })} />
                  <span className="t-l2">원 이상</span>
                </FormRow>
              </tbody>
            </table>
            {modalError && (
              <div className="msg msg-neg" role="alert">
                <span>{modalError}</span>
              </div>
            )}
          </div>
          <div className="modal-f">
            <button className="btn btn-out" type="button" disabled={busy} onClick={() => setAdding(null)}>
              취소
            </button>
            <button className="btn" type="button" disabled={busy || !adding.displayName.trim()} onClick={add}>
              {busy ? "추가 중" : "추가"}
            </button>
          </div>
        </Modal>
      )}
      {confirm === "recalc" && data && (
        <Modal labelId="mg-recalc-title" busy={busy} onClose={() => setConfirm(null)}>
          <div className="modal-h">
            <h2 className="modal-t" id="mg-recalc-title">
              지금 재산정하시겠습니까?
            </h2>
          </div>
          <div className="modal-b">
            <p className="t-l2">
              회원 {data.memberTotal.toLocaleString("ko-KR")}명의 등급을 지금 기준({windowText(data.windowMonths)} 구매 금액)으로 다시 계산합니다. 고정한 회원은 제외됩니다. 저장하지 않은 기준 금액은 반영되지 않으니 먼저 저장해 주십시오.
            </p>
          </div>
          <div className="modal-f">
            <button className="btn btn-out" type="button" disabled={busy} onClick={() => setConfirm(null)}>
              취소
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => void run<{ promoted: number; demoted: number; unchanged: number }>("/api/seller/member-grades/recalc", "POST", {}, (d) => `재산정 완료 · 승급 ${d.promoted}명 · 강등 ${d.demoted}명 · 변동 없음 ${d.unchanged}명`)}>
              {busy ? "처리 중" : "재산정"}
            </button>
          </div>
        </Modal>
      )}
      {confirm && confirm !== "recalc" && (
        <Modal labelId="mg-del-title" busy={busy} onClose={() => setConfirm(null)}>
          <div className="modal-h">
            <h2 className="modal-t" id="mg-del-title">
              「{confirm.grade.displayName}」 등급을 삭제하시겠습니까?
            </h2>
          </div>
          <div className="modal-b">
            <p className="t-l2">
              {confirm.grade.members > 0
                ? `「${confirm.grade.displayName}」에 ${confirm.grade.members.toLocaleString("ko-KR")}명이 있습니다. 삭제하면 모두 첫 등급으로 옮기고, 다음 재산정 때 기준에 맞는 등급으로 올라갑니다. 그 전까지는 첫 등급 혜택이 적용됩니다.`
                : "이 등급에는 회원이 없습니다."}
            </p>
          </div>
          <div className="modal-f">
            <button className="btn btn-out" type="button" disabled={busy} onClick={() => setConfirm(null)}>
              취소
            </button>
            <button className="btn btn-neg" type="button" disabled={busy} onClick={() => void run<{ moved: number }>(`/api/seller/member-grades/${confirm.grade.id}`, "DELETE", undefined, (d) => `등급을 지웠습니다${d.moved ? ` · 회원 ${d.moved}명을 첫 등급으로 옮김` : ""}`)}>
              {busy ? "처리 중" : "삭제"}
            </button>
          </div>
        </Modal>
      )}
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}

// 수동 조정: 고정한 회원(또는 검색한 회원)을 표로 보고, 등급 조정은 기존 회원 상세의 조정 영역에서 한다.
// 최근 N개월 구매 금액은 서버가 회원별로 주지 않아 「—」로 둔다(서버 필요).
function MemberAdjust({ data, pager }: { data: Data; pager: React.ReactNode }) {
  const [u, setU] = useUrlState({ memberQ: "", memberSearch: "" });
  const params = useSearchParams().toString();
  const writeUrl = useRef(setU);
  writeUrl.current = setU;
  const [q, setQ] = useState(u.memberQ);
  const [found, setFound] = useState<{ rows: Found[]; query: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const generation = useRef(0);
  const lastRequested = useRef<string | null>(null);
  const search = useCallback(async (value: string) => {
    const request = ++generation.current;
    const query = value.trim();
    lastRequested.current = query;
    setErr(null);
    const r = await api<{ members: Found[] }>(`/api/seller/members?status=ACTIVE&limit=10&q=${encodeURIComponent(query)}`);
    if (request !== generation.current) return;
    if (!r.ok) return setErr(errorText(r, "회원을 찾지 못했습니다"));
    setFound({ rows: r.data.members, query });
    writeUrl.current({ memberQ: query, memberSearch: "1" });
  }, []);
  useEffect(() => {
    setQ(u.memberQ);
    if (u.memberSearch === "1" && lastRequested.current !== u.memberQ) void search(u.memberQ);
  }, [u.memberQ, u.memberSearch, search]);
  useEffect(() => () => { generation.current++; }, []);
  const returnParams = new URLSearchParams(params);
  if (found) {
    returnParams.set("memberSearch", "1");
    if (found.query) returnParams.set("memberQ", found.query); else returnParams.delete("memberQ");
  }
  const returnTo = `/seller/member-grades${returnParams.size ? `?${returnParams}` : ""}`;
  const gradeName = (id: string) => data.grades.find((g) => g.id === id)?.displayName ?? "—";
  const lockText = (l: Data["locked"][number] | undefined) => (l ? `${l.until ? `${kstDay(new Date(new Date(l.until).getTime() - 1).toISOString())}까지 고정` : "직접 풀 때까지 고정"}${l.reason ? ` · ${l.reason}` : ""}` : "—");
  const rows = found
    ? found.rows.map((m) => ({ id: m.id, nickname: m.broadcastNickname, gradeId: m.grade.id, lock: data.locked.find((l) => l.memberId === m.id) }))
    : data.locked.map((l) => ({ id: l.memberId, nickname: l.nickname, gradeId: l.gradeId, lock: l }));
  return (
    <section className="mg-sec" aria-label="회원 등급 조정">
      <div className="mg-sec-h">
        <h2 className="t-hl1">수동 조정</h2>
      </div>
      <form className="mg-search" role="search" onSubmit={(e) => { e.preventDefault(); void search(q); }}>
        <input className="inp" aria-label="회원 닉네임 검색" placeholder="회원 이름 · 닉네임" maxLength={30} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn btn-out" type="submit">검색</button>
      </form>
      {err && <div className="msg msg-neg" role="alert"><span>{err}</span></div>}
      {rows.length === 0 ? (
        <div className="st" style={{ boxShadow: "none" }}><span className="t">{found ? "찾는 회원이 없습니다" : "고정한 회원이 없습니다"}</span></div>
      ) : (
        <ListTable aria-label="수동 조정 회원 표">
          <table className="tbl">
            <thead>
              <tr><th>회원</th><th>지금 등급</th><th>{windowText(data.windowMonths)}</th><th>조정</th><th>기간 · 사유</th></tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} data-testid={m.lock ? "grade-locked-row" : "adjust-row"}>
                  <td>{m.nickname}</td>
                  <td>{gradeName(m.gradeId)}</td>
                  <td className="num">—</td>
                  <td><Link className="btn btn-sm btn-out" href={`/seller/members/${m.id}?${new URLSearchParams({ returnTo })}#member-grade-adjust`}>회원 상세</Link></td>
                  <td className="col-text">{lockText(m.lock)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ListTable>
      )}
      {!found && pager}
      <span className="t-c1 c-alt">수동 등급은 기간 동안 재산정에서 제외 · 끝나면 다음 재산정부터 기준 적용 · 로그 추적에 남음</span>
    </section>
  );
}
