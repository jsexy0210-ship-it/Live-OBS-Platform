"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ShopState from "./ShopState";
import { call, md, RATING_TEXT, reencodePhoto } from "./reviewShared";
import "./Reviews.css";

// SH-029 리뷰 쓰기·고치기. 별점(필수)·사진(선택, 5장)·리뷰(10~1,000자). 사진은 이 화면에서 JPEG로 다시 저장해 올린다(위치 정보 제거).
// 쓰기: GET·POST /api/shop/{slug}/reviews/items/{orderItemId}. 고치기: 내 리뷰(GET /reviews)에서 찾아 PUT /reviews/{id}.
type Photo = { id: string; url: string };
type Item = { productName: string; optionName: string; quantity: number; orderedAt: string; deliveredAt: string | null; reward: { text: number; photo: number } };
type Mine = { id: string; productName: string; optionName: string; rating: number; body: string; images: Photo[]; editable: boolean };
const MAX_PHOTOS = 5;
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

export default function ReviewWrite({ slug, itemId, reviewId }: { slug: string; itemId: string | null; reviewId: string | null }) {
  const base = `/api/shop/${encodeURIComponent(slug)}/reviews`;
  const [view, setView] = useState<{ kind: "loading" } | { kind: "login" } | { kind: "closed" } | { kind: "error" } | { kind: "ok"; title: string; sub: string; reward: { text: number; photo: number } | null }>({ kind: "loading" });
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState("");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [done, setDone] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (itemId) {
      const r = await call<{ item: Item }>(`${base}/items/${encodeURIComponent(itemId)}`);
      if (!r.ok) return setView(r.status === 401 ? { kind: "login" } : r.status === 404 ? { kind: "closed" } : { kind: "error" });
      const i = r.data.item;
      return setView({ kind: "ok", title: `${i.productName}${i.quantity > 1 ? ` ×${i.quantity}` : ""}`, sub: `${md(i.orderedAt)} 주문${i.deliveredAt ? ` · ${md(i.deliveredAt)} 배송 완료` : ""}`, reward: i.reward });
    }
    const r = await call<{ reviews: Mine[] }>(base);
    if (!r.ok) return setView(r.status === 401 ? { kind: "login" } : { kind: "error" });
    const m = r.data.reviews.find((x) => x.id === reviewId);
    if (!m || !m.editable) return setView({ kind: "closed" });
    setRating(m.rating);
    setBody(m.body);
    setPhotos(m.images);
    setView({ kind: "ok", title: m.productName, sub: `옵션 ${m.optionName} · 리뷰 고치기`, reward: null });
  }, [base, itemId, reviewId]);

  useEffect(() => {
    void load();
  }, [load]);

  const addPhotos = async (files: FileList | null) => {
    // 입력 칸을 비우면 FileList도 비므로 먼저 배열로 옮긴다(같은 사진을 다시 고를 수 있게 칸은 바로 비움)
    const picked = files ? Array.from(files) : [];
    if (input.current) input.current.value = "";
    if (picked.length === 0 || uploading) return;
    setUploading(true);
    setMsg(null);
    for (const f of picked.slice(0, MAX_PHOTOS - photos.length)) {
      const blob = await reencodePhoto(f);
      if (!blob) {
        setMsg({ ok: false, text: "이 사진은 올릴 수 없어요. 다른 사진을 골라 주세요" });
        continue;
      }
      const r = await call<{ image: Photo }>(`${base}/images`, { method: "POST", raw: blob });
      if (!r.ok) {
        if (r.status === 401) return setView({ kind: "login" });
        setMsg({ ok: false, text: r.message ?? "사진을 올리지 못했어요. 잠시 뒤 다시 해 주세요" });
        continue;
      }
      setPhotos((p) => [...p, r.data.image]);
    }
    setUploading(false);
  };

  const length = [...body.trim()].length;
  const ready = rating > 0 && length >= 10 && length <= 1000 && !uploading && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setMsg(null);
    const payload = { rating, body, imageIds: photos.map((p) => p.id) };
    const r = itemId
      ? await call<{ status: string; grantedReward: number }>(`${base}/items/${encodeURIComponent(itemId)}`, { method: "POST", body: payload })
      : await call<{ status: string }>(`${base}/${encodeURIComponent(reviewId ?? "")}`, { method: "PUT", body: payload });
    setBusy(false);
    if (!r.ok) {
      if (r.status === 401) return setView({ kind: "login" });
      return setMsg({ ok: false, text: r.message ?? "리뷰를 올리지 못했어요. 잠시 뒤 다시 해 주세요" });
    }
    setDone(true);
    const granted = "grantedReward" in r.data ? (r.data.grantedReward as number) : 0;
    setMsg({
      ok: true,
      text:
        r.data.status === "VISIBLE"
          ? `${itemId ? "리뷰를 올렸어요" : "리뷰를 고쳤어요"}${granted > 0 ? ` · 적립금 ${won(granted)}을 드려요` : ""}`
          : `${itemId ? "리뷰를 올렸어요" : "리뷰를 고쳤어요"} · 판매자가 확인하면 공개돼요`,
    });
  };

  if (view.kind === "loading") return <section className="card shop-card" aria-busy="true"><span className="t-l1 c-alt">불러오고 있어요</span></section>;
  if (view.kind === "login") return <ShopState title="로그인이 필요해요" body="이 쇼핑몰에 로그인하면 리뷰를 쓸 수 있어요." />;
  if (view.kind === "closed") return <ShopState title="리뷰를 쓸 수 있는 기간이 지났어요" body="배송 완료 뒤 정해진 기간 안에만 쓰고, 쓴 뒤 7일 안에만 고칠 수 있어요." />;
  if (view.kind === "error")
    return (
      <section className="card shop-card col" style={{ gap: 12 }}>
        <span className="t-l1">불러오지 못했어요</span>
        <button className="btn btn-sm" type="button" style={{ alignSelf: "flex-start" }} onClick={() => void load()}>
          다시 시도
        </button>
      </section>
    );

  return (
    <section className="card shop-card col rv" aria-labelledby="rv-title">
      <h1 id="rv-title" className="t-h1">
        {itemId ? "리뷰 쓰기" : "리뷰 고치기"}
      </h1>
      <div className="col" style={{ gap: 2 }}>
        <span className="t-l1 fw6">{view.title}</span>
        <span className="t-c1 c-alt">{view.sub}</span>
      </div>
      <div className="col" style={{ gap: 6, alignItems: "center" }}>
        <span className="t-l2 c-alt" id="rv-rating">
          상품은 어땠나요?
        </span>
        <div className="rv-stars" role="radiogroup" aria-labelledby="rv-rating">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n}점`} className={`rv-star${n <= rating ? " on" : ""}`} disabled={done} onClick={() => setRating(n)}>
              ★
            </button>
          ))}
        </div>
        <span className="t-c1 fw6">{RATING_TEXT[rating] || " "}</span>
      </div>
      <div className="col" style={{ gap: 6 }}>
        <span className="lbl">사진 (선택)</span>
        <div className="rv-photos">
          {photos.map((p) => (
            <span key={p.id} className="rv-photo">
              <img src={p.url} alt="올린 사진" />
              {!done && (
                <button type="button" aria-label="사진 빼기" onClick={() => setPhotos((x) => x.filter((y) => y.id !== p.id))}>
                  ×
                </button>
              )}
            </span>
          ))}
          {photos.length < MAX_PHOTOS && !done && (
            <button className="rv-add" type="button" disabled={uploading} onClick={() => input.current?.click()}>
              <span className="t-hl1">+</span>
              <span className="t-c1 c-alt num">{uploading ? "올리는 중" : `${photos.length}/${MAX_PHOTOS}`}</span>
            </button>
          )}
          <input ref={input} type="file" accept="image/*" multiple hidden aria-label="리뷰 사진" onChange={(e) => void addPhotos(e.target.files)} />
        </div>
        {view.reward && (view.reward.photo > 0 || view.reward.text > 0) && (
          <span className="t-c1 c-alt">
            {view.reward.photo > 0 ? `사진을 1장 이상 넣으면 적립금 ${won(view.reward.photo)}` : ""}
            {view.reward.photo > 0 && view.reward.text > 0 ? ", " : ""}
            {view.reward.text > 0 ? `글만 쓰면 ${won(view.reward.text)}` : ""}을 드려요
          </span>
        )}
      </div>
      <div className="col" style={{ gap: 6 }}>
        <label className="lbl" htmlFor="rv-body">
          리뷰
        </label>
        <textarea id="rv-body" className="inp" style={{ minHeight: 110, padding: "10px 12px" }} value={body} maxLength={1000} disabled={done} onChange={(e) => setBody(e.target.value)} />
        <div className="row between t-c1 c-alt">
          <span>연락처 · 다른 쇼핑몰 주소는 쓸 수 없어요</span>
          <span className="num">{length.toLocaleString("ko-KR")} / 1,000</span>
        </div>
      </div>
      <span className="t-c1 c-alt">방송 닉네임으로 상품 리뷰에 공개돼요. 7일 안에 고칠 수 있어요.</span>
      {msg && (
        <p className={`msg ${msg.ok ? "msg-pos" : "msg-neg"} t-l2`} role={msg.ok ? "status" : "alert"}>
          {msg.text}
        </p>
      )}
      {done ? (
        <a className="btn btn-out" href={`/shop/${encodeURIComponent(slug)}/reviews`}>
          내 리뷰 보기
        </a>
      ) : (
        <>
          <button className="btn btn-lg btn-block" type="button" disabled={!ready} onClick={() => void submit()}>
            {busy ? "올리는 중" : itemId ? "리뷰 올리기" : "고친 리뷰 올리기"}
          </button>
          {rating > 0 && length < 10 && <span className="t-c1 c-alt">10자 이상 써 주시면 올릴 수 있어요</span>}
        </>
      )}
    </section>
  );
}
