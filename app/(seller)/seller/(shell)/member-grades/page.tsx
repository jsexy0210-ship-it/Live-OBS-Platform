"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal, PageHead } from "../../../../../components/admin-ui";
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
type Data = {
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
const digits = (v: string) => v.replace(/[^0-9]/g, "");
const windowText = (m: number) => (m === 0 ? "누적" : `최근 ${m}개월`);
const kstDay = (iso: string) => kstText(iso).slice(5, 10).replace(".", "/");

export default function MemberGradesPage() {
  const { can } = useSeller();
  const canEdit = can("MEMBER_POINTS");
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number; error?: string } | { kind: "ok"; data: Data }>({ kind: "loading" });
  const [edit, setEdit] = useState<{ id: string; displayName: string; minAmount: string }[]>([]);
  const [benefit, setBenefit] = useState<Benefit[]>([]);
  const [changes, setChanges] = useState<{ kind: "up" | "down"; rows: Change[] } | null>(null);
  const [auto, setAuto] = useState(false);
  const [windowMonths, setWindowMonths] = useState(6);
  const [cadence, setCadence] = useState<Cadence>("MONTHLY");
  const [demotion, setDemotion] = useState<Demotion>("STEP");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [confirm, setConfirm] = useState<"recalc" | { grade: Grade } | null>(null);

  const load = useCallback(async () => {
    const r = await api<Data>("/api/seller/member-grades");
    if (!r.ok) return setState({ kind: "error", status: r.status, error: r.error });
    setState({ kind: "ok", data: r.data });
    setEdit(r.data.grades.map((g) => ({ id: g.id, displayName: g.displayName, minAmount: String(g.minAmount) })));
    setBenefit(r.data.grades.map((g) => ({ id: g.id, shippingBenefit: g.shippingBenefit, shippingDiscount: g.shippingDiscount ? String(g.shippingDiscount) : "", promotionCouponId: g.promotionCouponId ?? "" })));
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
      setFailure(errorText(r, "저장하지 못했습니다. 잠시 뒤 다시 시도해 주십시오"));
      return false;
    }
    setConfirm(null);
    setToast(done(r.data));
    await load();
    return true;
  };

  const save = () =>
    void run("/api/seller/member-grades", "PUT", { autoEnabled: auto, windowMonths, cadence, demotion, grades: edit.map((e, i) => ({ id: e.id, displayName: e.displayName, minAmount: Number(e.minAmount || 0), ...benefitBody(benefit[i]) })) }, () => "등급 설정을 저장했습니다");
  const showChanges = async (kind: "up" | "down") => {
    const r = await api<{ changes: Change[] }>(`/api/seller/member-grades/changes?kind=${kind}`);
    if (!r.ok) return setFailure(errorText(r, "변동 회원을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주십시오"));
    setChanges({ kind, rows: r.data.changes });
  };
  const add = async () => {
    if (await run("/api/seller/member-grades", "POST", { displayName: newName, minAmount: Number(newAmount || 0) }, () => "등급을 추가했습니다")) {
      setNewName("");
      setNewAmount("");
    }
  };

  return (
    <>
      <Topbar crumb="회원 › 회원 등급" />
      <main className="main">
        <PageHead
          title="회원 등급"
          actions={
            data && canEdit ? (
              <>
                <button className="btn btn-out" type="button" disabled={busy} onClick={() => setConfirm("recalc")}>
                  지금 재산정
                </button>
                <button className="btn" type="button" disabled={busy} onClick={save}>
                  {busy ? "저장 중" : "저장"}
                </button>
              </>
            ) : undefined
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
                <b className="num">{data.lastRun ? `승급 ${data.lastRun.promoted} · 강등 ${data.lastRun.demoted}` : "없음"}</b>
                <span className="row" style={{ gap: 8 }}>
                  <button className="btn btn-sm btn-text" type="button" onClick={() => void showChanges("up")}>
                    승급 회원 보기
                  </button>
                  <button className="btn btn-sm btn-text" type="button" onClick={() => void showChanges("down")}>
                    강등 회원 보기
                  </button>
                </span>
              </div>
              <div>
                <span className="t-l2 c-alt">수동 고정</span>
                <b className="num">{data.lockedCount}명</b>
              </div>
            </section>

            <section className="card" style={{ overflow: "hidden" }} aria-label="등급 목록">
              <div className="mg-grid mg-head">
                <span>등급 이름</span>
                <span>기준 금액 ({windowText(windowMonths)})</span>
                <span className="mg-hide-m">회원 수</span>
                <span className="mg-hide-m">적립률 (카드 · 무통장)</span>
                <span className="mg-hide-m" />
              </div>
              {data.grades.map((g, i) => (
                <div key={g.id} className="mg-grid" data-testid="grade-row">
                  <input className="inp" aria-label={`${i + 1}번째 등급 이름`} maxLength={12} disabled={!canEdit} value={edit[i]?.displayName ?? ""} onChange={(e) => setEdit((x) => x.map((y, j) => (j === i ? { ...y, displayName: e.target.value } : y)))} />
                  <input
                    className="inp num"
                    inputMode="numeric"
                    aria-label={`${edit[i]?.displayName ?? ""} 기준 금액`}
                    disabled={!canEdit || g.isBase}
                    value={g.isBase ? "0" : (edit[i]?.minAmount ?? "")}
                    onChange={(e) => setEdit((x) => x.map((y, j) => (j === i ? { ...y, minAmount: digits(e.target.value) } : y)))}
                  />
                  <span className="mg-hide-m num">{g.members.toLocaleString("ko-KR")}명</span>
                  <span className="mg-hide-m t-c1 c-alt num">{g.rewardCard === null && g.rewardBankTransfer === null ? "적립 정책에서 설정" : `${g.rewardCard ?? 0}% · ${g.rewardBankTransfer ?? 0}%`}</span>
                  <span className="mg-hide-m">
                    {canEdit && !g.isBase && (
                      <button className="btn btn-sm btn-text" type="button" style={{ color: "var(--neg-text)" }} disabled={busy} onClick={() => setConfirm({ grade: g })}>
                        삭제
                      </button>
                    )}
                  </span>
                </div>
              ))}
              {canEdit && (
                <div className="mg-grid">
                  <input className="inp" aria-label="새 등급 이름" placeholder="새 등급 이름" maxLength={12} value={newName} onChange={(e) => setNewName(e.target.value)} />
                  <input className="inp num" inputMode="numeric" aria-label="새 등급 기준 금액" placeholder="기준 금액" value={newAmount} onChange={(e) => setNewAmount(digits(e.target.value))} />
                  <span className="mg-hide-m" />
                  <span className="mg-hide-m" />
                  <button className="btn btn-sm btn-out" type="button" disabled={busy || !newName.trim()} onClick={() => void add()}>
                    추가
                  </button>
                </div>
              )}
            </section>
            <span className="t-c1 c-alt">기준 금액은 높은 등급일수록 커야 합니다 · 첫 등급은 0원 · 등급은 10개까지 · 높은 등급부터 판정해 하나만 적용 · 적립률은 적립 정책에서 수정</span>

            <section className="card" aria-label="등급 혜택" data-testid="grade-benefits">
              <div className="col" style={{ gap: 2, padding: "12px 16px" }}>
                <span className="t-hl2">등급 혜택</span>
                <span className="t-c1 c-alt">배송비 혜택은 주문서 금액과 결제 금액에 똑같이 적용됩니다 · 승급 쿠폰은 승급할 때 한 번만 지급하고 같은 쿠폰은 다시 지급하지 않습니다 · 저장 버튼으로 함께 저장</span>
              </div>
              <div className="mg-ben mg-head">
                <span>등급</span>
                <span>배송비 혜택</span>
                <span>할인 금액</span>
                <span>승급 쿠폰</span>
              </div>
              {data.grades.map((g, i) => {
                const b = benefit[i];
                if (!b) return null;
                const set = (patch: Partial<Benefit>) => setBenefit((x) => x.map((y, j) => (j === i ? { ...y, ...patch } : y)));
                return (
                  <div key={g.id} className="mg-ben" data-testid="benefit-row">
                    <span className="t-l2 fw6">{edit[i]?.displayName ?? g.displayName}</span>
                    <select className="inp" aria-label={`${g.displayName} 배송비 혜택`} disabled={!canEdit} value={b.shippingBenefit} onChange={(e) => set({ shippingBenefit: e.target.value as ShippingBenefit })}>
                      {SHIPPING.map((o) => (
                        <option key={o.v} value={o.v}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <input
                      className="inp num"
                      inputMode="numeric"
                      aria-label={`${g.displayName} 배송비 할인 금액`}
                      placeholder="원"
                      disabled={!canEdit || b.shippingBenefit !== "DISCOUNT"}
                      value={b.shippingBenefit === "DISCOUNT" ? b.shippingDiscount : ""}
                      onChange={(e) => set({ shippingDiscount: digits(e.target.value) })}
                    />
                    <select className="inp" aria-label={`${g.displayName} 승급 쿠폰`} disabled={!canEdit || g.isBase} value={b.promotionCouponId} onChange={(e) => set({ promotionCouponId: e.target.value })}>
                      <option value="">없음</option>
                      {data.couponOptions.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                          {c.usable ? "" : " (종료·중지)"}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </section>

            <section className="card pad col" style={{ gap: 12 }} aria-label="산정 기준">
              <div className="row between">
                <span className="col" style={{ gap: 2 }}>
                  <span className="t-hl2" id="mg-auto-label">
                    자동 재산정
                  </span>
                  <span className="t-c1 c-alt">켜면 아래 기준으로 등급을 다시 정합니다 · 취소 · 환불 · 반품 제외 · 적립금 사용분 제외 · 고정한 회원은 제외</span>
                </span>
                <button className={`sw${auto ? " on" : ""}`} type="button" role="switch" aria-checked={auto} aria-labelledby="mg-auto-label" disabled={!canEdit} onClick={() => setAuto(!auto)} />
              </div>
              <div className="mg-opts">
                <label className="fld">
                  <span>기준 금액</span>
                  <select className="inp" disabled={!canEdit} value={windowMonths} onChange={(e) => setWindowMonths(Number(e.target.value))}>
                    {WINDOWS.map((w) => (
                      <option key={w.v} value={w.v}>
                        {w.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="fld">
                  <span>재산정 주기</span>
                  <select className="inp" disabled={!canEdit} value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>
                    {CADENCES.map((c) => (
                      <option key={c.v} value={c.v}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="fld">
                  <span>강등</span>
                  <select className="inp" disabled={!canEdit} value={demotion} onChange={(e) => setDemotion(e.target.value as Demotion)}>
                    {DEMOTIONS.map((d) => (
                      <option key={d.v} value={d.v}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <span className="t-c1 c-alt">승급은 목표 등급까지 바로 올립니다 · 켜거나 주기를 바꾼 날은 이미 재산정한 것으로 보고 다음 주기부터 돕니다</span>
            </section>

            {canEdit && <MemberAdjust grades={data.grades} onDone={(t) => { setToast(t); void load(); }} />}

            <section className="card" aria-label="고정한 회원">
              <div className="row between" style={{ padding: "12px 16px" }}>
                <span className="t-hl2">고정한 회원 {data.lockedCount}명</span>
                <span className="t-c1 c-alt">종료일까지 자동 재산정에서 제외</span>
              </div>
              {data.locked.length === 0 ? (
                <div className="st" style={{ boxShadow: "none" }}>
                  <span className="t">고정한 회원이 없습니다</span>
                </div>
              ) : (
                data.locked.map((l) => (
                  <div key={l.memberId} className="mg-log">
                    <span className="col" style={{ gap: 2 }}>
                      <span>
                        {l.nickname} · <span className="c-alt">{data.grades.find((g) => g.id === l.gradeId)?.displayName}</span>
                      </span>
                      <span className="t-c1 c-alt">
                        {l.until ? `${kstDay(new Date(new Date(l.until).getTime() - 1).toISOString())}까지 고정` : "직접 풀 때까지 고정"}
                        {l.reason ? ` · ${l.reason}` : ""}
                      </span>
                    </span>
                  </div>
                ))
              )}
            </section>

            {changes && (
              <section className="card" aria-label={changes.kind === "up" ? "승급 회원" : "강등 회원"} data-testid="grade-changes">
                <div className="row between" style={{ padding: "12px 16px" }}>
                  <span className="t-hl2">{changes.kind === "up" ? "승급 회원" : "강등 회원"} 최근 {changes.rows.length}명</span>
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
                    <div key={h.id} className="mg-log">
                      <span>
                        {h.nickname} · {h.fromName} → {h.toName}
                      </span>
                      <span className="t-c1 c-alt num">{kstText(h.createdAt)}</span>
                    </div>
                  ))
                )}
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
            </section>
          </>
        )}
      </main>
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

// 회원 직접 조정: 닉네임으로 찾아 등급을 고르고, 고정하면 종료일(없으면 직접 풀 때까지)까지 자동 재산정에서 제외
function MemberAdjust({ grades, onDone }: { grades: Grade[]; onDone: (text: string) => void }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [pick, setPick] = useState<Record<string, { gradeId: string; lock: boolean; until: string; reason: string }>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const search = async () => {
    setErr(null);
    const r = await api<{ members: Found[] }>(`/api/seller/members?status=ACTIVE&limit=10&q=${encodeURIComponent(q.trim())}`);
    if (!r.ok) return setErr(errorText(r, "회원을 찾지 못했습니다"));
    setFound(r.data.members);
    setPick(Object.fromEntries(r.data.members.map((m) => [m.id, { gradeId: m.grade.id, lock: false, until: "", reason: "" }])));
  };
  const apply = async (m: Found) => {
    setBusy(true);
    setErr(null);
    const p = pick[m.id];
    const r = await api(`/api/seller/member-grades/members/${m.id}`, { method: "PUT", body: { gradeId: p.gradeId, lock: p.lock, ...(p.lock && p.until ? { until: p.until } : {}), ...(p.lock && p.reason.trim() ? { reason: p.reason } : {}) } });
    setBusy(false);
    if (!r.ok) return setErr(errorText(r, "조정하지 못했습니다"));
    onDone(`${m.broadcastNickname} 등급을 조정했습니다${p.lock ? " · 자동 재산정에서 제외" : ""}`);
    await search();
  };
  const set = (id: string, patch: Partial<{ gradeId: string; lock: boolean; until: string; reason: string }>) => setPick((x) => ({ ...x, [id]: { ...x[id], ...patch } }));

  return (
    <section className="card" aria-label="회원 등급 조정">
      <div className="row between" style={{ padding: "12px 16px", gap: 8, flexWrap: "wrap" }}>
        <span className="t-hl2">수동 조정</span>
        <form
          className="row"
          style={{ gap: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <input className="inp inp-sm" aria-label="회원 닉네임 검색" placeholder="방송 닉네임" maxLength={30} value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn btn-sm btn-out" type="submit">
            검색
          </button>
        </form>
      </div>
      {err && (
        <div className="msg msg-neg" role="alert">
          <span>{err}</span>
        </div>
      )}
      {found !== null && found.length === 0 && (
        <div className="st" style={{ boxShadow: "none" }}>
          <span className="t">찾는 회원이 없습니다</span>
        </div>
      )}
      {found?.map((m) => (
        <div key={m.id} className="mg-adj" data-testid="adjust-row">
          <span>{m.broadcastNickname}</span>
          <select className="inp inp-sm" aria-label={`${m.broadcastNickname} 등급`} value={pick[m.id]?.gradeId} onChange={(e) => set(m.id, { gradeId: e.target.value })}>
            {grades.map((g) => (
              <option key={g.id} value={g.id}>
                {g.displayName}
              </option>
            ))}
          </select>
          <label className="row t-l2" style={{ gap: 6 }}>
            <input className="cbx" type="checkbox" checked={pick[m.id]?.lock ?? false} onChange={(e) => set(m.id, { lock: e.target.checked })} />
            고정
          </label>
          <button className="btn btn-sm" type="button" disabled={busy} onClick={() => void apply(m)}>
            적용
          </button>
          {pick[m.id]?.lock && (
            <div className="mg-adj-more">
              <DatePicker className="dt-sm" aria-label={`${m.broadcastNickname} 고정 종료일`} value={pick[m.id].until} onChange={(v) => set(m.id, { until: v })} />
              <input className="inp inp-sm" aria-label={`${m.broadcastNickname} 고정 사유`} placeholder="사유 (예: 방송 단골)" maxLength={100} value={pick[m.id].reason} onChange={(e) => set(m.id, { reason: e.target.value })} />
              <span className="t-c1 c-alt">종료일을 비우면 직접 풀 때까지 고정됩니다</span>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
