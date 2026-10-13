"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useConfirm } from "../admin-ui/ConfirmDialog";
import MyMenu from "./MyMenu";
import ShopBack from "./ShopBack";
import { call, md } from "./reviewShared";
import "./Cart.css";
import "./Help.css";
import "./MyMenu.css";
import "./MyInquiries.css";

// SH-026 내 문의(보드 SH-026-IA FINAL): 탭(전체 · 상품 문의 · 1:1 문의, 개수) → 표(종류 · 내용 · 상태 · 날짜, 「답변 보기」로 펼침) · 「문의하기」 폼(종류 · 대상 · 제목* · 내용* · 공개).
// API: GET /api/shop/{slug}/inquiries?cursor(20개씩, 본인 것) · POST /inquiries { kind:"PRODUCT"|"GENERAL", productId?, title(50), body(2000), isPrivate }.
// 1:1 문의는 본인 주문을 대상으로 고를 수 있고, 기타 문의는 주문 선택 없이 남긴다.
type Item = { id: string; kind: "PRODUCT" | "GENERAL"; product: { id: string; name: string } | null; order: { id: string; orderNoLabel: string } | null; title: string; body: string; isPrivate: boolean; status: string; answer: string | null; answeredAt: string | null; createdAt: string };
type View = { kind: "loading" } | { kind: "login" } | { kind: "error" } | { kind: "ok"; items: Item[] };
type Tab = "all" | "PRODUCT" | "GENERAL";
const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "PRODUCT", label: "상품 문의" },
  { key: "GENERAL", label: "1:1 문의" },
];
const TITLE_MAX = 50;
const BODY_MAX = 2000;
const MAX_PAGES = 10; // 20개씩 최대 200개까지 읽는다

export default function MyInquiriesView({ slug, canWrite = true }: { slug: string; canWrite?: boolean }) {
  const { confirm } = useConfirm();
  const base = `/shop/${encodeURIComponent(slug)}`;
  const api = `/api/shop/${encodeURIComponent(slug)}`;
  const [view, setView] = useState<View>({ kind: "loading" });
  const [tab, setTab] = useState<Tab>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    const all: Item[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < MAX_PAGES; i += 1) {
      const r: Awaited<ReturnType<typeof call<{ inquiries: Item[]; nextCursor: string | null }>>> = await call(`${api}/inquiries${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!r.ok) return setView({ kind: r.status === 401 ? "login" : "error" });
      all.push(...r.data.inquiries);
      cursor = r.data.nextCursor;
      if (!cursor) break;
    }
    setView({ kind: "ok", items: all });
  }, [api]);
  useEffect(() => void load(), [load]);

  const items = view.kind === "ok" ? view.items : [];
  const count = (t: Tab) => (t === "all" ? items.length : items.filter((i) => i.kind === t).length);
  const shown = tab === "all" ? items : items.filter((i) => i.kind === tab);

  const body =
    view.kind === "loading" ? (
      <p className="shop-empty" aria-busy="true">
        문의를 불러오고 있어요
      </p>
    ) : view.kind === "login" ? (
      <div className="cart-empty">
        <p>로그인하면 볼 수 있어요</p>
        <Link className="btn" href={`${base}/login?next=${encodeURIComponent(`${base}/me/inquiries`)}`}>
          로그인
        </Link>
      </div>
    ) : view.kind === "error" ? (
      <div className="cart-empty">
        <p>불러오지 못했어요. 네트워크를 확인하고 다시 시도해 주세요.</p>
        <button className="btn" type="button" onClick={() => void load()}>
          다시 불러오기
        </button>
      </div>
    ) : (
      <>
        <div className="mi-top">
          <div className="help-tabs mi-tabs" role="tablist" aria-label="문의 종류">
            {TABS.map((t) => (
              <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
                {t.label} <span>{count(t.key)}</span>
              </button>
            ))}
          </div>
        </div>
        {done && (
          <p className="cart-msg" role="status">
            {done}
          </p>
        )}
        {shown.length === 0 ? (
          <div className="cart-empty">
            <h2>아직 문의가 없어요</h2>
            <p>상품 상세나 주문 상세에서 바로 물어볼 수 있어요</p>
          </div>
        ) : (
          <table className="cart-tbl help-tbl mi-tbl">
            <thead>
              <tr>
                <th>종류</th>
                <th>내용</th>
                <th>상태</th>
                <th className="c-date">날짜</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((i) => {
                const answered = i.status === "ANSWERED";
                return (
                  <tr key={i.id}>
                    <td>{i.kind === "PRODUCT" ? "상품 문의" : "1:1 문의"}</td>
                    <td>
                      {i.product && <span className="mi-target">{i.product.name}</span>}
                      {i.order && <span className="mi-target">주문 {i.order.orderNoLabel}</span>}
                      <b className="mi-title">
                        {i.title}
                        {i.isPrivate && <span aria-label="비공개"> 🔒</span>}
                      </b>
                      {answered && (
                        <button type="button" className="shop-linkbtn mi-open" aria-expanded={openId === i.id} onClick={() => setOpenId(openId === i.id ? null : i.id)}>
                          답변 보기
                        </button>
                      )}
                      {openId === i.id && (
                        <div className="mi-detail">
                          <p className="mi-q">{i.body}</p>
                          {i.answer && (
                            <div className="mi-a">
                              <p>{i.answer}</p>
                              <span>판매자{i.answeredAt ? ` · ${md(i.answeredAt)}` : ""}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      <span className={`bdg ${answered ? "b-done" : "b-wait"}`}>{answered ? "답변 완료" : "답변 대기"}</span>
                    </td>
                    <td className="c-date">{md(i.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {canWrite ? (
          <WriteForm
            api={api}
            confirmAsk={confirm}
            onSaved={() => {
              setDone("문의를 등록했어요 · 답변은 알림톡으로 알려 드려요");
              void load();
            }}
          />
        ) : (
          <p className="cart-msg" role="status">지금은 문의를 등록할 수 없어요. 이전 문의와 답변은 확인할 수 있어요.</p>
        )}
      </>
    );

  return (
    <div className="shop-wrap cart-wrap">
      <ShopBack fallback={`${base}/me`} label="내 정보" />
      <div className="cart-head">
        <h1>내 문의</h1>
      </div>
      <div className="my-wrap">
        <MyMenu slug={slug} />
        <div>{body}</div>
      </div>
    </div>
  );
}

type Product = { id: string; name: string };
type OrderTarget = { id: string; orderNoLabel: string };
function WriteForm({ api, confirmAsk, onSaved }: { api: string; confirmAsk: ReturnType<typeof useConfirm>["confirm"]; onSaved: () => void }) {
  const [kind, setKind] = useState<"PRODUCT" | "GENERAL">("PRODUCT");
  const [products, setProducts] = useState<Product[] | null>(null);
  const [productId, setProductId] = useState("");
  const [orders, setOrders] = useState<OrderTarget[] | null>(null);
  const [orderError, setOrderError] = useState(false);
  const [orderId, setOrderId] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [priv, setPriv] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [errs, setErrs] = useState<{ title?: string; text?: string; product?: string }>({});

  useEffect(() => {
    let live = true;
    call<{ products: Product[] }>(`${api}/products?limit=60`).then((r) => {
      if (!live) return;
      setProducts(r.ok ? r.data.products : []);
    });
    call<{ orders: OrderTarget[] }>(`${api}/orders?limit=50`).then((r) => {
      if (live) {
        setOrders(r.ok ? r.data.orders : []);
        setOrderError(!r.ok);
      }
    });
    return () => {
      live = false;
    };
  }, [api]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const found: typeof errs = {};
    if (!title.trim()) found.title = "제목을 적어 주세요";
    if (!text.trim()) found.text = "내용을 적어 주세요";
    if (kind === "PRODUCT" && !productId) found.product = "문의할 상품을 골라 주세요";
    setErrs(found);
    if (Object.keys(found).length > 0) return;
    if (!(await confirmAsk({ tone: "shop", title: "문의를 등록할까요?", body: `${priv ? "작성자와 판매자만" : "모두"} 볼 수 있어요. 답변이 달리면 고치거나 지울 수 없어요.`, confirmLabel: "등록하기" }))) return;
    setBusy(true);
    setErr(null);
    const r = await call(`${api}/inquiries`, { method: "POST", body: { kind, ...(kind === "PRODUCT" ? { productId } : orderId ? { orderId } : {}), title: title.trim(), body: text.trim(), isPrivate: priv } });
    setBusy(false);
    if (!r.ok) return setErr(r.message ?? "문의를 등록하지 못했어요. 잠시 뒤 다시 해 주세요");
    setTitle("");
    setText("");
    setProductId("");
    setOrderId("");
    onSaved();
  }

  return (
    <form className="mi-box" onSubmit={submit} noValidate aria-labelledby="mi-form-h">
      <h2 id="mi-form-h">문의하기</h2>
      <div className="mi-rows">
        <div className="mi-row">
          <span className="mi-th" id="mi-kind-l">
            종류
          </span>
          <div className="mi-td mi-radios" role="radiogroup" aria-labelledby="mi-kind-l">
            <label className="chk">
              <input type="radio" name="mi-kind" checked={kind === "PRODUCT"} onChange={() => setKind("PRODUCT")} />
              상품 문의
            </label>
            <label className="chk">
              <input type="radio" name="mi-kind" checked={kind === "GENERAL"} onChange={() => setKind("GENERAL")} />
              1:1 문의 (주문 · 배송 · 기타)
            </label>
          </div>
        </div>
        {kind === "PRODUCT" && (
          <div className="mi-row">
            <label className="mi-th" htmlFor="mi-product">
              대상
            </label>
            <div className="mi-td">
              <select id="mi-product" className="inp" value={productId} aria-invalid={!!errs.product} onChange={(e) => setProductId(e.target.value)}>
                <option value="">{products === null ? "상품을 불러오고 있어요" : "상품을 골라 주세요"}</option>
                {(products ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {errs.product && (
                <span className="mi-err" role="alert">
                  {errs.product}
                </span>
              )}
            </div>
          </div>
        )}
        {kind === "GENERAL" && (
          <div className="mi-row">
            <label className="mi-th" htmlFor="mi-order">대상</label>
            <div className="mi-td">
              <select id="mi-order" className="inp" value={orderId} onChange={(e) => setOrderId(e.target.value)}>
                <option value="">{orders === null ? "주문을 불러오고 있어요" : "기타 문의 · 주문 선택 안 함"}</option>
                {(orders ?? []).map((o) => <option key={o.id} value={o.id}>주문 {o.orderNoLabel}</option>)}
              </select>
              {orderError && <span className="mi-err" role="alert">주문을 불러오지 못했어요. 화면을 새로고침해 주세요.</span>}
            </div>
          </div>
        )}
        <div className="mi-row">
          <label className="mi-th" htmlFor="mi-title">
            제목<i aria-hidden="true">*</i>
          </label>
          <div className="mi-td">
            <input id="mi-title" className="inp" maxLength={TITLE_MAX} placeholder="제목을 적어 주세요" value={title} aria-invalid={!!errs.title} onChange={(e) => setTitle(e.target.value)} />
            {errs.title && (
              <span className="mi-err" role="alert">
                {errs.title}
              </span>
            )}
          </div>
        </div>
        <div className="mi-row">
          <label className="mi-th" htmlFor="mi-body">
            내용<i aria-hidden="true">*</i>
          </label>
          <div className="mi-td">
            <textarea id="mi-body" className="inp" rows={5} maxLength={BODY_MAX} placeholder="궁금한 점을 적어 주세요 · 개인정보는 적지 마세요" value={text} aria-invalid={!!errs.text} onChange={(e) => setText(e.target.value)} />
            {errs.text && (
              <span className="mi-err" role="alert">
                {errs.text}
              </span>
            )}
          </div>
        </div>
        <div className="mi-row">
          <span className="mi-th">공개</span>
          <div className="mi-td">
            <label className="chk">
              <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} />
              비공개 (작성자와 판매자만 봐요)
            </label>
          </div>
        </div>
      </div>
      {err && (
        <p className="cart-msg is-err" role="alert">
          {err}
        </p>
      )}
      <div className="mi-actions">
        <button type="submit" className="btn" disabled={busy} aria-busy={busy}>
          {busy ? "등록하고 있어요" : "문의 등록"}
        </button>
      </div>
    </form>
  );
}
