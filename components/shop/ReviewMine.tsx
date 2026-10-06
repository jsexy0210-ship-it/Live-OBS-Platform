"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import MyMenu from "./MyMenu";
import ReviewWrite from "./ReviewWrite";
import { call, md, stars } from "./reviewShared";
import ShopBack from "./ShopBack";
import ShopModal from "./ShopModal";
import "./Cart.css";
import "./MyMenu.css";
import "./Reviews.css";

// SH-029 리뷰 쓰기·내 리뷰(한 화면): 위쪽에 리뷰 쓰기·고치기 상자, 아래쪽에 내가 쓴 리뷰 표(공개 상태·숨김 사유·판매자 답글, 고치기·지우기). API: /api/shop/{slug}/reviews.
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
const STATUS: Record<Mine["status"], string> = { VISIBLE: "공개", PENDING: "확인 중", HELD: "확인 중", HIDDEN: "숨김" };
// 쓰는 중인 대상: 주문 상품(item) 또는 고칠 리뷰(review)
type Target = { item: string } | { review: string } | null;
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

export default function ReviewMine({ slug, initialItem, initialReview }: { slug: string; initialItem?: string | null; initialReview?: string | null }) {
  const base = `/api/shop/${encodeURIComponent(slug)}/reviews`;
  const shop = `/shop/${encodeURIComponent(slug)}`;
  const [view, setView] = useState<{ kind: "loading" } | { kind: "login" } | { kind: "error" } | { kind: "ok"; data: Data }>({ kind: "loading" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [deleting, setDeleting] = useState<Mine | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [removing, setRemoving] = useState(false);
  // 고르지 않았으면(undefined) 처음 리뷰를 기다리는 상품을 쓴다. 취소하면 null(상자를 접는다)
  const [picked, setPicked] = useState<Target | undefined>(initialReview ? { review: initialReview } : initialItem ? { item: initialItem } : undefined);

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

  const saved = (text: string) => {
    setMsg({ ok: true, text });
    setPicked(null);
    void load();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  let content: React.ReactNode;
  if (view.kind === "loading") content = <p className="shop-empty" aria-busy="true">내 리뷰를 불러오고 있어요</p>;
  else if (view.kind === "login")
    content = (
      <div className="cart-empty">
        <p>로그인하면 내 리뷰를 볼 수 있어요.</p>
        <Link className="btn" href={`${shop}/login?next=${encodeURIComponent(`${shop}/reviews`)}`}>
          로그인
        </Link>
      </div>
    );
  else if (view.kind === "error")
    content = (
      <div className="cart-empty">
        <p>내 리뷰를 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요.</p>
        <button className="btn" type="button" onClick={() => void load()}>
          다시 불러오기
        </button>
      </div>
    );
  else {
    const { data } = view;
    const target: Target = picked === undefined ? (data.writable[0] ? { item: data.writable[0].orderItemId } : null) : picked;
    const w = target && "item" in target ? data.writable.find((x) => x.orderItemId === target.item) : undefined;
    content = (
      <>
        {msg && (
          <p className={`msg ${msg.ok ? "msg-pos" : "msg-neg"} t-l2`} role={msg.ok ? "status" : "alert"} style={{ display: "block" }}>
            {msg.text}
          </p>
        )}
        {target ? (
          <ReviewWrite
            key={"item" in target ? `i${target.item}` : `r${target.review}`}
            slug={slug}
            itemId={"item" in target ? target.item : null}
            reviewId={"review" in target ? target.review : null}
            writableUntil={w?.writableUntil}
            right={
              "item" in target && data.writable.length > 1 ? (
                <select className="inp rv-pick" aria-label="리뷰 쓸 상품" value={target.item} onChange={(e) => setPicked({ item: e.target.value })}>
                  {data.writable.map((x) => (
                    <option key={x.orderItemId} value={x.orderItemId}>
                      {x.productName}
                      {x.deliveredAt ? ` · ${md(x.deliveredAt)} 배송` : ""}
                    </option>
                  ))}
                </select>
              ) : undefined
            }
            onSaved={saved}
            onCancel={() => setPicked(null)}
          />
        ) : data.writable.length > 0 ? (
          <div className="rv-box">
            <div className="rv-box-h">
              <h2>리뷰 쓰기</h2>
              <span className="rv-box-r">리뷰를 기다리는 상품 {data.writable.length}개</span>
            </div>
            <div className="rv-box-b">
              <button className="btn" type="button" onClick={() => setPicked({ item: data.writable[0].orderItemId })}>
                리뷰 쓰기
              </button>
            </div>
          </div>
        ) : (
          <p className="rv-hint">지금 리뷰를 쓸 수 있는 상품이 없어요. 배송이 끝난 상품은 정해진 기간 안에 리뷰를 쓸 수 있어요.</p>
        )}
        {data.writableNextCursor && target && "item" in target && (
          <button className="btn btn-sm btn-out rv-more" type="button" disabled={loadingMore} onClick={() => void more("writable")}>
            리뷰를 기다리는 상품 더 보기
          </button>
        )}
        <section aria-labelledby="rv-mine-title">
          <div className="rv-st">
            <h2 id="rv-mine-title">내 리뷰</h2>
            <span>{data.reviews.length}건{data.nextCursor ? " 이상" : ""}</span>
          </div>
          {data.reviews.length === 0 ? (
            <p className="rv-hint" style={{ padding: "16px 0" }}>
              아직 쓴 리뷰가 없어요
            </p>
          ) : (
            <table className="cart-tbl rv-tbl">
              <thead>
                <tr>
                  <th>상품 · 내용</th>
                  <th className="c-star">별점</th>
                  <th className="c-st">상태</th>
                  <th className="c-dt">날짜</th>
                  <th className="c-act">관리</th>
                </tr>
              </thead>
              <tbody>
                {data.reviews.map((r) => (
                  <tr key={r.id} data-testid="my-review">
                    <td>
                      <b>{r.productName}</b>
                      <span className="rv-line">{r.body}</span>
                      {r.images.length > 0 && <span className="rv-line">사진 {r.images.length}장</span>}
                      {r.status === "HIDDEN" && (
                        <span className="rv-line rv-hidden">
                          이 리뷰는 숨겨졌어요 · 사유: {r.hiddenReason}
                          {r.hiddenNote ? ` (${r.hiddenNote})` : ""}
                        </span>
                      )}
                      {(r.status === "PENDING" || r.status === "HELD") && <span className="rv-line">판매자가 확인하면 공개돼요</span>}
                      {r.reply && <span className="rv-line">↳ 판매자 답글 · {r.reply}</span>}
                    </td>
                    <td className="c-star rv-mini-stars" aria-label={`${r.rating}점`}>
                      {stars(r.rating)}
                    </td>
                    <td className="c-st">{STATUS[r.status]}</td>
                    <td className="c-dt">{md(r.createdAt)}</td>
                    <td className="c-act">
                      {r.editable ? (
                        <>
                          <button className="btn btn-sm btn-out" type="button" onClick={() => { setMsg(null); setPicked({ review: r.id }); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
                            고치기
                          </button>{" "}
                          <button className="btn btn-sm btn-out" type="button" onClick={() => setDeleting(r)}>
                            지우기
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="rv-line">{r.status === "HIDDEN" ? "숨김" : "7일 지남"} · 지우기만</span>
                          <button className="btn btn-sm btn-out" type="button" onClick={() => setDeleting(r)}>
                            지우기
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.nextCursor && (
            <button className="btn btn-sm btn-out rv-more" type="button" disabled={loadingMore} onClick={() => void more("reviews")}>
              더 보기 ›
            </button>
          )}
        </section>
      </>
    );
  }

  return (
    <div className="shop-wrap cart-wrap">
      <ShopBack fallback={`${shop}/me`} label="내 정보" />
      <div className="cart-head">
        <h1>내 리뷰</h1>
      </div>
      <div className="my-wrap">
        <MyMenu slug={slug} />
        <div className="rv-main">{content}</div>
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
          지운 리뷰는 되돌릴 수 없고, 이 상품 리뷰는 다시 쓸 수 없어요.{deleting.rewardedAmount > 0 ? ` 지우면 받은 적립금 ${won(deleting.rewardedAmount)}은 돌려받아요.` : ""}
        </ShopModal>
      )}
    </div>
  );
}
