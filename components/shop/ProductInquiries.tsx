"use client";

import { useCallback, useEffect, useState } from "react";
import { useConfirm } from "../admin-ui/ConfirmDialog";
import { kstDate } from "./kstDate";
import { announceCount } from "./pdEvents";
import { call } from "./reviewShared";
import ShopModal from "./ShopModal";

// IA ④ 상품 문의(보드 SH-003-IA): 공개 목록 GET /products/{id}/inquiries?cursor(상태 · 제목과 답변 · 작성자 · 날짜, 비공개는 「비밀글입니다」), 「문의하기」 POST /inquiries { kind:"PRODUCT", productId, title(50), body(2000), isPrivate }.
// 문의 사진 올리기·내 문의 고치기·지우기는 이 화면 범위 밖(서버는 있음, 내 문의 화면에서 이어서).
type Row = { id: string; isPrivate: boolean; author: string; title: string; body: string | null; answered: boolean; answer: string | null; answeredAt: string | null; createdAt: string };
type Data = { total: number; inquiries: Row[]; nextCursor: string | null };
const TITLE_MAX = 50;
const BODY_MAX = 2000;

export default function ProductInquiries({ slug, productId, loggedIn, onNeedLogin }: { slug: string; productId: string; loggedIn: boolean; onNeedLogin: () => void }) {
  const api = `/api/shop/${encodeURIComponent(slug)}`;
  const list = `${api}/products/${productId}/inquiries`;
  const [data, setData] = useState<Data | null>(null);
  const [state, setState] = useState<"loading" | "error" | "ok">("loading");
  const [more, setMore] = useState(false);
  const [writing, setWriting] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await call<Data>(list);
    if (r.ok) {
      setData(r.data);
      setState("ok");
      announceCount({ key: "inquiries", n: r.data.total });
    } else setState("error");
  }, [list]);
  useEffect(() => void load(), [load]);

  async function loadMore() {
    if (!data?.nextCursor || more) return;
    setMore(true);
    const r = await call<Data>(`${list}?cursor=${encodeURIComponent(data.nextCursor)}`);
    if (r.ok) setData({ ...data, inquiries: [...data.inquiries, ...r.data.inquiries], nextCursor: r.data.nextCursor });
    setMore(false);
  }

  return (
    <section className="pd-qna" id="pd-qna" aria-labelledby="pd-qna-h">
      <div className="pd-sec-h">
        <h2 id="pd-qna-h">상품 문의{data && data.total > 0 ? ` ${data.total.toLocaleString("ko-KR")}` : ""}</h2>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            setDone(null);
            if (loggedIn) setWriting(true);
            else onNeedLogin();
          }}
        >
          문의하기
        </button>
      </div>
      {done && (
        <p className="pd-msg" role="status">
          {done}
        </p>
      )}
      {state === "loading" && <p className="shop-empty">문의를 불러오고 있어요</p>}
      {state === "error" && (
        <p className="shop-empty">
          문의를 불러오지 못했어요.{" "}
          <button type="button" className="shop-linkbtn" onClick={() => void load()}>
            다시 불러오기
          </button>
        </p>
      )}
      {state === "ok" && data && data.inquiries.length === 0 && <p className="shop-empty">아직 문의가 없어요. 궁금한 점을 남겨 보세요.</p>}
      {state === "ok" && data && data.inquiries.length > 0 && (
        <>
          <table className="pd-qna-tbl">
            <caption className="pd-sr">상품 문의 목록</caption>
            <tbody>
              {data.inquiries.map((q) => (
                <tr key={q.id}>
                  <td className="pd-qna-st">
                    <span className={`pd-tag${q.answered ? " is-done" : ""}`}>{q.answered ? "답변 완료" : "답변 대기"}</span>
                  </td>
                  <td className="pd-qna-main">
                    <b>{q.isPrivate ? "🔒 비밀글이에요" : q.title}</b>
                    {q.isPrivate ? <p>작성자와 판매자만 볼 수 있어요</p> : q.body && <p>{q.body}</p>}
                    {q.answer && (
                      <p className="pd-qna-a">
                        <b>판매자 답변</b> {q.answer}
                      </p>
                    )}
                  </td>
                  <td className="pd-qna-who">{q.author}</td>
                  <td className="pd-qna-date">{kstDate(q.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.nextCursor && (
            <button type="button" className="btn btn-out pd-rv-more" disabled={more} aria-busy={more} onClick={() => void loadMore()}>
              {more ? "불러오고 있어요" : "문의 더 보기"}
            </button>
          )}
        </>
      )}
      {writing && (
        <WriteInquiry
          api={api}
          productId={productId}
          onClose={() => setWriting(false)}
          onSaved={() => {
            setWriting(false);
            setDone("문의를 남겼어요. 답변이 달리면 알려 드릴게요");
            void load();
          }}
        />
      )}
    </section>
  );
}

function WriteInquiry({ api, productId, onClose, onSaved }: { api: string; productId: string; onClose: () => void; onSaved: () => void }) {
  const { confirm } = useConfirm();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ready = title.trim() !== "" && body.trim() !== "";

  async function save() {
    if (!ready || busy) return;
    if (!(await confirm({ tone: "shop", title: "문의를 남길까요?", body: `${priv ? "판매자만" : "모두"} 볼 수 있어요. 답변이 달리면 고치거나 지울 수 없어요.`, confirmLabel: "남기기" }))) return;
    setBusy(true);
    setErr(null);
    const r = await call(`${api}/inquiries`, { method: "POST", body: { kind: "PRODUCT", productId, title: title.trim(), body: body.trim(), isPrivate: priv } });
    setBusy(false);
    if (r.ok) onSaved();
    else setErr(r.message ?? "문의를 남기지 못했어요. 잠시 뒤 다시 해 주세요");
  }

  return (
    <ShopModal
      title="상품 문의"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn btn-out" disabled={busy} onClick={onClose}>
            취소
          </button>
          <button type="button" className="btn" disabled={!ready || busy} aria-busy={busy} onClick={() => void save()}>
            {busy ? "남기고 있어요" : "문의 남기기"}
          </button>
        </>
      }
    >
      <div className="pd-qna-form">
        <label htmlFor="pq-title">제목</label>
        <input id="pq-title" className="inp" maxLength={TITLE_MAX} value={title} onChange={(e) => setTitle(e.target.value)} />
        <label htmlFor="pq-body">내용</label>
        <textarea id="pq-body" className="inp" rows={6} maxLength={BODY_MAX} value={body} onChange={(e) => setBody(e.target.value)} />
        <label className="chk">
          <input type="checkbox" className="cbx" checked={priv} onChange={(e) => setPriv(e.target.checked)} />
          비공개로 남겨요 (작성자와 판매자만 볼 수 있어요)
        </label>
        {err && (
          <p className="pd-err" role="alert">
            {err}
          </p>
        )}
      </div>
    </ShopModal>
  );
}
