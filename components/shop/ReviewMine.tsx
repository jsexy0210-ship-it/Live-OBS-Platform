"use client";

import { useCallback, useEffect, useState } from "react";
import ShopState from "./ShopState";
import { call, md, stars } from "./reviewShared";
import "./Reviews.css";
import ShopModal from "./ShopModal";

// SH-029 내 리뷰: 쓸 수 있는 상품(리뷰 쓰기)과 내가 쓴 리뷰(공개 상태·숨김 사유·판매자 답글, 고치기·지우기). API: /api/shop/{slug}/reviews.
type Writable = { orderItemId: string; productName: string; optionName: string; deliveredAt: string | null; writableUntil: string | null };
type Mine = {
  id: string;
  productName: string;
  rating: number;
  body: string;
  status: "VISIBLE" | "PENDING" | "HELD" | "HIDDEN";
  hiddenReason: string | null;
  hiddenNote: string | null;
  reply: string | null;
  repliedAt: string | null;
  rewardedAmount: number;
  images: { id: string; url: string }[];
  createdAt: string;
  editable: boolean;
};
type Data = { writable: Writable[]; writableNextCursor: string | null; reviews: Mine[]; nextCursor: string | null; reward: { text: number; photo: number } };
const STATUS: Record<Mine["status"], { label: string; cls: string }> = {
  VISIBLE: { label: "공개", cls: "b-done" },
  PENDING: { label: "확인 중", cls: "b-wait" },
  HELD: { label: "확인 중", cls: "b-wait" },
  HIDDEN: { label: "숨김", cls: "b-cancel" },
};
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

export default function ReviewMine({ slug }: { slug: string }) {
  const base = `/api/shop/${encodeURIComponent(slug)}/reviews`;
  const [view, setView] = useState<{ kind: "loading" } | { kind: "login" } | { kind: "error" } | { kind: "ok"; data: Data }>({ kind: "loading" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [deleting, setDeleting] = useState<Mine | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    const r = await call<Data>(base);
    if (r.ok) return setView({ kind: "ok", data: r.data });
    setView(r.status === 401 || r.status === 404 ? { kind: "login" } : { kind: "error" });
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  // 더 보기: 리뷰를 기다리는 상품(writable) 또는 내가 쓴 리뷰(reviews)의 다음 쪽을 이어 붙인다
  const more = async (list: "writable" | "reviews") => {
    if (view.kind !== "ok" || loadingMore) return;
    const cursor = list === "writable" ? view.data.writableNextCursor : view.data.nextCursor;
    if (!cursor) return;
    setLoadingMore(true);
    const r = await call<Data>(`${base}?${list === "writable" ? "writableCursor" : "cursor"}=${cursor}`);
    setLoadingMore(false);
    if (!r.ok) return setMsg({ ok: false, text: r.message ?? "더 불러오지 못했어요. 잠시 뒤 다시 해 주세요" });
    setView((v) =>
      v.kind !== "ok"
        ? v
        : {
            kind: "ok",
            data:
              list === "writable"
                ? { ...v.data, writable: [...v.data.writable, ...r.data.writable], writableNextCursor: r.data.writableNextCursor }
                : { ...v.data, reviews: [...v.data.reviews, ...r.data.reviews], nextCursor: r.data.nextCursor },
          },
    );
  };

  const remove = async () => {
    if (!deleting || removing) return;
    setRemoving(true);
    const r = await call<{ revokedReward: number }>(`${base}/${deleting.id}`, { method: "DELETE" });
    setRemoving(false);
    setDeleting(null);
    setMsg(r.ok ? { ok: true, text: `리뷰를 지웠어요${r.data.revokedReward > 0 ? ` · 적립금 ${won(r.data.revokedReward)}은 돌려받았어요` : ""}` } : { ok: false, text: r.message ?? "지우지 못했어요. 잠시 뒤 다시 해 주세요" });
    await load();
  };

  if (view.kind === "loading") return <section className="card shop-card" aria-busy="true"><span className="t-l1 c-alt">내 리뷰를 불러오고 있어요</span></section>;
  if (view.kind === "login") return <ShopState title="로그인이 필요해요" body="이 쇼핑몰에 로그인하면 내 리뷰를 볼 수 있어요." />;
  if (view.kind === "error")
    return (
      <section className="card shop-card col" style={{ gap: 12 }}>
        <span className="t-l1">내 리뷰를 불러오지 못했어요</span>
        <button className="btn btn-sm" type="button" style={{ alignSelf: "flex-start" }} onClick={() => void load()}>
          다시 불러오기
        </button>
      </section>
    );

  const { data } = view;
  const rewardHint = data.reward.photo > 0 || data.reward.text > 0 ? `리뷰 쓰면 ${won(Math.max(data.reward.photo, data.reward.text))}까지` : null;
  return (
    <section className="card shop-card col rv" aria-labelledby="rv-mine-title">
      <h1 id="rv-mine-title" className="t-h1">
        내 리뷰
      </h1>
      {msg && (
        <p className={`msg ${msg.ok ? "msg-pos" : "msg-neg"} t-l2`} role={msg.ok ? "status" : "alert"}>
          {msg.text}
        </p>
      )}
      {data.writable.length > 0 && (
        <div className="col" style={{ gap: 4 }}>
          <span className="t-hl2">리뷰를 기다리는 상품</span>
          <ul className="rv-list">
            {data.writable.map((w) => (
              <li key={w.orderItemId} className="rv-item" style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <span className="col" style={{ gap: 2 }}>
                  <span className="t-l1 fw6">{w.productName}</span>
                  <span className="t-c1 c-alt">
                    {w.writableUntil ? `${md(w.writableUntil)}까지 쓸 수 있어요` : ""}
                    {rewardHint ? ` · ${rewardHint}` : ""}
                  </span>
                </span>
                <a className="btn btn-sm" href={`/shop/${encodeURIComponent(slug)}/reviews/write?item=${w.orderItemId}`}>
                  리뷰 쓰기
                </a>
              </li>
            ))}
          </ul>
          {data.writableNextCursor && (
            <button className="btn btn-sm" type="button" style={{ alignSelf: "center" }} disabled={loadingMore} onClick={() => void more("writable")}>
              더 보기
            </button>
          )}
        </div>
      )}
      <div className="col" style={{ gap: 4 }}>
        <span className="t-hl2">내가 쓴 리뷰</span>
        {data.reviews.length === 0 ? (
          <span className="t-l2 c-alt" style={{ padding: "16px 0" }}>
            아직 쓴 리뷰가 없어요
          </span>
        ) : (
          <ul className="rv-list">
            {data.reviews.map((r) => (
              <li key={r.id} className="rv-item" data-testid="my-review">
                <div className="row between">
                  <span className="t-l1 fw6">{r.productName}</span>
                  <span className={`bdg ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
                </div>
                <span className="t-c1 c-alt">
                  <span className="rv-mini-stars" aria-label={`${r.rating}점`}>
                    {stars(r.rating)}
                  </span>{" "}
                  · {md(r.createdAt)}
                  {r.images.length > 0 ? ` · 사진 ${r.images.length}장` : ""}
                </span>
                <span className="t-l2" style={{ whiteSpace: "pre-line" }}>
                  {r.body}
                </span>
                {r.status === "HIDDEN" && (
                  <div className="msg msg-cau t-l2" style={{ display: "block" }}>
                    <b>이 리뷰는 판매자가 숨겼어요.</b> 사유: {r.hiddenReason}
                    {r.hiddenNote ? ` (${r.hiddenNote})` : ""}. 궁금하면 판매자에게 문의해 주세요.
                  </div>
                )}
                {(r.status === "PENDING" || r.status === "HELD") && <span className="t-c1 c-alt">판매자가 확인하면 공개돼요</span>}
                {r.reply && (
                  <div className="rv-reply">
                    <span className="t-c1 fw6">판매자{r.repliedAt ? ` · ${md(r.repliedAt)}` : ""}</span>
                    <span className="t-l2" style={{ whiteSpace: "pre-line" }}>
                      {r.reply}
                    </span>
                  </div>
                )}
                <div className="row" style={{ gap: 8 }}>
                  {r.editable && (
                    <a className="btn btn-sm btn-out" href={`/shop/${encodeURIComponent(slug)}/reviews/write?review=${r.id}`}>
                      고치기
                    </a>
                  )}
                  <button className="btn btn-sm btn-text" type="button" onClick={() => setDeleting(r)}>
                    지우기
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {data.nextCursor && (
          <button className="btn btn-sm" type="button" style={{ alignSelf: "center" }} disabled={loadingMore} onClick={() => void more("reviews")}>
            더 보기
          </button>
        )}
      </div>
      {deleting && (
        <ShopModal
          title="리뷰를 지울까요?"
          onClose={() => setDeleting(null)}
          busy={removing}
          footer={
            <>
              <button className="btn btn-out" type="button" disabled={removing} onClick={() => setDeleting(null)}>
                취소
              </button>
              <button className="btn btn-neg" type="button" disabled={removing} onClick={() => void remove()}>
                지우기
              </button>
            </>
          }
        >
          지운 리뷰는 되돌릴 수 없고, 이 상품 리뷰는 다시 쓸 수 없어요.{deleting.rewardedAmount > 0 ? ` 받은 적립금 ${won(deleting.rewardedAmount)}은 돌려받아요.` : ""}
        </ShopModal>
      )}
    </section>
  );
}
