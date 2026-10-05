"use client";

import { useCallback, useEffect, useState } from "react";
import { Topbar } from "../../../../../components/seller/SellerShell";
import { Toast } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";
import { useScrollRestore, useUrlState } from "../../../../../lib/client/navigation";
import { StateBox, errorText, kstText, stateKind } from "../banners/_shared/ui";
import "./reviews.css";

// SA-048 리뷰 관리(파트너스 관리자, 판매 › 리뷰). 목록·집계·별점 분포, 리뷰 상세(사진·답글·숨기기·공개), 리뷰 설정(공개 방식·적립금·기간·금지어).
// 조회는 파트너스 계정 누구나, 답글·숨김·공개·설정은 대표자·구매자 문의 권한 직원(서버가 canEdit으로 알려 줌). API: /api/seller/reviews.
type Status = "VISIBLE" | "PENDING" | "HELD" | "HIDDEN";
type Reason = "PRIVACY" | "OFF_TOPIC" | "ABUSE" | "AD" | "OTHER";
type Row = {
  id: string;
  productName: string;
  author: string;
  grade: string | null;
  rating: number;
  body: string;
  status: Status;
  heldLabel: string | null;
  photos: number;
  replied: boolean;
  reportCount: number;
  revokePending: number;
  createdAt: string;
};
type Policy = { publishMode: "IMMEDIATE" | "REVIEW"; rewardText: number; rewardPhoto: number; writableDays: number; bannedWords: string[] };
type Summary = {
  average: number | null;
  total: number;
  weekNew: number;
  weekPhoto: number;
  waitingReply: number;
  waitingOld: number;
  pendingOrHeld: number;
  autoHeld: number;
  distribution: { rating: number; count: number }[];
};
type Data = { reviews: Row[]; nextCursor: string | null; summary: Summary; policy: Policy; canEdit: boolean };
type Detail = {
  id: string;
  productName: string;
  optionName: string;
  quantity: number;
  author: string;
  rating: number;
  body: string;
  status: Status;
  heldLabel: string | null;
  hiddenReason: Reason | null;
  hiddenNote: string | null;
  reply: string | null;
  repliedAt: string | null;
  reportCount: number;
  reportReasons: Partial<Record<Reason, number>>;
  rewardedAmount: number;
  revokePending: number;
  images: { id: string; url: string }[];
  orderedAt: string;
  deliveredAt: string | null;
  createdAt: string;
};

const STATUS: Record<Status, { label: string; cls: string }> = {
  VISIBLE: { label: "공개", cls: "b-done" },
  PENDING: { label: "공개 대기", cls: "b-wait" },
  HELD: { label: "보류", cls: "b-warn" },
  HIDDEN: { label: "숨김", cls: "b-gray nodot" },
};
const REASONS: { key: Reason; label: string }[] = [
  { key: "PRIVACY", label: "개인정보 · 연락처 포함" },
  { key: "OFF_TOPIC", label: "상품과 무관한 내용" },
  { key: "ABUSE", label: "욕설 · 비방" },
  { key: "AD", label: "광고 · 외부 주소" },
  { key: "OTHER", label: "기타" },
];
const reasonLabel = (r: Reason) => REASONS.find((x) => x.key === r)!.label;
const stars = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
type Tab = "all" | "waiting" | "PENDING" | "HELD" | "HIDDEN";
const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "waiting", label: "답글 대기" },
  { key: "PENDING", label: "공개 대기" },
  { key: "HELD", label: "보류 · 신고" },
  { key: "HIDDEN", label: "숨김" },
];

export default function ReviewsPage() {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number; error?: string } | { kind: "ok"; data: Data }>({ kind: "loading" });
  // 탭·별점은 주소(?tab=·?rating=)가 기준이다. 다른 화면에 갔다 Back으로 돌아와도 그대로 복원된다(UX 감사 9.3). 틀린 값은 전체로 본다
  const [u, setU] = useUrlState({ tab: "all", rating: "" });
  const tab: Tab = TABS.some((t) => t.key === u.tab) ? (u.tab as Tab) : "all";
  const rating = ["5", "4", "low"].includes(u.rating) ? u.rating : "";
  const setTab = (t: Tab) => setU({ tab: t });
  const setRating = (v: string) => setU({ rating: v });
  const [more, setMore] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  const query = useCallback(
    (c?: string | null) => {
      const q = new URLSearchParams();
      if (tab === "waiting") q.set("waiting", "1");
      else if (tab !== "all") q.set("status", tab);
      if (rating) q.set("rating", rating);
      if (c) q.set("cursor", c);
      return `/api/seller/reviews?${q.toString()}`;
    },
    [tab, rating],
  );

  const load = useCallback(async () => {
    const r = await api<Data>(query());
    if (!r.ok) return setState({ kind: "error", status: r.status, error: r.error });
    setMore([]);
    setCursor(r.data.nextCursor);
    setState({ kind: "ok", data: r.data });
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  useScrollRestore("seller-reviews", state.kind === "ok");

  const loadMore = async () => {
    if (!cursor) return;
    const r = await api<Data>(query(cursor));
    if (!r.ok) return setToast({ text: errorText(r, "더 불러오지 못했습니다"), neg: true });
    setMore((m) => [...m, ...r.data.reviews]);
    setCursor(r.data.nextCursor);
  };

  const data = state.kind === "ok" ? state.data : null;
  const rows = data ? [...data.reviews, ...more] : [];
  const s = data?.summary;
  const distMax = s ? Math.max(1, ...s.distribution.map((d) => d.count)) : 1;

  return (
    <>
      <Topbar crumb="판매 › 리뷰" />
      <main className="main">
        <div className="ph">
          <div className="col" style={{ gap: 6 }}>
            <h1 className="t-t3">리뷰 관리</h1>
            <span className="t-l2 c-alt">구매자 상품 리뷰 확인 · 답글 · 숨김 · 신고 처리 · 리뷰 적립금 · 작성 조건 설정</span>
          </div>
          {data && (
            <button className="btn btn-out" type="button" onClick={() => setSettings(true)}>
              리뷰 설정
            </button>
          )}
        </div>
        {data && !data.canEdit && (
          <div className="msg msg-info" role="status">
            <span>리뷰 목록만 볼 수 있습니다. 답글 · 숨김 · 설정 변경은 대표자나 구매자 문의 권한이 있는 직원에게 요청해 주십시오.</span>
          </div>
        )}
        {s && (
          <section className="card rv-stats" aria-label="리뷰 집계">
            <div className="stat">
              <span className="t-l2 c-alt">평균 별점</span>
              <span className="v num">{s.average ?? "-"}</span>
              <span className="d">공개 리뷰 {s.total.toLocaleString("ko-KR")}개</span>
            </div>
            <div className="stat">
              <span className="t-l2 c-alt">이번 주 새 리뷰</span>
              <span className="v num">{s.weekNew}개</span>
              <span className="d">사진 리뷰 {s.weekPhoto}개</span>
            </div>
            <div className="stat">
              <span className="t-l2 c-alt">답글 대기</span>
              <span className="v num">{s.waitingReply}개</span>
              <span className="d">3일 넘은 리뷰 {s.waitingOld}개</span>
            </div>
            <div className="stat">
              <span className="t-l2 c-alt">공개 대기 · 보류</span>
              <span className="v num">{s.pendingOrHeld}개</span>
              <span className="d">자동 보류 {s.autoHeld}개</span>
            </div>
          </section>
        )}
        <section className="card" style={{ overflow: "hidden" }}>
          {state.kind === "loading" && <StateBox kind="loading" what="리뷰" />}
          {state.kind === "error" && <StateBox kind={stateKind(state.status, state.error)} what="리뷰" onRetry={() => void load()} />}
          {data && (
            <>
              <div className="row between" style={{ padding: "0 12px", flexWrap: "wrap", gap: 8 }}>
                <div className="tabs" role="tablist">
                  {TABS.map((t) => (
                    <button key={t.key} className={`tab${tab === t.key ? " on" : ""}`} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
                      {t.label}
                    </button>
                  ))}
                </div>
                <select className="inp inp-sm" style={{ width: 120 }} aria-label="별점" value={rating} onChange={(e) => setRating(e.target.value)}>
                  <option value="">별점 전체</option>
                  <option value="5">5점</option>
                  <option value="4">4점</option>
                  <option value="low">3점 이하</option>
                </select>
              </div>
              {rows.length === 0 ? (
                <div className="st" style={{ boxShadow: "none" }}>
                  <span className="t">아직 리뷰가 없습니다</span>
                  <span className="s">배송 완료 뒤 구매자가 리뷰를 쓸 수 있습니다 · 리뷰 적립금을 켜면 작성률이 올라갑니다</span>
                </div>
              ) : (
                <div role="list">
                  {rows.map((r) => (
                    <div key={r.id} className="rv-row" role="listitem" tabIndex={0} data-testid="review-row" onClick={() => setOpenId(r.id)} onKeyDown={(e) => e.key === "Enter" && setOpenId(r.id)}>
                      <span className="col" style={{ gap: 2, minWidth: 0 }}>
                        <span className="t-l2 fw6 ell">{r.productName}</span>
                        <span className="t-c1 c-alt">
                          {r.author}
                          {r.grade ? ` (${r.grade})` : ""}
                        </span>
                      </span>
                      <span className="rv-star rv-hide-m" aria-label={`${r.rating}점`}>
                        {stars(r.rating)}
                      </span>
                      <span className="col rv-hide-m" style={{ gap: 2, minWidth: 0 }}>
                        <span className="t-l2 rv-body">{r.status === "HELD" && r.heldLabel ? `[${r.heldLabel}] ` : ""}{r.body}</span>
                        <span className="t-c1 c-alt num">
                          {kstText(r.createdAt).slice(5, 10)} · {r.photos > 0 ? `사진 ${r.photos}장` : "사진 없음"}
                          {r.replied ? " · 답글 완료" : ""}
                          {r.reportCount > 0 ? ` · 신고 ${r.reportCount}건` : ""}
                          {r.revokePending > 0 ? ` · 환불된 주문 · 적립금 수동 회수 필요 ${won(r.revokePending)}` : ""}
                        </span>
                      </span>
                      <span>
                        <span className={`bdg ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
                      </span>
                      <span className="t-c1 c-alt">{r.replied ? "답글 보기" : "답글"}</span>
                    </div>
                  ))}
                </div>
              )}
              {cursor && (
                <div style={{ padding: 12 }}>
                  <button className="btn btn-out btn-block" type="button" onClick={() => void loadMore()}>
                    더 보기
                  </button>
                </div>
              )}
            </>
          )}
        </section>
        {s && s.total > 0 && (
          <section className="card pad col" style={{ gap: 8 }} aria-label="별점 분포">
            <span className="t-hl2">별점 분포</span>
            {s.distribution.map((d) => (
              <div key={d.rating} className="rv-dist t-c1">
                <span>{d.rating}점</span>
                <span className="rv-bar">
                  <span style={{ width: `${(d.count / distMax) * 100}%` }} />
                </span>
                <span className="num c-alt">{s.total ? Math.round((d.count / s.total) * 100) : 0}%</span>
              </div>
            ))}
          </section>
        )}
        {data && <span className="t-c1 c-alt">숨긴 리뷰는 작성자에게만 보이고 별점 평균에서 제외 · 삭제는 작성자만 가능 · 답글 · 숨김 · 공개 전환은 로그 추적에 남음</span>}
      </main>
      {openId && data && (
        <ReviewDetail
          id={openId}
          canEdit={data.canEdit}
          onClose={() => setOpenId(null)}
          onChanged={async (text) => {
            setToast({ text });
            await load();
          }}
        />
      )}
      {settings && data && (
        <PolicyDialog
          policy={data.policy}
          canEdit={data.canEdit}
          onClose={() => setSettings(false)}
          onSaved={async () => {
            setSettings(false);
            setToast({ text: "리뷰 설정을 저장했습니다" });
            await load();
          }}
        />
      )}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}

function ReviewDetail({ id, canEdit, onClose, onChanged }: { id: string; canEdit: boolean; onClose: () => void; onChanged: (text: string) => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [hiding, setHiding] = useState(false);
  const [reason, setReason] = useState<Reason | null>(null);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const r = await api<{ review: Detail }>(`/api/seller/reviews/${id}`);
    if (!r.ok) return setFailed(errorText(r, "리뷰를 불러오지 못했습니다"));
    setD(r.data.review);
    setReply(r.data.review.reply ?? "");
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (path: string, method: string, body: unknown, done: string) => {
    setBusy(true);
    setFailed(null);
    const r = await api<{ revokedReward?: number; grantedReward?: number }>(`/api/seller/reviews/${id}/${path}`, { method, body });
    setBusy(false);
    if (!r.ok) return setFailed(errorText(r, "처리하지 못했습니다. 잠시 뒤 다시 시도해 주십시오"));
    const extra = r.data.revokedReward ? ` · 리뷰 적립금 ${won(r.data.revokedReward)} 회수` : r.data.grantedReward ? ` · 리뷰 적립금 ${won(r.data.grantedReward)} 지급` : "";
    setHiding(false);
    onChanged(done + extra);
    await load();
  };

  return (
    <div className="dim dim-fixed" role="dialog" aria-modal="true" aria-labelledby="rv-detail-title">
      <div className="modal modal-lg rv-modal">
        <div className="modal-h">
          <h2 className="t-h2" id="rv-detail-title">
            {d ? `답글 · ${d.author} · ${d.productName}` : "리뷰"}
          </h2>
        </div>
        {failed && (
          <div className="msg msg-neg" role="alert">
            <span>{failed}</span>
          </div>
        )}
        {d && (
          <div className="col" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 8 }}>
              <span className={`bdg ${STATUS[d.status].cls}`}>{STATUS[d.status].label}</span>
              {d.heldLabel && <span className="t-c1 c-alt">{d.heldLabel}</span>}
              {d.reportCount > 0 && (
                <span className="t-c1 c-alt">
                  신고 {d.reportCount}건 ·{" "}
                  {Object.entries(d.reportReasons)
                    .map(([k, n]) => `${reasonLabel(k as Reason)} ${n}`)
                    .join(" · ")}
                </span>
              )}
            </div>
            {d.images.length > 0 && (
              <div className="rv-imgs">
                {d.images.map((i) => (
                  <img key={i.id} src={i.url} alt="리뷰 사진" />
                ))}
              </div>
            )}
            <span className="rv-star">{stars(d.rating)}</span>
            <span className="t-c1 c-alt num">
              {kstText(d.createdAt)} · {kstText(d.orderedAt).slice(5, 10)} 주문 · 옵션 {d.optionName} ×{d.quantity}
              {d.deliveredAt ? ` · 배송 완료 뒤 ${Math.max(0, Math.floor((new Date(d.createdAt).getTime() - new Date(d.deliveredAt).getTime()) / 86_400_000))}일` : ""}
            </span>
            <p className="t-l1" style={{ whiteSpace: "pre-line", margin: 0 }}>
              {d.body}
            </p>
            {d.revokePending > 0 ? (
              <span className="t-c1" style={{ color: "var(--neg-text)" }} role="status">
                환불된 주문 · 적립금 수동 회수 필요 {won(d.revokePending)}
              </span>
            ) : (
              d.rewardedAmount > 0 && <span className="t-c1 c-alt">리뷰 적립금 {won(d.rewardedAmount)} 지급</span>
            )}
            {d.status === "HIDDEN" && d.hiddenReason && (
              <span className="t-c1 c-alt">
                숨김 사유: {reasonLabel(d.hiddenReason)}
                {d.hiddenNote ? ` · ${d.hiddenNote}` : ""}
              </span>
            )}
            <div className="fld">
              <label htmlFor="rv-reply">답글</label>
              <textarea id="rv-reply" className="inp" style={{ minHeight: 88, padding: "10px 12px" }} value={reply} maxLength={300} disabled={!canEdit} onChange={(e) => setReply(e.target.value)} />
              <span className="help">상품 리뷰에 「판매자」 이름으로 공개 · 300자 · 개인정보 · 연락처 기재 금지</span>
            </div>
            {hiding && (
              <div className="col" style={{ gap: 8, padding: 12, borderRadius: 10, background: "var(--wds-fill-alternative)" }}>
                <span className="t-l1 fw6">이 리뷰를 숨기시겠습니까?</span>
                <span className="t-c1 c-alt">
                  상품 리뷰와 별점 평균에서 빠지고 작성자에게만 보입니다.{d.rewardedAmount > 0 ? ` 지급한 리뷰 적립금 ${won(d.rewardedAmount)}은 회수됩니다.` : ""} 사유는 작성자의 내 리뷰에 표시됩니다.
                </span>
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  {REASONS.map((x) => (
                    <button key={x.key} type="button" className={`chip${reason === x.key ? " on" : ""}`} aria-pressed={reason === x.key} onClick={() => setReason(x.key)}>
                      {x.label}
                    </button>
                  ))}
                </div>
                <input className="inp" aria-label="사유 설명" placeholder="사유 설명 (선택, 200자)" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
                <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
                  <button className="btn btn-sm btn-out" type="button" onClick={() => setHiding(false)} disabled={busy}>
                    취소
                  </button>
                  <button className="btn btn-sm btn-neg" type="button" disabled={!reason || busy} onClick={() => void act("hide", "POST", { reason, note: note.trim() || null }, "리뷰를 숨겼습니다")}>
                    숨기기
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        <div className="modal-f">
          <button className="btn btn-out" type="button" onClick={onClose} disabled={busy}>
            닫기
          </button>
          {d && canEdit && (
            <>
              {d.status !== "HIDDEN" && !hiding && (
                <button className="btn btn-text" type="button" style={{ color: "var(--neg-text)" }} onClick={() => setHiding(true)}>
                  숨기기
                </button>
              )}
              {d.status !== "VISIBLE" && (
                <button className="btn btn-out" type="button" disabled={busy} onClick={() => void act("publish", "POST", {}, d.status === "HIDDEN" ? "다시 공개했습니다" : "리뷰를 공개했습니다")}>
                  {d.status === "HIDDEN" ? "다시 공개" : "공개"}
                </button>
              )}
              <button className="btn" type="button" disabled={busy || reply.trim() === (d.reply ?? "")} onClick={() => void act("reply", "PUT", { reply: reply.trim() || null }, reply.trim() ? "답글을 저장했습니다" : "답글을 지웠습니다")}>
                답글 저장
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PolicyDialog({ policy, canEdit, onClose, onSaved }: { policy: Policy; canEdit: boolean; onClose: () => void; onSaved: () => void }) {
  const [p, setP] = useState(policy);
  const [words, setWords] = useState(policy.bannedWords.join(", "));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const num = (v: string) => Number(v.replace(/[^0-9]/g, "") || "0");

  const save = async () => {
    setBusy(true);
    setFailed(null);
    const body = { ...p, bannedWords: words.split(",").map((w) => w.trim()).filter(Boolean) };
    const r = await api("/api/seller/reviews/policy", { method: "PUT", body });
    setBusy(false);
    if (!r.ok) return setFailed(errorText(r, "저장하지 못했습니다"));
    onSaved();
  };

  return (
    <div className="dim dim-fixed" role="dialog" aria-modal="true" aria-labelledby="rv-policy-title">
      <div className="modal modal-lg rv-modal">
        <div className="modal-h">
          <h2 className="t-h2" id="rv-policy-title">
            리뷰 설정
          </h2>
        </div>
        {failed && (
          <div className="msg msg-neg" role="alert">
            <span>{failed}</span>
          </div>
        )}
        <div className="col" style={{ gap: 14 }}>
          <div className="fld">
            <span className="lbl" id="rv-mode-label">
              공개 방식
            </span>
            <div className="seg" role="radiogroup" aria-labelledby="rv-mode-label" style={{ alignSelf: "flex-start" }}>
              {(
                [
                  ["IMMEDIATE", "바로 공개"],
                  ["REVIEW", "확인 뒤 공개"],
                ] as const
              ).map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={p.publishMode === k} className={p.publishMode === k ? "on" : ""} disabled={!canEdit} onClick={() => setP({ ...p, publishMode: k })}>
                  {label}
                </button>
              ))}
            </div>
            <span className="help">{p.publishMode === "REVIEW" ? "새 리뷰는 「공개 대기」로 들어옵니다" : "연락처 · 외부 주소 · 금지어가 있으면 보류합니다"}</span>
          </div>
          <div className="row" style={{ gap: 12 }}>
            <div className="fld grow">
              <label htmlFor="rv-reward-text">일반 리뷰 적립금 (원)</label>
              <input id="rv-reward-text" className="inp num" inputMode="numeric" disabled={!canEdit} value={p.rewardText} onChange={(e) => setP({ ...p, rewardText: num(e.target.value) })} />
            </div>
            <div className="fld grow">
              <label htmlFor="rv-reward-photo">사진 리뷰 적립금 (원)</label>
              <input id="rv-reward-photo" className="inp num" inputMode="numeric" disabled={!canEdit} value={p.rewardPhoto} onChange={(e) => setP({ ...p, rewardPhoto: num(e.target.value) })} />
            </div>
          </div>
          <span className="help">0원이면 지급하지 않습니다 · 공개될 때 지급, 숨김 · 삭제 때 회수 · 적립금 실지급이 꺼져 있으면 예정으로 보관</span>
          <div className="fld">
            <label htmlFor="rv-days">작성 가능 기간 (배송 완료 뒤 일)</label>
            <input id="rv-days" className="inp num" inputMode="numeric" style={{ width: 120 }} disabled={!canEdit} value={p.writableDays} onChange={(e) => setP({ ...p, writableDays: num(e.target.value) })} />
            <span className="help">주문당 상품별 1회 · 작성자는 7일 안에 고칠 수 있음</span>
          </div>
          <div className="fld">
            <label htmlFor="rv-words">금지어</label>
            <input id="rv-words" className="inp" disabled={!canEdit} placeholder="쉼표로 구분 · 20자 이하 50개까지" value={words} onChange={(e) => setWords(e.target.value)} />
            <span className="help">연락처 · 외부 주소는 자동으로 검사합니다 · 걸리면 보류</span>
          </div>
        </div>
        <div className="modal-f">
          <button className="btn btn-out" type="button" onClick={onClose} disabled={busy}>
            {canEdit ? "취소" : "닫기"}
          </button>
          {canEdit && (
            <button className="btn" type="button" disabled={busy} onClick={() => void save()}>
              {busy ? "저장 중" : "저장"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
