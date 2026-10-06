"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FormFoot, FormRow, FormSection, PageHead, useConfirm } from "../../../../../components/admin-ui";
import { Topbar } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../components/seller/States";
import { api, failMessage } from "../../../../../components/seller/api";
import { formatDateTime } from "../../../../../lib/client/format";
import "./rewards.css";

// SA-031 적립 정책(정본 SA-031 FINAL). API: GET·PUT /api/seller/reward-policy, POST …/preview, GET …/history (회원·적립금 권한).
// 등급별 적립률(카드·무통장)·지급 시점·회수 방식·최소 사용 금액·주문당 최대 사용 비율·인기 카드 1위 보너스를 한 번에 저장한다(바뀐 항목만 보냄).
// 유효 기간은 설정이 없다(마지막 적립 후 3년 고정). 등급 기준(조건 금액)은 회원 등급 화면과 같은 값이라 여기서는 보여 주기만 한다.
type EarnTiming = "ON_PAYMENT" | "ON_DELIVERY";
type RevokeMode = "AUTO" | "MANUAL";
type Grade = { id: string; name: string; systemKey: string | null; minAmount: number; memberCount: number; card: number | null; bankTransfer: number | null };
type Policy = {
  configured: boolean;
  earnTiming: EarnTiming;
  revokeMode: RevokeMode;
  useMinAmount: number;
  useMaxRatio: number;
  rankingBonus: { enabled: boolean; amount: number };
  livePayoutEnabled: boolean;
  grades: Grade[];
};
type Change =
  | { kind: "rate"; gradeName: string; method: "card" | "bankTransfer"; before: number | null; after: number | null }
  | { kind: "earnTiming" | "revokeMode"; before: string; after: string }
  | { kind: "useMinAmount" | "useMaxRatio"; before: number; after: number }
  | { kind: "rankingBonus"; before: { enabled: boolean; amount: number }; after: { enabled: boolean; amount: number } };
type HistoryRow = { id: string; at: string; actorName: string | null; changes: Change[] };

type Form = { rates: Record<string, { card: string; bank: string }>; timing: EarnTiming; revoke: RevokeMode; useMin: string; useRatio: string; bonusOn: boolean; bonusAmount: string };

const TIMING_LABEL: Record<EarnTiming, string> = { ON_DELIVERY: "배송 완료 후 지급 (기본)", ON_PAYMENT: "결제하면 바로 지급" };
const REVOKE_LABEL: Record<RevokeMode, string> = { AUTO: "자동 회수 (잔액이 모자라면 실패로 기록)", MANUAL: "수동 회수 (원장에서 처리)" };
const EXAMPLE_AMOUNT = 189_000;

const n = (v: number) => v.toLocaleString("ko-KR");
const rateText = (v: number | null) => (v === null ? "" : v.toFixed(1));
const toForm = (p: Policy): Form => ({
  rates: Object.fromEntries(p.grades.map((g) => [g.id, { card: rateText(g.card), bank: rateText(g.bankTransfer) }])),
  timing: p.earnTiming,
  revoke: p.revokeMode,
  useMin: String(p.useMinAmount),
  useRatio: String(p.useMaxRatio),
  bonusOn: p.rankingBonus.enabled,
  bonusAmount: String(p.rankingBonus.amount),
});
// 적립률 칸: 비우면 지급 안 함(null), 0~10 소수 1자리. 잘못된 값은 undefined
function parseRate(v: string): number | null | undefined {
  const t = v.trim();
  if (t === "") return null;
  if (!/^\d+(\.\d)?$/.test(t)) return undefined;
  const x = Number(t);
  return x >= 0 && x <= 10 ? x : undefined;
}
const parseInt0 = (v: string) => (/^\d+$/.test(v.replace(/,/g, "").trim()) ? Number(v.replace(/,/g, "")) : undefined);

function describe(c: Change): string {
  switch (c.kind) {
    case "rate":
      return `${c.gradeName} ${c.method === "card" ? "카드" : "무통장"} ${c.before === null ? "없음" : c.before.toFixed(1)} → ${c.after === null ? "없음" : `${c.after.toFixed(1)}%`}`;
    case "earnTiming":
      return `지급 시점 ${c.before === "ON_PAYMENT" ? "바로 지급" : "배송 완료 후"} → ${c.after === "ON_PAYMENT" ? "바로 지급" : "배송 완료 후"}`;
    case "revokeMode":
      return `회수 방식 ${c.before === "AUTO" ? "자동" : "수동"} → ${c.after === "AUTO" ? "자동" : "수동"}`;
    case "useMinAmount":
      return `최소 사용 금액 ${n(c.before)} → ${n(c.after)}원`;
    case "useMaxRatio":
      return `주문당 최대 사용 비율 ${c.before === 0 ? "제한 없음" : `${c.before}%`} → ${c.after === 0 ? "제한 없음" : `${c.after}%`}`;
    case "rankingBonus": {
      const t = (b: { enabled: boolean; amount: number }) => (b.enabled ? `${n(b.amount)}원` : "사용 안 함");
      return `인기 카드 1위 보너스 ${t(c.before)} → ${t(c.after)}`;
    }
  }
}

export default function RewardPolicyPage() {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; policy: Policy }>({ kind: "loading" });
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { confirm } = useConfirm();
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [history, setHistory] = useState<{ rows: HistoryRow[]; next: string | null } | "error" | null>(null);
  const [preview, setPreview] = useState<{ current: { rate: number; amount: number }; next: { rate: number; amount: number } } | null>(null);

  const loadHistory = useCallback(async (cursor?: string) => {
    const r = await api<{ history: HistoryRow[]; nextCursor: string | null }>(`/api/seller/reward-policy/history?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (!r.ok) return cursor ? undefined : setHistory("error");
    setHistory((prev) => ({ rows: cursor && prev && prev !== "error" ? [...prev.rows, ...r.data.history] : r.data.history, next: r.data.nextCursor }));
  }, []);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await api<{ policy: Policy }>("/api/seller/reward-policy");
    if (!r.ok) return setState({ kind: "error", status: r.status });
    setForm(toForm(r.data.policy));
    setErrors({});
    setState({ kind: "ok", policy: r.data.policy });
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    void load();
  }, [load]);

  const policy = state.kind === "ok" ? state.policy : null;
  const saved = useMemo(() => (policy ? toForm(policy) : null), [policy]);

  // 바뀐 항목만 보낼 본문(입력 오류가 있으면 errors를 채우고 null)
  const build = (): { body: Record<string, unknown>; errs: Record<string, string> } | null => {
    if (!policy || !form || !saved) return null;
    const errs: Record<string, string> = {};
    const body: Record<string, unknown> = {};
    const rates: Record<string, { card?: number | null; bankTransfer?: number | null }> = {};
    for (const g of policy.grades) {
      const cur = form.rates[g.id];
      const old = saved.rates[g.id];
      for (const [key, field, label] of [["card", "card", "카드 결제"], ["bank", "bankTransfer", "무통장"]] as const) {
        if (cur[key] === old[key]) continue;
        const v = parseRate(cur[key]);
        if (v === undefined) errs[`rate-${g.id}-${key}`] = "적립률은 0~10% 사이로 입력해 주십시오";
        else rates[g.id] = { ...rates[g.id], [field]: v };
        void label;
      }
    }
    if (Object.keys(rates).length) body.rates = rates;
    if (form.timing !== saved.timing) body.earnTiming = form.timing;
    if (form.revoke !== saved.revoke) body.revokeMode = form.revoke;
    if (form.useMin !== saved.useMin) {
      const v = parseInt0(form.useMin);
      if (v === undefined || v < 10 || v > 1_000_000 || v % 10 !== 0) errs.useMin = "최소 사용 금액은 10원 단위로 10원 이상 입력해 주십시오";
      else body.useMinAmount = v;
    }
    if (form.useRatio !== saved.useRatio) {
      const v = parseInt0(form.useRatio);
      if (v === undefined || v > 100) errs.useRatio = "최대 사용 비율은 0~100 사이 정수로 입력해 주십시오";
      else body.useMaxRatio = v;
    }
    if (form.bonusOn !== saved.bonusOn || form.bonusAmount !== saved.bonusAmount) {
      const v = parseInt0(form.bonusAmount);
      if (v === undefined || v > 1_000_000 || (form.bonusOn && v < 1)) errs.bonus = "인기 카드 1위 보너스 금액을 확인해 주십시오";
      else body.rankingBonus = { enabled: form.bonusOn, amount: v };
    }
    return { body, errs };
  };

  const dirty = !!form && !!saved && JSON.stringify(form) !== JSON.stringify(saved);

  // 변경 영향 미리보기: 예시 주문(189,000원 · 카드 · 두 번째 등급)에 지금과 바꾼 적립률을 각각 적용
  const example = policy ? (policy.grades[1] ?? policy.grades[0]) : null;
  const exampleCard = form && example ? form.rates[example.id]?.card : null;
  useEffect(() => {
    if (!example || !saved) return;
    const v = parseRate(exampleCard ?? "");
    const t = setTimeout(async () => {
      const r = await api<{ current: { rate: number; amount: number }; next: { rate: number; amount: number } }>("/api/seller/reward-policy/preview", {
        method: "POST",
        body: { amount: EXAMPLE_AMOUNT, paymentMethod: "CARD", gradeId: example.id, ...(v !== undefined && exampleCard !== saved.rates[example.id]?.card ? { rates: { [example.id]: { card: v } } } : {}) },
      });
      setPreview(r.ok ? r.data : null);
    }, 350);
    return () => clearTimeout(t);
  }, [example, exampleCard, saved]);

  const save = async () => {
    if (!dirty) return;
    const built = build();
    if (!built) return;
    setErrors(built.errs);
    if (Object.keys(built.errs).length) return;
    let saved_ = false;
    const rateChanged = !!built.body.rates;
    const ok = await confirm({
      title: "적립 정책을 저장하시겠습니까?",
      body: rateChanged ? "바뀐 적립률은 저장 뒤 결제되는 주문부터 적용됩니다. 이미 지급한 적립금은 그대로입니다." : "바뀐 정책은 저장 뒤 결제되는 주문부터 적용됩니다. 이미 지급한 적립금은 그대로입니다.",
      confirmLabel: "정책 저장",
      run: async () => {
        setSaving(true);
        const r = await api("/api/seller/reward-policy", { method: "PUT", body: built.body });
        setSaving(false);
        if (!r.ok) return failMessage(r, "admin", "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오");
        saved_ = true;
      },
    });
    if (!ok || !saved_) return;
    // 지급 시점만 바꾼 저장은 응답에 정책 전체가 없다: 저장한 값을 다시 읽어 맞춘다
    const fresh = await api<{ policy: Policy }>("/api/seller/reward-policy");
    if (fresh.ok) {
      setState({ kind: "ok", policy: fresh.data.policy });
      setForm(toForm(fresh.data.policy));
    }
    setToast("적립 정책을 저장했습니다 · 다음 지급부터 적용됩니다");
    void loadHistory();
  };

  const patch = (p: Partial<Form>) => setForm((f) => (f ? { ...f, ...p } : f));
  const setRate = (id: string, key: "card" | "bank", v: string) => {
    setForm((f) => (f ? { ...f, rates: { ...f.rates, [id]: { ...f.rates[id], [key]: v } } } : f));
    setErrors((e) => ({ ...e, [`rate-${id}-${key}`]: "" }));
  };

  return (
    <>
      <Topbar crumb="고객 › 적립금 › 적립 정책" />
      <main className="main">
        <PageHead description="적립금의 지급 시점과 회수, 사용 조건을 설정합니다."
          title="적립 정책"
          actions={
            <Link className="btn btn-out" href="/seller/member-grades">
              회원 등급
            </Link>
          }
        />

        {state.kind !== "ok" || !form || !policy ? (
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={3} />}
            {state.kind === "error" &&
              (state.status === 403 ? (
                <NoPermission need="회원·적립금" />
              ) : state.status === 402 ? (
                <Locked />
              ) : (
                <ErrorState title="적립 정책을 불러오지 못했습니다" onRetry={() => void load()} />
              ))}
          </div>
        ) : (
          <form
            className="rw-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <fieldset className="settings-fields" disabled={saving}>
              {!policy.configured && (
                <div className="msg msg-info" role="note" data-testid="policy-empty" style={{ marginBottom: 16 }}>
                  <span>적립 정책이 없습니다. 등급별 적립률과 지급 시점을 정하고 저장하면 다음 결제부터 적립이 시작됩니다.</span>
                </div>
              )}

              <section className="au-fs">
                <div className="au-fs-h">
                  <h2 className="au-fs-t">등급별 적립률</h2>
                  <span className="t-c1 c-alt">단위 % · 소수점 1자리 · 무통장은 PG 수수료가 없어 보통 더 높게</span>
                </div>
                <div className="card sts-scroll">
                  <table className="tbl tbl-card" data-testid="rate-table">
                    <thead>
                      <tr>
                        <th>등급</th>
                        <th>조건 (최근 6개월)</th>
                        <th style={{ width: 150 }}>카드 결제</th>
                        <th style={{ width: 150 }}>무통장</th>
                        <th style={{ width: 90 }}>회원 수</th>
                      </tr>
                    </thead>
                    <tbody>
                      {policy.grades.map((g) => (
                        <tr key={g.id} data-testid="rate-row">
                          <td data-card="title">
                            <span className="bdg b-info nodot">{g.name}</span>
                          </td>
                          <td className="col-text" data-card="field" data-label-set data-label="조건">{g.minAmount > 0 ? `${n(g.minAmount)}원 이상` : "가입 즉시"}</td>
                          {(["card", "bank"] as const).map((key) => {
                            const err = errors[`rate-${g.id}-${key}`];
                            return (
                              <td key={key}>
                                <div className="row" style={{ gap: 6, justifyContent: "center", alignItems: "center" }}>
                                  <input
                                    className={`inp num${err ? " is-error" : ""}`}
                                    style={{ width: 80, textAlign: "right" }}
                                    inputMode="decimal"
                                    placeholder="0"
                                    aria-label={`${g.name} ${key === "card" ? "카드 결제" : "무통장"} 적립률`}
                                    aria-invalid={!!err}
                                    value={form.rates[g.id][key]}
                                    onChange={(e) => setRate(g.id, key, e.target.value)}
                                  />
                                  <span>%</span>
                                </div>
                                {err && (
                                  <span className="err" role="alert">
                                    {err}
                                  </span>
                                )}
                              </td>
                            );
                          })}
                          <td className="num">{n(g.memberCount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <span className="help" style={{ display: "block", margin: "8px 0 16px" }}>
                  등급 기준 · 재산정은 회원 등급 화면과 같은 값입니다
                </span>
              </section>

              <FormSection title="적립금 지급 시점">
                <FormRow label="지급 시점" required help="적립 금액은 결제 때 정해지고 지급 시점만 달라집니다 · 바꾼 시점은 저장 뒤 결제되는 주문부터 · 바로 지급은 취소 · 환불 시 회수">
                  <div className="row" role="radiogroup" aria-label="적립금 지급 시점" style={{ gap: 24, flexWrap: "wrap" }}>
                    {(["ON_DELIVERY", "ON_PAYMENT"] as const).map((k) => (
                      <label key={k} className="chk">
                        <input className="rdo" type="radio" name="earn-timing" checked={form.timing === k} onChange={() => patch({ timing: k })} aria-label={TIMING_LABEL[k]} />
                        {TIMING_LABEL[k]}
                      </label>
                    ))}
                  </div>
                </FormRow>
              </FormSection>

              <section className="au-fs" data-testid="revoke-section">
                <div className="au-fs-h">
                  <h2 className="au-fs-t">회수 · 사용 조건</h2>
                </div>
                <table className="au-ft rw-ft4">
                  <colgroup>
                    <col style={{ width: 160 }} />
                    <col />
                    <col style={{ width: 160 }} />
                    <col />
                  </colgroup>
                  <tbody>
                    <tr>
                      <th scope="row">
                        <label htmlFor="rp-revoke">취소 · 환불 시 회수</label>
                      </th>
                      <td className="rw-rt">
                        <select id="rp-revoke" className="inp" style={{ width: "100%", maxWidth: 360 }} value={form.revoke} onChange={(e) => patch({ revoke: e.target.value as RevokeMode })}>
                          {(["AUTO", "MANUAL"] as const).map((k) => (
                            <option key={k} value={k}>
                              {REVOKE_LABEL[k]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <th scope="row">
                        <span>유효 기간</span>
                      </th>
                      <td>
                        <span>마지막 적립 후 3년이 지나면 소멸</span>
                        <p className="help au-ft-help">새로 적립되지 않은 채 3년이 지나면 남은 적립금이 사라집니다 · 소멸 30일 전 회원에게 알림톡(안 되면 문자)으로 안내 · 기간은 바꿀 수 없습니다</p>
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">
                        <label htmlFor="rp-min">최소 사용 금액</label>
                      </th>
                      <td className="rw-rt">
                        <div className="row" style={{ gap: 6, alignItems: "center" }}>
                          <input id="rp-min" className={`inp num${errors.useMin ? " is-error" : ""}`} style={{ width: 140, textAlign: "right" }} inputMode="numeric" placeholder="0" value={form.useMin} onChange={(e) => patch({ useMin: e.target.value })} aria-invalid={!!errors.useMin} />
                          <span>원</span>
                        </div>
                        {errors.useMin && <p className="err au-ft-help">{errors.useMin}</p>}
                      </td>
                      <th scope="row">
                        <label htmlFor="rp-ratio">주문당 최대 사용 비율</label>
                      </th>
                      <td>
                        <div className="row" style={{ gap: 6, alignItems: "center" }}>
                          <input id="rp-ratio" className={`inp num${errors.useRatio ? " is-error" : ""}`} style={{ width: 100, textAlign: "right" }} inputMode="numeric" placeholder="0" value={form.useRatio} onChange={(e) => patch({ useRatio: e.target.value })} aria-invalid={!!errors.useRatio} />
                          <span>% · 0 = 제한 없음</span>
                        </div>
                        {errors.useRatio && <p className="err au-ft-help">{errors.useRatio}</p>}
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">
                        <span>인기 카드 1위 보너스</span>
                      </th>
                      <td className="rw-rt">
                        <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                          <label className="chk">
                            <input className="cbx" type="checkbox" checked={form.bonusOn} onChange={(e) => patch({ bonusOn: e.target.checked })} aria-label="인기 카드 1위 보너스 사용" />
                            사용
                          </label>
                          <input className={`inp num${errors.bonus ? " is-error" : ""}`} style={{ width: 120, textAlign: "right" }} inputMode="numeric" placeholder="0" aria-label="인기 카드 1위 보너스 금액" value={form.bonusAmount} disabled={!form.bonusOn} onChange={(e) => patch({ bonusAmount: e.target.value })} aria-invalid={!!errors.bonus} />
                          <span>원</span>
                        </div>
                        {errors.bonus ? <p className="err au-ft-help">{errors.bonus}</p> : <p className="help au-ft-help">HIT 당첨으로 1위에 오른 구매자에게 추가 지급</p>}
                      </td>
                      <th scope="row">
                        <span>리뷰 적립금</span>
                      </th>
                      <td>리뷰 관리에서 설정합니다</td>
                    </tr>
                  </tbody>
                </table>
              </section>

              <FormSection title="변경 영향 미리보기">
                <FormRow label="예시 주문">{example ? `${n(EXAMPLE_AMOUNT)}원 · 카드 · ${example.name}` : "등급이 없습니다"}</FormRow>
                <FormRow label="현재 → 변경 후">
                  <span data-testid="policy-preview">
                    {preview ? `${n(preview.current.amount)}원 (${preview.current.rate.toFixed(1)}%) → ${n(preview.next.amount)}원 (${preview.next.rate.toFixed(1)}%)` : "계산 중입니다"}
                  </span>
                </FormRow>
                <FormRow label="적용">
                  <span>{policy.livePayoutEnabled ? "실제 지급 켜져 있음 · 저장 즉시 다음 지급부터 · 이미 지급된 금액은 그대로" : "실제 지급 꺼져 있음 · 계산만 합니다 · 저장 즉시 다음 계산부터 · 이미 지급된 금액은 그대로"}</span>
                </FormRow>
              </FormSection>

              <section className="au-fs">
                <div className="au-fs-h">
                  <h2 className="au-fs-t">정책 변경 이력</h2>
                </div>
                <div className="card sts-scroll">
                  {history === null ? (
                    <LoadingRows rows={2} />
                  ) : history === "error" ? (
                    <ErrorState title="변경 이력을 불러오지 못했습니다" onRetry={() => void loadHistory()} />
                  ) : history.rows.length === 0 ? (
                    <div className="st" style={{ boxShadow: "none", minHeight: 80 }}>
                      <span className="t">변경 이력이 없습니다</span>
                    </div>
                  ) : (
                    <table className="tbl tbl-card" data-testid="policy-history">
                      <thead>
                        <tr>
                          <th style={{ width: 160 }}>일시</th>
                          <th>변경</th>
                          <th style={{ width: 140 }}>처리</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.rows.map((h) => (
                          <tr key={h.id}>
                            <td className="num">{formatDateTime(h.at)}</td>
                            <td className="col-text" data-card="title">{h.changes.map(describe).join(" · ")}</td>
                            <td>{h.actorName ?? "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                {history && history !== "error" && history.next && (
                  <div className="row" style={{ justifyContent: "center", marginTop: 8 }}>
                    <button className="btn btn-out" type="button" onClick={() => void loadHistory(history.next!)}>
                      이력 더 보기
                    </button>
                  </div>
                )}
              </section>
            </fieldset>
            <FormFoot>
              <button className="btn btn-lg" type="submit" disabled={saving || !dirty}>
                {saving ? "저장 중" : "정책 저장"}
              </button>
              <button className="btn btn-out btn-lg" type="button" disabled={saving || !dirty} onClick={() => saved && (setForm(saved), setErrors({}))}>
                변경 취소
              </button>
            </FormFoot>
          </form>
        )}
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
