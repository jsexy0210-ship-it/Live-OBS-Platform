"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Topbar } from "../../../../../components/seller/SellerShell";
import { Toast } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";
import { ConfirmDelete, StateBox, errorText, fromKstInput, kstText, stateKind, toKstInput } from "../banners/_shared/ui";
import "./coupons.css";

// SA-035 쿠폰 관리(파트너스 관리자, 판매 › 쿠폰). 쿠폰 만들기·수정·복제·발급 중지·삭제(발급 0장만)·직접 지급(등급), 발급·사용 집계.
// 조회는 파트너스 계정 누구나, 바꾸기는 대표자·적립금 권한 직원만(서버가 canEdit으로 알려 줌). 할인 금액은 주문 때 서버가 계산한다.
// API: /api/seller/coupons.

type Method = "DOWNLOAD" | "CODE" | "MANUAL";
type Benefit = "AMOUNT" | "RATE" | "FREE_SHIPPING";
type Status = "live" | "scheduled" | "ended";
type Coupon = {
  id: string;
  name: string;
  issueMethod: Method;
  code: string | null;
  benefit: Benefit;
  value: number | null;
  maxDiscount: number | null;
  minOrderAmount: number;
  startsAt: string;
  endsAt: string;
  validDays: number | null;
  issueLimit: number | null;
  issuedCount: number;
  productIds: string[];
  excludeDiscounted: boolean;
  allowWithReward: boolean;
  isActive: boolean;
  benefitText: string;
  status: Status;
  soldOut: boolean;
  used: number;
  discountTotal: number;
};
type Grade = { id: string; name: string; members: number };
type Product = { id: string; name: string };
type Data = {
  coupons: Coupon[];
  summary: { live: number; monthUsed: number; monthDiscount: number; monthCouponOrderRate: number; expiringSoon: number };
  grades: Grade[];
  products: Product[];
  canEdit: boolean;
};

const METHODS: { key: Method; label: string; desc: string }[] = [
  { key: "DOWNLOAD", label: "쇼핑몰에서 내려받기", desc: "구매자가 쿠폰함에서 받기" },
  { key: "CODE", label: "코드 입력", desc: "방송 채팅 · 문자로 코드 안내" },
  { key: "MANUAL", label: "직접 지급", desc: "등급을 골라 지급" },
];
const BENEFITS: { key: Benefit; label: string }[] = [
  { key: "AMOUNT", label: "금액 할인" },
  { key: "RATE", label: "비율 할인" },
  { key: "FREE_SHIPPING", label: "배송비 무료" },
];
const STATUS: Record<Status, { label: string; cls: string }> = {
  live: { label: "발급 중", cls: "b-done" },
  scheduled: { label: "예약", cls: "b-info" },
  ended: { label: "종료", cls: "b-gray nodot" },
};
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const methodLabel = (m: Method) => METHODS.find((x) => x.key === m)!.label;
const conditionText = (c: Pick<Coupon, "minOrderAmount" | "excludeDiscounted" | "productIds">) =>
  [c.minOrderAmount > 0 ? `${won(c.minOrderAmount)} 이상` : "금액 조건 없음", c.productIds.length > 0 ? `상품 ${c.productIds.length}개` : null, c.excludeDiscounted ? "할인 중 상품 제외" : null]
    .filter(Boolean)
    .join(" · ");

type Draft = {
  id: string | null;
  issued: number;
  name: string;
  issueMethod: Method;
  code: string;
  benefit: Benefit;
  value: string;
  maxDiscount: string;
  minOrderAmount: string;
  startsAt: string;
  endsAt: string;
  useValidDays: boolean;
  validDays: string;
  issueLimit: string;
  productIds: string[];
  excludeDiscounted: boolean;
  allowWithReward: boolean;
};
const randomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
function emptyDraft(): Draft {
  const start = new Date();
  start.setSeconds(0, 0);
  const end = new Date(start.getTime() + 30 * 86_400_000);
  return {
    id: null,
    issued: 0,
    name: "",
    issueMethod: "DOWNLOAD",
    code: "",
    benefit: "AMOUNT",
    value: "",
    maxDiscount: "",
    minOrderAmount: "",
    startsAt: toKstInput(start.toISOString()),
    endsAt: toKstInput(end.toISOString()),
    useValidDays: false,
    validDays: "",
    issueLimit: "",
    productIds: [],
    excludeDiscounted: true,
    allowWithReward: true,
  };
}
const str = (n: number | null) => (n === null ? "" : String(n));
const toDraft = (c: Coupon): Draft => ({
  id: c.id,
  issued: c.issuedCount,
  name: c.name,
  issueMethod: c.issueMethod,
  code: c.code ?? "",
  benefit: c.benefit,
  value: str(c.value),
  maxDiscount: str(c.maxDiscount),
  minOrderAmount: c.minOrderAmount ? String(c.minOrderAmount) : "",
  startsAt: toKstInput(c.startsAt),
  endsAt: toKstInput(c.endsAt),
  useValidDays: c.validDays !== null,
  validDays: str(c.validDays),
  issueLimit: str(c.issueLimit),
  productIds: c.productIds,
  excludeDiscounted: c.excludeDiscounted,
  allowWithReward: c.allowWithReward,
});
const num = (v: string) => (v.trim() === "" ? null : Number(v.replace(/,/g, "")));

type Filter = "all" | Status;

export default function CouponsPage() {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number; error?: string } | { kind: "ok"; data: Data }>({ kind: "loading" });
  const [filter, setFilter] = useState<Filter>("all");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [granting, setGranting] = useState<Coupon | null>(null);
  const [stopping, setStopping] = useState<Coupon | null>(null);
  const [deleting, setDeleting] = useState<Coupon | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  const load = useCallback(async () => {
    const r = await api<Data>("/api/seller/coupons");
    if (!r.ok) return setState({ kind: "error", status: r.status, error: r.error });
    setState({ kind: "ok", data: r.data });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const data = state.kind === "ok" ? state.data : null;
  const list = data?.coupons ?? [];
  const shown = filter === "all" ? list : list.filter((c) => c.status === filter);
  const editable = !!data?.canEdit;
  const count = (s: Status) => list.filter((c) => c.status === s).length;

  const setActive = async (c: Coupon, isActive: boolean) => {
    setBusy(true);
    const r = await api(`/api/seller/coupons/${c.id}`, { method: "PATCH", body: { isActive } });
    setBusy(false);
    setStopping(null);
    setToast(r.ok ? { text: isActive ? "다시 발급합니다" : "발급을 중지했습니다" } : { text: errorText(r, "바꾸지 못했습니다"), neg: true });
    await load();
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    const r = await api(`/api/seller/coupons/${deleting.id}`, { method: "DELETE" });
    setBusy(false);
    setDeleting(null);
    setToast(r.ok ? { text: "쿠폰을 삭제했습니다" } : { text: errorText(r, "삭제하지 못했습니다"), neg: true });
    await load();
  };

  return (
    <>
      <Topbar crumb="판매 › 쿠폰" />
      <main className="main">
        <div className="ph">
          <div className="col" style={{ gap: 6 }}>
            <h1 className="t-t3">쿠폰 관리</h1>
            <span className="t-l2 c-alt">할인 · 배송비 무료 쿠폰 발급과 사용 집계 · 내려받기 · 코드 입력 · 직접 지급</span>
          </div>
          {editable && (
            <button className="btn" type="button" onClick={() => setDraft(emptyDraft())}>
              쿠폰 만들기
            </button>
          )}
        </div>
        {data && !editable && (
          <div className="msg msg-info" role="status">
            <span>집계만 볼 수 있습니다. 쿠폰 발급 · 수정은 대표자나 적립금 권한이 있는 직원에게 요청해 주십시오.</span>
          </div>
        )}
        {data && (
          <section className="card cp-stats" aria-label="쿠폰 집계">
            <div className="stat">
              <span className="t-l2 c-alt">발급 중</span>
              <span className="v num">{data.summary.live}개</span>
            </div>
            <div className="stat">
              <span className="t-l2 c-alt">이번 달 사용</span>
              <span className="v num">{data.summary.monthUsed.toLocaleString("ko-KR")}장</span>
            </div>
            <div className="stat">
              <span className="t-l2 c-alt">이번 달 할인 총액</span>
              <span className="v num">{won(data.summary.monthDiscount)}</span>
            </div>
            <div className="stat">
              <span className="t-l2 c-alt">쿠폰 주문 비율</span>
              <span className="v num">{data.summary.monthCouponOrderRate}%</span>
              <span className="d">이번 달 쿠폰 쓴 주문 ÷ 전체 주문</span>
            </div>
            <div className="stat">
              <span className="t-l2 c-alt">만료 예정 (7일)</span>
              <span className="v num">{data.summary.expiringSoon}개</span>
            </div>
          </section>
        )}
        <section className="card" style={{ overflow: "hidden" }}>
          {state.kind === "loading" && <StateBox kind="loading" what="쿠폰" />}
          {state.kind === "error" && <StateBox kind={stateKind(state.status, state.error)} what="쿠폰" onRetry={() => void load()} />}
          {data && list.length === 0 && (
            <div className="st" style={{ boxShadow: "none" }}>
              <div className="st-ic">+</div>
              <span className="t">만든 쿠폰이 없습니다</span>
              <span className="s">가입 환영 · 방송 코드 · 등급 감사 쿠폰으로 재구매를 늘릴 수 있습니다</span>
              {editable && (
                <button className="btn btn-sm" type="button" onClick={() => setDraft(emptyDraft())}>
                  쿠폰 만들기
                </button>
              )}
            </div>
          )}
          {data && list.length > 0 && (
            <>
              <div className="tabs" role="tablist" style={{ padding: "0 12px" }}>
                {(
                  [
                    ["all", "전체", list.length],
                    ["live", "발급 중", count("live")],
                    ["scheduled", "예약", count("scheduled")],
                    ["ended", "종료", count("ended")],
                  ] as const
                ).map(([k, label, n]) => (
                  <button key={k} className={`tab${filter === k ? " on" : ""}`} type="button" role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}>
                    {label}
                    <span className="cnt">{n}</span>
                  </button>
                ))}
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="tbl cp-tbl">
                  <thead>
                    <tr>
                      <th>쿠폰 · 발급 방식</th>
                      <th>혜택 · 조건</th>
                      <th>사용 기간</th>
                      <th className="r">발급</th>
                      <th className="r">사용 (비율)</th>
                      <th className="r">할인 총액</th>
                      <th>상태</th>
                      {editable && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((c) => (
                      <tr key={c.id} data-testid="coupon-row" className={c.status === "ended" ? "faded" : undefined}>
                        <td>
                          <div className="col" style={{ gap: 2 }}>
                            <span className="fw6">{c.name}</span>
                            <span className="t-c1 c-alt">
                              {methodLabel(c.issueMethod)}
                              {c.code ? ` · ${c.code}` : ""}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className="col" style={{ gap: 2 }}>
                            <span>{c.benefitText}</span>
                            <span className="t-c1 c-alt">{conditionText(c)}</span>
                          </div>
                        </td>
                        <td className="num">
                          <div className="col" style={{ gap: 2 }}>
                            <span>
                              {kstText(c.startsAt)} ~ {kstText(c.endsAt)}
                            </span>
                            {c.validDays !== null && <span className="t-c1 c-alt">받은 뒤 {c.validDays}일</span>}
                          </div>
                        </td>
                        <td className="r num">
                          {c.issuedCount.toLocaleString("ko-KR")}
                          {c.issueLimit !== null && ` / ${c.issueLimit.toLocaleString("ko-KR")}`}
                          {c.soldOut && <span className="t-c1 c-alt"> · 소진</span>}
                        </td>
                        <td className="r num">
                          {c.used.toLocaleString("ko-KR")}
                          {c.issuedCount > 0 && <span className="c-alt"> ({Math.round((c.used / c.issuedCount) * 100)}%)</span>}
                        </td>
                        <td className="r num">{won(c.discountTotal)}</td>
                        <td>
                          <span className={`bdg ${STATUS[c.status].cls}`}>{STATUS[c.status].label}</span>
                        </td>
                        {editable && (
                          <td>
                            <span className="row" style={{ gap: 4, justifyContent: "flex-end", flexWrap: "nowrap" }}>
                              {c.issueMethod === "MANUAL" && c.status !== "ended" && (
                                <button className="btn btn-sm" type="button" onClick={() => setGranting(c)}>
                                  지급
                                </button>
                              )}
                              <button className="btn btn-sm btn-out" type="button" onClick={() => setDraft(toDraft(c))}>
                                수정
                              </button>
                              <button
                                className="btn btn-sm btn-out"
                                type="button"
                                onClick={() => setDraft({ ...toDraft(c), id: null, issued: 0, name: `${c.name} 복사본`.slice(0, 30), code: c.code ? randomCode() : "" })}
                              >
                                복제
                              </button>
                              {c.isActive ? (
                                <button className="btn btn-sm btn-text" type="button" onClick={() => setStopping(c)}>
                                  발급 중지
                                </button>
                              ) : (
                                <button className="btn btn-sm btn-text" type="button" disabled={busy} onClick={() => void setActive(c, true)}>
                                  다시 발급
                                </button>
                              )}
                              {c.issuedCount === 0 && (
                                <button className="btn btn-sm btn-text" type="button" style={{ color: "var(--neg-text)" }} onClick={() => setDeleting(c)}>
                                  삭제
                                </button>
                              )}
                            </span>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
        {data && list.length > 0 && (
          <span className="t-c1 c-alt">
            주문당 쿠폰 1장 · 1인 1장 · 전체 취소면 쿠폰 복구, 부분 취소면 복구 없음 · 발급 중지는 이미 받은 쿠폰에 영향 없음 · 발급 · 수정 · 중지는 로그 추적에 남음
          </span>
        )}
      </main>
      {draft && data && (
        <CouponEditor
          draft={draft}
          products={data.products}
          onClose={() => setDraft(null)}
          onSaved={async (text) => {
            setDraft(null);
            setToast({ text });
            await load();
          }}
        />
      )}
      {granting && data && (
        <GrantDialog
          coupon={granting}
          grades={data.grades}
          onClose={() => setGranting(null)}
          onDone={async (text) => {
            setGranting(null);
            setToast({ text });
            await load();
          }}
        />
      )}
      {stopping && (
        <div className="dim dim-fixed" role="dialog" aria-modal="true" aria-labelledby="cp-stop-title">
          <div className="modal">
            <div className="modal-h">
              <h2 className="t-h2" id="cp-stop-title">
                발급을 중지하시겠습니까?
              </h2>
              <span className="t-l2 c-alt">
                「{stopping.name}」을 더 이상 받을 수 없게 됩니다. 이미 받은 {stopping.issuedCount.toLocaleString("ko-KR")}장은 기간 안에 그대로 쓸 수 있습니다.
              </span>
            </div>
            <div className="modal-f">
              <button className="btn btn-out" type="button" onClick={() => setStopping(null)} disabled={busy}>
                취소
              </button>
              <button className="btn btn-neg" type="button" onClick={() => void setActive(stopping, false)} disabled={busy}>
                {busy ? "중지 중" : "발급 중지"}
              </button>
            </div>
          </div>
        </div>
      )}
      {deleting && (
        <ConfirmDelete title="쿠폰을 삭제하시겠습니까?" body={`「${deleting.name}」를 삭제합니다. 되돌릴 수 없습니다.`} busy={busy} onCancel={() => setDeleting(null)} onConfirm={() => void remove()} />
      )}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}

function CouponEditor({ draft: initial, products, onClose, onSaved }: { draft: Draft; products: Product[]; onClose: () => void; onSaved: (text: string) => void }) {
  const [d, setD] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [scoped, setScoped] = useState(initial.productIds.length > 0);
  const [q, setQ] = useState("");
  const set = (patch: Partial<Draft>) => setD((v) => ({ ...v, ...patch }));
  // 한 장이라도 발급했으면 발급 방식·혜택은 바꿀 수 없다(서버도 막음)
  const locked = d.id !== null && d.issued > 0;
  const productName = useMemo(() => new Map(products.map((p) => [p.id, p.name])), [products]);
  const matches = q.trim() ? products.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()) && !d.productIds.includes(p.id)).slice(0, 8) : [];

  const ready =
    d.name.trim() !== "" &&
    (d.issueMethod !== "CODE" || /^[A-Za-z0-9]{4,16}$/.test(d.code.trim())) &&
    (d.benefit === "FREE_SHIPPING" || (num(d.value) ?? 0) > 0) &&
    !!d.startsAt &&
    !!d.endsAt &&
    d.startsAt < d.endsAt &&
    (!d.useValidDays || (num(d.validDays) ?? 0) > 0) &&
    (!scoped || d.productIds.length > 0);

  const save = async () => {
    if (!ready || saving) return;
    setSaving(true);
    setFailure(null);
    const body = {
      name: d.name,
      issueMethod: d.issueMethod,
      code: d.issueMethod === "CODE" ? d.code.trim().toUpperCase() : null,
      benefit: d.benefit,
      value: d.benefit === "FREE_SHIPPING" ? null : num(d.value),
      maxDiscount: d.benefit === "RATE" ? num(d.maxDiscount) : null,
      minOrderAmount: num(d.minOrderAmount) ?? 0,
      startsAt: fromKstInput(d.startsAt),
      endsAt: fromKstInput(d.endsAt),
      validDays: d.useValidDays ? num(d.validDays) : null,
      issueLimit: num(d.issueLimit),
      productIds: scoped ? d.productIds : [],
      excludeDiscounted: d.excludeDiscounted,
      allowWithReward: d.allowWithReward,
    };
    const r = d.id ? await api(`/api/seller/coupons/${d.id}`, { method: "PUT", body }) : await api("/api/seller/coupons", { method: "POST", body });
    setSaving(false);
    if (!r.ok) return setFailure(errorText(r, "저장하지 못했습니다. 잠시 뒤 다시 시도해 주십시오"));
    onSaved(d.id ? "쿠폰을 저장했습니다" : `쿠폰을 저장했습니다 · ${kstText(fromKstInput(d.startsAt))}부터 발급`);
  };

  const previewAmount = d.benefit === "FREE_SHIPPING" ? "배송비 무료" : d.benefit === "AMOUNT" ? won(num(d.value) ?? 0) : `${num(d.value) ?? 0}%`;

  return (
    <div className="dim dim-fixed" role="dialog" aria-modal="true" aria-labelledby="cp-edit-title">
      <div className="modal modal-xl cp-modal">
        <div className="modal-h">
          <h2 className="t-h2" id="cp-edit-title">
            {d.id ? `쿠폰 수정 · ${initial.name}` : "쿠폰 만들기"}
          </h2>
        </div>
        {failure && (
          <div className="msg msg-neg" role="alert">
            <span>
              <b>저장할 수 없습니다.</b> {failure}
            </span>
          </div>
        )}
        <div className="cp-edit">
          <div className="col" style={{ gap: 16 }}>
            <div className="fld">
              <label htmlFor="cp-name" className="req">
                쿠폰 이름
              </label>
              <input id="cp-name" className="inp" value={d.name} maxLength={30} placeholder="예: 10월 스타라이트 오픈 기념" onChange={(e) => set({ name: e.target.value })} />
              <span className="help">구매자 쿠폰함에 그대로 표시 · 30자</span>
            </div>
            <div className="fld">
              <span className="lbl req" id="cp-method-label">
                발급 방식
              </span>
              <div className="seg" role="radiogroup" aria-labelledby="cp-method-label" style={{ alignSelf: "flex-start" }}>
                {METHODS.map((m) => (
                  <button key={m.key} type="button" role="radio" aria-checked={d.issueMethod === m.key} disabled={locked} className={d.issueMethod === m.key ? "on" : ""} onClick={() => set({ issueMethod: m.key })}>
                    {m.label}
                  </button>
                ))}
              </div>
              <span className="help">{METHODS.find((m) => m.key === d.issueMethod)!.desc}</span>
            </div>
            {d.issueMethod === "CODE" && (
              <div className="fld">
                <label htmlFor="cp-code" className="req">
                  쿠폰 코드
                </label>
                <div className="row" style={{ gap: 8 }}>
                  <input id="cp-code" className="inp" style={{ textTransform: "uppercase" }} value={d.code} maxLength={16} disabled={locked} onChange={(e) => set({ code: e.target.value.replace(/[^A-Za-z0-9]/g, "") })} />
                  <button className="btn btn-out" type="button" disabled={locked} onClick={() => set({ code: randomCode() })}>
                    자동 생성
                  </button>
                </div>
                <span className="help">영문 · 숫자 4~16자 · 대소문자 구분 없음 · 방송 채팅 · 문자로 안내</span>
              </div>
            )}
            <div className="fld">
              <span className="lbl req" id="cp-benefit-label">
                혜택
              </span>
              <div className="seg" role="radiogroup" aria-labelledby="cp-benefit-label" style={{ alignSelf: "flex-start" }}>
                {BENEFITS.map((b) => (
                  <button key={b.key} type="button" role="radio" aria-checked={d.benefit === b.key} disabled={locked} className={d.benefit === b.key ? "on" : ""} onClick={() => set({ benefit: b.key })}>
                    {b.label}
                  </button>
                ))}
              </div>
              {locked && <span className="help">발급한 쿠폰은 발급 방식 · 혜택을 바꿀 수 없습니다</span>}
            </div>
            <div className="cp-two">
              {d.benefit !== "FREE_SHIPPING" && (
                <div className="fld">
                  <label htmlFor="cp-value" className="req">
                    {d.benefit === "AMOUNT" ? "할인 금액 (원)" : "할인율 (%)"}
                  </label>
                  <input id="cp-value" className="inp num" inputMode="numeric" value={d.value} disabled={locked} onChange={(e) => set({ value: e.target.value.replace(/[^0-9]/g, "") })} />
                </div>
              )}
              {d.benefit === "RATE" && (
                <div className="fld">
                  <label htmlFor="cp-max">최대 할인 (원)</label>
                  <input id="cp-max" className="inp num" inputMode="numeric" value={d.maxDiscount} disabled={locked} placeholder="비우면 제한 없음" onChange={(e) => set({ maxDiscount: e.target.value.replace(/[^0-9]/g, "") })} />
                </div>
              )}
              <div className="fld">
                <label htmlFor="cp-min">최소 주문 금액 (원)</label>
                <input id="cp-min" className="inp num" inputMode="numeric" value={d.minOrderAmount} placeholder="0" onChange={(e) => set({ minOrderAmount: e.target.value.replace(/[^0-9]/g, "") })} />
                <span className="help">적용 상품 금액 기준 · 배송비 제외</span>
              </div>
            </div>
            <div className="fld">
              <span className="lbl req">사용 기간 (KST)</span>
              <div className="cp-period">
                <input className="inp" type="datetime-local" aria-label="사용 시작" value={d.startsAt} onChange={(e) => set({ startsAt: e.target.value })} />
                <span className="c-alt">~</span>
                <input className="inp" type="datetime-local" aria-label="사용 종료" value={d.endsAt} onChange={(e) => set({ endsAt: e.target.value })} />
              </div>
              {d.startsAt && d.endsAt && d.startsAt >= d.endsAt ? <span className="err">종료는 시작보다 늦어야 합니다</span> : <span className="help">이 기간에 받고 쓸 수 있음</span>}
              <label className="row t-l2" style={{ gap: 8 }}>
                <input className="cbx" type="checkbox" checked={d.useValidDays} onChange={(e) => set({ useValidDays: e.target.checked })} />
                받은 날부터
                <input className="inp inp-sm num" style={{ width: 72 }} inputMode="numeric" aria-label="받은 뒤 쓸 수 있는 날 수" value={d.validDays} disabled={!d.useValidDays} onChange={(e) => set({ validDays: e.target.value.replace(/[^0-9]/g, "") })} />
                일 동안 (사용 종료를 넘지 않음)
              </label>
            </div>
            <div className="fld">
              <label htmlFor="cp-limit">발급 수량 한도</label>
              <input id="cp-limit" className="inp num" inputMode="numeric" value={d.issueLimit} placeholder="비우면 제한 없음" onChange={(e) => set({ issueLimit: e.target.value.replace(/[^0-9]/g, "") })} />
              <span className="help">비우면 제한 없음 · 1인 1장{d.id && d.issued > 0 ? ` · 지금까지 ${d.issued.toLocaleString("ko-KR")}장 발급` : ""}</span>
            </div>
            <div className="fld">
              <span className="lbl" id="cp-scope-label">
                적용 상품
              </span>
              <div className="seg" role="radiogroup" aria-labelledby="cp-scope-label" style={{ alignSelf: "flex-start" }}>
                <button type="button" role="radio" aria-checked={!scoped} className={!scoped ? "on" : ""} onClick={() => setScoped(false)}>
                  전체 상품
                </button>
                <button type="button" role="radio" aria-checked={scoped} className={scoped ? "on" : ""} onClick={() => setScoped(true)}>
                  상품 선택
                </button>
              </div>
              {scoped && (
                <div className="col" style={{ gap: 8 }}>
                  <input className="inp" aria-label="상품 이름 검색" placeholder="상품 이름 검색" value={q} onChange={(e) => setQ(e.target.value)} />
                  {matches.length > 0 && (
                    <ul className="cp-pick">
                      {matches.map((p) => (
                        <li key={p.id}>
                          <button
                            type="button"
                            onClick={() => {
                              set({ productIds: [...d.productIds, p.id] });
                              setQ("");
                            }}
                          >
                            {p.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    {d.productIds.map((id) => (
                      <span key={id} className="chip">
                        {productName.get(id) ?? "삭제된 상품"}
                        <button type="button" aria-label={`${productName.get(id) ?? "상품"} 빼기`} onClick={() => set({ productIds: d.productIds.filter((x) => x !== id) })}>
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                  {d.productIds.length === 0 && <span className="err">상품을 1개 이상 골라 주십시오</span>}
                </div>
              )}
            </div>
            <label className="row t-l2" style={{ gap: 8 }}>
              <input className="cbx" type="checkbox" checked={d.excludeDiscounted} onChange={(e) => set({ excludeDiscounted: e.target.checked })} />
              할인 중인 상품 제외
            </label>
            <label className="row t-l2" style={{ gap: 8 }}>
              <input className="cbx" type="checkbox" checked={d.allowWithReward} onChange={(e) => set({ allowWithReward: e.target.checked })} />
              적립금과 함께 사용 허용
            </label>
          </div>
          <div className="cp-preview">
            <span className="t-hl2">구매자 쿠폰함 미리보기</span>
            <div className="cp-pv-card" data-testid="coupon-preview">
              <div className="cp-pv-amt">{previewAmount}</div>
              <div className="col" style={{ gap: 4, padding: "12px 14px", minWidth: 0 }}>
                <span className="t-l1 fw6">{d.name.trim() || "쿠폰 이름"}</span>
                <span className="t-c1 c-alt">
                  {conditionText({ minOrderAmount: num(d.minOrderAmount) ?? 0, excludeDiscounted: d.excludeDiscounted, productIds: scoped ? d.productIds : [] })}
                </span>
                <span className="t-c1 c-alt">{d.useValidDays && d.validDays ? `받은 날부터 ${d.validDays}일` : d.endsAt ? `${kstText(fromKstInput(d.endsAt)).slice(5, 10).replace(".", "/")}까지` : ""}</span>
              </div>
            </div>
            <span className="help">구매자 화면 문구는 해요체 그대로 표시 · 기한은 남은 날짜로 표시</span>
          </div>
        </div>
        <div className="modal-f">
          <button className="btn btn-out" type="button" onClick={onClose} disabled={saving}>
            취소
          </button>
          <button className="btn" type="button" onClick={() => void save()} disabled={!ready || saving}>
            {saving ? "저장 중" : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}

function GrantDialog({ coupon, grades, onClose, onDone }: { coupon: Coupon; grades: Grade[]; onClose: () => void; onDone: (text: string) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const total = grades.filter((g) => picked.includes(g.id)).reduce((s, g) => s + g.members, 0);

  const grant = async () => {
    setBusy(true);
    setFailure(null);
    const r = await api<{ granted: number; skipped: number }>(`/api/seller/coupons/${coupon.id}/grant`, { method: "POST", body: { gradeIds: picked } });
    setBusy(false);
    if (!r.ok) return setFailure(errorText(r, "지급하지 못했습니다"));
    onDone(`${r.data.granted.toLocaleString("ko-KR")}명에게 지급했습니다${r.data.skipped > 0 ? ` · 이미 받은 ${r.data.skipped.toLocaleString("ko-KR")}명 제외` : ""}`);
  };

  return (
    <div className="dim dim-fixed" role="dialog" aria-modal="true" aria-labelledby="cp-grant-title">
      <div className="modal">
        <div className="modal-h">
          <h2 className="t-h2" id="cp-grant-title">
            직접 지급 · {coupon.name}
          </h2>
          <span className="t-l2 c-alt">고른 등급의 회원에게 지급합니다. 이미 받은 회원은 건너뜁니다.</span>
        </div>
        {failure && (
          <div className="msg msg-neg" role="alert">
            <span>{failure}</span>
          </div>
        )}
        <div className="col" style={{ gap: 8 }}>
          {grades.map((g) => (
            <label key={g.id} className="row t-l1" style={{ gap: 8 }}>
              <input
                className="cbx"
                type="checkbox"
                checked={picked.includes(g.id)}
                onChange={(e) => setPicked((v) => (e.target.checked ? [...v, g.id] : v.filter((x) => x !== g.id)))}
              />
              {g.name} ({g.members.toLocaleString("ko-KR")}명)
            </label>
          ))}
        </div>
        {picked.length > 0 && <span className="t-l2">{total.toLocaleString("ko-KR")}명에게 지급됩니다. 지급 즉시 쿠폰함에 들어갑니다.</span>}
        <div className="modal-f">
          <button className="btn btn-out" type="button" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button className="btn" type="button" onClick={() => void grant()} disabled={busy || picked.length === 0}>
            {busy ? "지급 중" : picked.length > 0 ? `${total.toLocaleString("ko-KR")}명에게 지급` : "지급"}
          </button>
        </div>
      </div>
    </div>
  );
}
