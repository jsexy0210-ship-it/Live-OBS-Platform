"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { CART_COUNT_EVENT } from "./ShopChrome";
import { call } from "./reviewShared";
import "./Cart.css";
import "./Checkout.css";

// SH-005 주문서(시안 04 SH). 서버가 지금 받는 범위만 만든다: 주문 상품·배송지·쿠폰·필수 동의 → 주문 생성(결제 대기).
// 결제 수단 선택·결제는 주문 상세(OrderPay)에서 한다. 적립금·닉네임·받는 방법·배송비 미리보기는 해당 API가 생기면 붙인다(금액은 주문 때 서버가 다시 계산).
type Line = { id: string; productName: string; optionName: string; quantity: number; lineTotal: number };
type Checkout = { items: { optionId: string; quantity: number }[]; lines: Line[]; subtotal: number };
type Addr = { id: string; label: string | null; recipientName: string; phone: string; zipCode: string; address1: string; address2: string | null; memo: string | null; isDefault: boolean };
type Coupon = { couponId: string; name: string; benefitText: string; minOrderAmount: number | null; state: string };
type Consent = { version: string; text: string };
type Data = { checkout: Checkout; addresses: Addr[]; coupons: Coupon[]; consent: Consent };
type View = { kind: "loading" } | { kind: "login" } | { kind: "noids" } | { kind: "blocked"; message: string; names: string[] } | { kind: "error"; message?: string } | { kind: "ok"; data: Data };
type Preview = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "ok"; shippingFee: number; isRemote: boolean; total: number };
type Form = { recipientName: string; phone: string; zipCode: string; address1: string; address2: string; memo: string };

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const EMPTY: Form = { recipientName: "", phone: "", zipCode: "", address1: "", address2: "", memo: "" };
const NEW = "new";

function check(f: Form) {
  const e: Partial<Record<keyof Form, string>> = {};
  if (!f.recipientName.trim()) e.recipientName = "받는 분 이름을 적어 주세요";
  if (!/^0\d{8,10}$/.test(f.phone.replace(/[ -]/g, ""))) e.phone = "연락처를 숫자로 적어 주세요 (예: 01012345678)";
  if (!/^\d{5}$/.test(f.zipCode.trim())) e.zipCode = "우편번호 5자리를 적어 주세요";
  if (!f.address1.trim()) e.address1 = "주소를 적어 주세요";
  return e;
}

export default function CheckoutView({ slug, memberNickname = "" }: { slug: string; memberNickname?: string }) {
  const base = `/shop/${encodeURIComponent(slug)}`;
  const api = `/api/shop/${encodeURIComponent(slug)}`;
  const router = useRouter();
  const ids = (useSearchParams().get("ids") ?? "").split(",").filter(Boolean);
  const idsKey = ids.join(",");
  const [view, setView] = useState<View>({ kind: "loading" });
  const [addrId, setAddrId] = useState<string>(NEW);
  const [form, setForm] = useState<Form>(EMPTY);
  const [save, setSave] = useState(true);
  const [couponId, setCouponId] = useState("");
  const [nickname, setNickname] = useState(memberNickname); // 기본값은 회원 방송 닉네임
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview>({ kind: "idle" });

  useEffect(() => {
    if (!idsKey) return setView({ kind: "noids" });
    let live = true;
    (async () => {
      const [co, ad, cp, cs] = await Promise.all([
        call<Checkout>(`${api}/cart/checkout?ids=${encodeURIComponent(idsKey)}`),
        call<{ addresses: Addr[] }>(`${api}/addresses`),
        call<{ usable: Coupon[] }>(`${api}/coupons`),
        call<{ consents: Consent[] }>(`${api}/order-consent`),
      ]);
      if (!live) return;
      if (!co.ok) {
        if (co.status === 401) return setView({ kind: "login" });
        const lines = (co as { lines?: { productName: string }[] }).lines;
        return setView(co.status === 409 && lines ? { kind: "blocked", message: co.message ?? "주문할 수 없는 상품이 있어요", names: lines.map((l) => l.productName) } : { kind: "error", message: co.message });
      }
      if (!cs.ok || cs.data.consents.length === 0) return setView({ kind: "error", message: cs.ok ? undefined : cs.message });
      const addresses = ad.ok ? ad.data.addresses : [];
      setAddrId(addresses[0]?.id ?? NEW); // 기본 배송지가 맨 앞
      setView({ kind: "ok", data: { checkout: co.data, addresses, coupons: cp.ok ? cp.data.usable.filter((c) => c.state === "usable") : [], consent: cs.data.consents[0] } });
    })();
    return () => {
      live = false;
    };
  }, [api, idsKey]);

  const errors = useMemo(() => (addrId === NEW ? check(form) : {}), [addrId, form]);
  // 배송비 미리보기: 상품·배송지(우편번호 5자리·주소)가 정해지면 서버가 계산한 값을 받는다(쿠폰 할인 전, 저장 안 함)
  const okData = view.kind === "ok" ? view.data : null;
  const picked = okData?.addresses.find((a) => a.id === addrId);
  const zip = picked ? picked.zipCode : form.zipCode.trim();
  const addr1 = picked ? picked.address1 : form.address1.trim();
  const previewItems = okData?.checkout.items;
  useEffect(() => {
    if (!previewItems || !/^\d{5}$/.test(zip) || !addr1) return setPreview({ kind: "idle" });
    let live = true;
    setPreview({ kind: "loading" });
    const t = window.setTimeout(async () => {
      const r = await call<{ shippingFee: number; isRemote: boolean; total: number }>(`${api}/payments/shipping-preview`, { method: "POST", body: { items: previewItems, zipCode: zip, address1: addr1 } });
      if (live) setPreview(r.ok ? { kind: "ok", shippingFee: r.data.shippingFee, isRemote: r.data.isRemote, total: r.data.total } : { kind: "error", message: r.message ?? "배송비를 계산하지 못했어요" });
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [api, previewItems, zip, addr1]);
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const head = (
    <div className="cart-head">
      <h1>주문서</h1>
      <ol className="cart-steps" aria-label="주문 단계">
        <li>
          <i>01</i>장바구니
        </li>
        <li aria-current="step">
          <i>02</i>주문서
        </li>
        <li>
          <i>03</i>주문 완료
        </li>
      </ol>
    </div>
  );
  const wrap = (body: React.ReactNode) => (
    <div className="shop-wrap cart-wrap">
      {head}
      {body}
    </div>
  );

  if (view.kind === "loading") return <div aria-busy="true">{wrap(<p className="shop-empty">주문서를 불러오고 있어요</p>)}</div>;
  if (view.kind === "login")
    return wrap(
      <div className="cart-empty">
        <p>로그인하면 주문할 수 있어요.</p>
        <Link className="btn" href={`${base}/login?next=${encodeURIComponent(`${base}/cart`)}`}>
          로그인
        </Link>
      </div>,
    );
  if (view.kind === "noids" || view.kind === "blocked" || view.kind === "error")
    return wrap(
      <div className="cart-empty">
        <p>{view.kind === "noids" ? "주문할 상품을 장바구니에서 골라 주세요." : view.kind === "blocked" ? `${view.message}` : (view.message ?? "주문서를 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.")}</p>
        {view.kind === "blocked" && <p className="cart-opt">{view.names.join(", ")}</p>}
        <Link className="btn" href={`${base}/cart`}>
          장바구니로 가기
        </Link>
      </div>,
    );

  const { checkout, addresses, coupons, consent } = view.data;
  const nickOk = nickname.trim().length <= 20;
  const addrOk = addrId !== NEW || Object.keys(errors).length === 0;
  const canSubmit = addrOk && nickOk && agreed && !busy;

  async function submit() {
    setTried(true);
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const picked = addresses.find((a) => a.id === addrId);
    const shippingAddress = picked
      ? { recipientName: picked.recipientName, phone: picked.phone, zipCode: picked.zipCode, address1: picked.address1, address2: picked.address2 ?? undefined, memo: picked.memo ?? undefined }
      : { recipientName: form.recipientName.trim(), phone: form.phone.replace(/[ -]/g, ""), zipCode: form.zipCode.trim(), address1: form.address1.trim(), address2: form.address2.trim() || undefined, memo: form.memo.trim() || undefined };
    const r = await call<{ orderId: string }>(`${api}/orders`, {
      method: "POST",
      body: { items: checkout.items, consent: { agreed: true, noticeVersion: consent.version }, shippingAddress, saveAddress: picked ? false : save, ...(nickname.trim() ? { orderNickname: nickname.trim() } : {}), ...(couponId ? { couponId } : {}) },
    });
    if (!r.ok) {
      setError(r.message ?? "주문하지 못했어요. 잠시 뒤 다시 해 주세요");
      return setBusy(false);
    }
    const cleared = await call<{ count: number }>(`${api}/cart`, { method: "DELETE", body: { itemIds: ids } }); // 주문한 줄은 장바구니에서 뺀다(실패해도 주문은 이미 됐다)
    if (cleared.ok) window.dispatchEvent(new CustomEvent(CART_COUNT_EVENT, { detail: cleared.data.count })); // 머리 배지도 바로 맞춘다
    router.push(`${base}/orders/${r.data.orderId}?done=1`);
  }

  const field = (k: keyof Form, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="co-field">
      <label htmlFor={`co-${k}`}>{label}</label>
      <input id={`co-${k}`} className={`inp${tried && errors[k] ? " is-error" : ""}`} value={form[k]} onChange={set(k)} aria-invalid={tried && !!errors[k]} {...props} />
      {tried && errors[k] && <span className="co-err">{errors[k]}</span>}
    </div>
  );

  return wrap(
    <div className="cart-two">
      <div className="co-main">
        <section className="co-box" aria-labelledby="co-items">
          <h2 id="co-items">
            주문 상품 <span>{checkout.lines.length}개</span>
          </h2>
          <ul className="co-lines">
            {checkout.lines.map((l) => (
              <li key={l.id}>
                <div>
                  <b>{l.productName}</b>
                  <span className="cart-opt">
                    {l.optionName} × {l.quantity}
                  </span>
                </div>
                <b>{won(l.lineTotal)}</b>
              </li>
            ))}
          </ul>
        </section>

        <section className="co-box" aria-labelledby="co-addr">
          <h2 id="co-addr">배송지</h2>
          {addresses.length > 0 && (
            <div className="co-radios" role="radiogroup" aria-label="저장한 배송지">
              {addresses.map((a) => (
                <label key={a.id} className="co-radio">
                  <input type="radio" name="addr" checked={addrId === a.id} onChange={() => setAddrId(a.id)} />
                  <span>
                    <b>
                      {a.label ?? a.recipientName}
                      {a.isDefault ? " · 기본 배송지" : ""}
                    </b>
                    <span className="cart-opt">
                      {a.recipientName} · {a.phone}
                    </span>
                    <span className="cart-opt">
                      {a.address1}
                      {a.address2 ? `, ${a.address2}` : ""} ({a.zipCode})
                    </span>
                  </span>
                </label>
              ))}
              <label className="co-radio">
                <input type="radio" name="addr" checked={addrId === NEW} onChange={() => setAddrId(NEW)} />
                <span>
                  <b>새 배송지 입력</b>
                </span>
              </label>
            </div>
          )}
          {addrId === NEW && (
            <div className="co-form">
              {field("recipientName", "받는 분", { autoComplete: "name", maxLength: 30 })}
              {field("phone", "연락처", { autoComplete: "tel", inputMode: "tel", placeholder: "01012345678", maxLength: 13 })}
              {field("zipCode", "우편번호", { inputMode: "numeric", maxLength: 5, placeholder: "5자리" })}
              {field("address1", "주소", { autoComplete: "address-line1", maxLength: 200 })}
              {field("address2", "상세 주소", { autoComplete: "address-line2", maxLength: 100 })}
              {field("memo", "배송 메모", { maxLength: 100, placeholder: "예: 문 앞에 두세요" })}
              <label className="co-check">
                <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
                배송지 목록에 저장하기
              </label>
            </div>
          )}
        </section>

        <section className="co-box" aria-labelledby="co-nick">
          <h2 id="co-nick">방송 닉네임</h2>
          <div className="co-field">
            <label htmlFor="co-nickname">이 주문의 닉네임</label>
            <input id="co-nickname" className={`inp${tried && !nickOk ? " is-error" : ""}`} value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={20} aria-invalid={tried && !nickOk} />
            {tried && !nickOk && <span className="co-err">닉네임은 20자까지 쓸 수 있어요</span>}
          </div>
          <span className="cart-hint">방송 화면에 이 닉네임으로 나와요. 이 주문에만 쓰고 회원 닉네임은 바뀌지 않아요.</span>
        </section>

        <section className="co-box" aria-labelledby="co-coupon">
          <h2 id="co-coupon">쿠폰</h2>
          <label className="co-field" htmlFor="co-coupon-sel">
            <span>사용할 쿠폰</span>
          </label>
          <select id="co-coupon-sel" className="inp" value={couponId} onChange={(e) => setCouponId(e.target.value)} disabled={coupons.length === 0}>
            <option value="">{coupons.length === 0 ? "쓸 수 있는 쿠폰이 없어요" : "쿠폰을 쓰지 않아요"}</option>
            {coupons.map((c) => {
              const short = c.minOrderAmount !== null && checkout.subtotal < c.minOrderAmount;
              return (
                <option key={c.couponId} value={c.couponId} disabled={short}>
                  {c.name} · {c.benefitText}
                  {short ? ` (${won(c.minOrderAmount!)} 이상)` : ""}
                </option>
              );
            })}
          </select>
          <span className="cart-hint">할인 금액은 주문할 때 서버가 정해요. 한 번에 한 장만 쓸 수 있어요.</span>
        </section>
      </div>

      <aside className="cart-sum" aria-label="주문 금액">
        <div className="cart-row">
          <span>상품 금액 ({checkout.lines.length}개)</span>
          <b>{won(checkout.subtotal)}</b>
        </div>
        <div className="cart-row">
          <span>배송비</span>
          <span>
            {preview.kind === "ok"
              ? `${won(preview.shippingFee)}${preview.isRemote ? " (제주·도서산간 포함)" : ""}`
              : preview.kind === "loading"
                ? "계산하고 있어요"
                : preview.kind === "error"
                  ? preview.message
                  : "배송지를 입력하면 알려 드려요"}
          </span>
        </div>
        {preview.kind === "ok" && (
          <div className="cart-row">
            <span>결제 예정 금액</span>
            <b>{won(preview.total)}</b>
          </div>
        )}
        <p className="cart-hint">쿠폰 할인은 주문할 때 정해져요. 결제 예정 금액은 쿠폰 할인 전 금액이에요.</p>
        <label className="co-check">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} aria-describedby="co-consent-err" />
          <span>
            <b>(필수)</b> {consent.text}
          </span>
        </label>
        {tried && !agreed && (
          <span id="co-consent-err" className="co-err">
            주문 내용 확인에 동의해 주세요
          </span>
        )}
        <p className="cart-hint">만 19세 미만이 법정대리인 동의 없이 주문하면 본인이나 법정대리인이 취소할 수 있어요. 나이는 휴대폰 본인확인 생년월일로 확인해요.</p>
        {error && (
          <p className="cart-msg is-err" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-lg btn-block" type="button" disabled={busy} aria-busy={busy} onClick={() => void submit()}>
          {busy ? "주문하고 있어요" : "주문하기"}
        </button>
        <p className="cart-hint">주문하면 결제 대기 상태로 접수되고, 다음 화면에서 결제 수단(카드·무통장 입금)을 골라요.</p>
      </aside>
    </div>,
  );
}
