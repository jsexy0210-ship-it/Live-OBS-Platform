"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConfirm } from "../admin-ui/ConfirmDialog";
import { call, md, RATING_TEXT, reencodePhoto } from "./reviewShared";
import "./Reviews.css";

// SH-029 리뷰 쓰기·고치기(내 리뷰 화면 위쪽 상자). 별점(필수)·내용(10~1,000자)·사진(선택, 5장). 사진은 이 화면에서 JPEG로 다시 저장해 올린다(위치 정보 제거).
// 쓰기: GET·POST /api/shop/{slug}/reviews/items/{orderItemId}. 고치기: GET·PUT /reviews/{id}(목록에서 찾지 않고 id로 직접 읽는다).
type Photo = { id: string; url: string };
type Item = { productName: string; optionName: string; quantity: number; orderedAt: string; deliveredAt: string | null; reward: { text: number; photo: number } };
type Mine = { id: string; productName: string; optionName: string; rating: number; body: string; images: Photo[]; editable: boolean };
const MAX_PHOTOS = 5;
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

type Props = { slug: string; itemId: string | null; reviewId: string | null; writableUntil?: string | null; right?: React.ReactNode; onSaved: (text: string) => void; onCancel?: () => void };

export default function ReviewWrite({ slug, itemId, reviewId, writableUntil, right, onSaved, onCancel }: Props) {
  const { confirm } = useConfirm();
  const base = `/api/shop/${encodeURIComponent(slug)}/reviews`;
  const [view, setView] = useState<{ kind: "loading" } | { kind: "login" } | { kind: "closed" } | { kind: "error" } | { kind: "ok"; title: string; sub: string; reward: { text: number; photo: number } | null }>({ kind: "loading" });
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState("");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
    const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (itemId) {
      const r = await call<{ item: Item }>(`${base}/items/${encodeURIComponent(itemId)}`);
      if (!r.ok) return setView(r.status === 401 ? { kind: "login" } : r.status === 404 ? { kind: "closed" } : { kind: "error" });
      const i = r.data.item;
      return setView({ kind: "ok", title: `${i.productName}${i.quantity > 1 ? ` ×${i.quantity}` : ""}`, sub: `${md(i.orderedAt)} 주문${i.deliveredAt ? ` · ${md(i.deliveredAt)} 배송 완료` : ""}`, reward: i.reward });
    }
    if (!reviewId) return setView({ kind: "closed" });
    const r = await call<{ review: Mine }>(`${base}/${encodeURIComponent(reviewId)}`);
    if (!r.ok) return setView(r.status === 401 ? { kind: "login" } : r.status === 404 ? { kind: "closed" } : { kind: "error" });
    const m = r.data.review;
    if (!m.editable) return setView({ kind: "closed" });
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
      // 줄여서(긴 변 1,600px JPEG) 올린다. 줄이지 못하면 JPG·PNG·WEBP 원본을 그대로 보내고, 서버가 같은 기준으로 검사한다
      const blob = (await reencodePhoto(f)) ?? (["image/jpeg", "image/png", "image/webp"].includes(f.type) ? f : null);
      if (!blob) {
        setMsg({ ok: false, text: "이 사진은 올릴 수 없어요. JPG·PNG·WEBP 사진을 골라 주세요" });
        continue;
      }
      const r = await call<{ image: Photo }>(`${base}/images`, { method: "POST", raw: blob });
      if (!r.ok) {
        if (r.status === 401) return setView({ kind: "login" });
        setMsg({ ok: false, text: r.message ?? "사진을 올리지 못했어요. 다른 사진으로 다시 올려 주세요" });
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
    const edit = !itemId;
    if (!(await confirm({ tone: "shop", title: edit ? "고친 리뷰를 올릴까요?" : "리뷰를 올릴까요?", body: "방송 닉네임으로 공개돼요. 올린 뒤 7일 안에만 고칠 수 있어요.", confirmLabel: "올리기" }))) return;
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
    const granted = "grantedReward" in r.data ? (r.data.grantedReward as number) : 0;
    const what = itemId ? "리뷰를 등록했어요" : "리뷰를 고쳤어요";
    onSaved(r.data.status === "VISIBLE" ? `${what}${granted > 0 ? ` · 적립금 ${won(granted)}이 들어왔어요` : ""}` : `${what} · 판매자가 확인하면 공개돼요`);
  };

  if (view.kind === "loading")
    return (
      <section className="rv-box" aria-busy="true">
        <div className="rv-box-h">{itemId ? "리뷰 쓰기" : "리뷰 고치기"}</div>
        <p className="rv-box-note">불러오고 있어요</p>
      </section>
    );
  if (view.kind !== "ok")
    return (
      <section className="rv-box">
        <div className="rv-box-h">{itemId ? "리뷰 쓰기" : "리뷰 고치기"}</div>
        <div className="rv-box-b">
          <p className="msg msg-cau t-l2" role="alert" style={{ display: "block" }}>
            {view.kind === "login"
              ? "로그인하면 리뷰를 쓸 수 있어요"
              : view.kind === "closed"
                ? "리뷰를 쓸 수 있는 기간이 지났어요. 배송 완료 뒤 정해진 기간 안에만 쓰고, 쓴 뒤 7일 안에만 고칠 수 있어요"
                : "불러오지 못했어요. 네트워크를 확인하고 다시 시도해 주세요"}
          </p>
          {view.kind === "error" && (
            <button className="btn btn-sm" type="button" onClick={() => void load()}>
              다시 불러오기
            </button>
          )}
        </div>
      </section>
    );

  const reward = view.reward && (view.reward.photo > 0 || view.reward.text > 0) ? view.reward : null;
  const hints = [
    ...(itemId && reward ? [reward.text > 0 ? `리뷰를 쓰면 적립금 ${won(reward.text)}${reward.photo > 0 ? ` (사진 리뷰 ${won(reward.photo)})` : ""}` : `사진 리뷰를 쓰면 적립금 ${won(reward.photo)}`] : []),
    ...(itemId && writableUntil ? [`${md(writableUntil)}까지 쓸 수 있어요`] : []),
    "등록 뒤 7일 안에 고칠 수 있어요",
  ];
  return (
    <section className="rv-box" aria-labelledby="rv-title">
      <div className="rv-box-h">
        <h2 id="rv-title">{itemId ? "리뷰 쓰기" : "리뷰 고치기"}</h2>
        <span className="rv-box-r">{right ?? `${view.title} · ${view.sub}`}</span>
      </div>
      <div className="rv-box-b">
        <div className="rv-row">
          <span className="rv-th" id="rv-rating">
            별점<i>*</i>
          </span>
          <div className="rv-td rv-rate">
            <div className="rv-stars" role="radiogroup" aria-labelledby="rv-rating">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n}점`} className={`rv-star${n <= rating ? " on" : ""}`} onClick={() => setRating(n)}>
                  ★
                </button>
              ))}
            </div>
            <span className="rv-hint">{rating > 0 ? `${rating}점` : "별을 눌러 주세요"}</span>
          </div>
        </div>
        <div className="rv-row">
          <label className="rv-th" htmlFor="rv-body">
            내용<i>*</i>
          </label>
          <div className="rv-td">
            <textarea id="rv-body" className="inp" placeholder="상품은 어땠나요? 10자 이상 적어 주세요 (개인정보 · 욕설 금지)" value={body} maxLength={1000} onChange={(e) => setBody(e.target.value)} />
            <span className="rv-hint num">{length.toLocaleString("ko-KR")} / 1,000자</span>
          </div>
        </div>
        <div className="rv-row">
          <span className="rv-th">사진</span>
          <div className="rv-td">
            <div className="rv-photos">
              {Array.from({ length: MAX_PHOTOS }, (_, i) => {
                const p = photos[i];
                if (p)
                  return (
                    <span key={p.id} className="rv-photo">
                      <img src={p.url} alt="올린 사진" />
                      <button type="button" aria-label="사진 빼기" onClick={() => setPhotos((x) => x.filter((y) => y.id !== p.id))}>
                        ×
                      </button>
                    </span>
                  );
                const first = i === photos.length;
                return first ? (
                  <button key={`s${i}`} className="rv-add" type="button" disabled={uploading} onClick={() => input.current?.click()}>
                    {uploading ? "올리는 중" : i === 0 ? "+ 사진" : String(i + 1)}
                  </button>
                ) : (
                  <span key={`s${i}`} className="rv-add is-off" aria-hidden>
                    {i + 1}
                  </span>
                );
              })}
              <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden aria-label="리뷰 사진" onChange={(e) => void addPhotos(e.target.files)} />
            </div>
            <span className="rv-hint">최대 5장 · JPG · PNG · WEBP · 장당 5MB · 연락처 · 외부 링크는 적을 수 없어요</span>
          </div>
        </div>
        <div className="rv-row">
          <span className="rv-th">공개</span>
          <div className="rv-td">
            <span className="rv-hint">방송 닉네임으로 공개돼요</span>
          </div>
        </div>
        {msg && (
          <p className={`msg ${msg.ok ? "msg-pos" : "msg-neg"} t-l2`} role={msg.ok ? "status" : "alert"}>
            {msg.text}
          </p>
        )}
        <div className="rv-actions">
          {onCancel && (
            <button className="btn btn-lg btn-out" type="button" disabled={busy} onClick={onCancel}>
              취소
            </button>
          )}
          <button className="btn btn-lg" type="button" disabled={!ready} onClick={() => void submit()}>
            {busy ? "올리는 중" : itemId ? "리뷰 등록" : "고친 리뷰 올리기"}
          </button>
        </div>
        {rating > 0 && length < 10 && <span className="rv-hint rv-c">10자 이상 적어 주세요</span>}
        <span className="rv-hint rv-c">{hints.join(" · ")}</span>
      </div>
    </section>
  );
}
