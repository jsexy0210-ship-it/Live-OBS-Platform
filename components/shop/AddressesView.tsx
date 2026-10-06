"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useConfirm } from "../admin-ui/ConfirmDialog";
import MyMenu from "./MyMenu";
import ShopBack from "./ShopBack";
import { usePostcode } from "../../lib/client/usePostcode";
import { call } from "./reviewShared";
import "./Cart.css";
import "./MyMenu.css";
import "./Addresses.css";

// SH-027 배송지 관리(보드 SH-027-IA FINAL): 최대 20개 · n / 20, 카드(이름 · 기본 · 수정 · 삭제 / 받는 분 · 연락처 · 주소 / 기본 배송지로), 새 배송지 추가 폼.
// API: GET·POST /api/shop/{slug}/addresses, PATCH·DELETE /addresses/{id}(isDefault: true면 기본). 기본 배송지는 보드대로 지우지 않고 안내만 한다.
type Addr = { id: string; label: string | null; recipientName: string; phone: string; zipCode: string; address1: string; address2: string | null; memo: string | null; isDefault: boolean };
type View = { kind: "loading" } | { kind: "login" } | { kind: "error" } | { kind: "ok"; items: Addr[] };
type Form = { label: string; recipientName: string; phone: string; zipCode: string; address1: string; address2: string; isDefault: boolean };
const LIMIT = 20;
const EMPTY: Form = { label: "", recipientName: "", phone: "", zipCode: "", address1: "", address2: "", isDefault: false };

function check(f: Form) {
  const e: Partial<Record<keyof Form, string>> = {};
  if (!f.recipientName.trim()) e.recipientName = "받는 분 이름을 적어 주세요";
  if (!/^0\d{8,10}$/.test(f.phone.replace(/[ -]/g, ""))) e.phone = "연락처를 숫자로 적어 주세요 (예: 01012345678)";
  if (!/^\d{5}$/.test(f.zipCode.trim())) e.zipCode = "우편번호 5자리를 적어 주세요";
  if (!f.address1.trim()) e.address1 = "주소를 적어 주세요";
  return e;
}

export default function AddressesView({ slug }: { slug: string }) {
  const { confirm } = useConfirm();
  const base = `/shop/${encodeURIComponent(slug)}`;
  const api = `/api/shop/${encodeURIComponent(slug)}/addresses`;
  const [view, setView] = useState<View>({ kind: "loading" });
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [busy, setBusy] = useState(false);
  const postcode = usePostcode(editing !== null); // 폼을 열 때만 우편번호 서비스를 불러온다
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const r = await call<{ addresses: Addr[] }>(api);
    setView(r.ok ? { kind: "ok", items: r.data.addresses } : { kind: r.status === 401 ? "login" : "error" });
  }, [api]);
  useEffect(() => void load(), [load]);

  const items = view.kind === "ok" ? view.items : [];
  const full = items.length >= LIMIT;

  function open(a: Addr | null) {
    setMsg(null);
    setErrors({});
    setEditing(a ? a.id : "new");
    setForm(a ? { label: a.label ?? "", recipientName: a.recipientName, phone: a.phone, zipCode: a.zipCode, address1: a.address1, address2: a.address2 ?? "", isDefault: a.isDefault } : EMPTY);
  }
  function close() {
    setEditing(null);
    setErrors({});
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const found = check(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setMsg(null);
    const body = {
      label: form.label.trim() || undefined,
      recipientName: form.recipientName.trim(),
      phone: form.phone.replace(/[ -]/g, ""),
      zipCode: form.zipCode.trim(),
      address1: form.address1.trim(),
      address2: form.address2.trim() || undefined,
      isDefault: form.isDefault || undefined,
    };
    const r = editing === "new" ? await call(api, { method: "POST", body }) : await call(`${api}/${editing}`, { method: "PATCH", body: { ...body, label: form.label.trim() || null, address2: form.address2.trim() || null } });
    setBusy(false);
    if (!r.ok) {
      setMsg({ ok: false, text: r.status === 409 ? "이미 저장한 배송지거나 20개를 넘었어요. 안 쓰는 배송지를 지워 주세요" : r.message ?? "저장하지 못했어요. 잠시 뒤 다시 해 주세요" });
      return;
    }
    close();
    setMsg({ ok: true, text: editing === "new" ? "배송지를 추가했어요" : "배송지를 고쳤어요" });
    await load();
  }

  async function makeDefault(a: Addr) {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    const r = await call(`${api}/${a.id}`, { method: "PATCH", body: { isDefault: true } });
    setMsg(r.ok ? { ok: true, text: `「${a.label ?? a.recipientName}」을 기본 배송지로 바꿨어요` } : { ok: false, text: r.message ?? "바꾸지 못했어요. 잠시 뒤 다시 해 주세요" });
    await load();
    setBusy(false);
  }

  async function remove(a: Addr) {
    if (busy) return;
    if (a.isDefault) {
      setMsg({ ok: false, text: "기본 배송지는 지울 수 없어요 · 다른 배송지를 기본으로 바꾼 뒤 지워 주세요" });
      return;
    }
    const name = a.label ?? a.recipientName;
    if (!(await confirm({ tone: "shop", title: `「${name}」 배송지를 지울까요?`, body: "진행 중인 주문의 배송지는 바뀌지 않아요.", confirmLabel: "지우기", cancelLabel: "취소", danger: true }))) return;
    setBusy(true);
    setMsg(null);
    const r = await call(`${api}/${a.id}`, { method: "DELETE" });
    setMsg(r.ok || r.status === 404 ? { ok: true, text: "배송지를 지웠어요" } : { ok: false, text: r.message ?? "지우지 못했어요. 잠시 뒤 다시 해 주세요" });
    await load();
    setBusy(false);
  }

  const field = (key: keyof Form, label: string, req: boolean, attrs: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="ad-field">
      <label htmlFor={`ad-${key}`}>
        {label}
        {req && <i aria-hidden="true">*</i>}
      </label>
      <input id={`ad-${key}`} className="inp" value={form[key] as string} aria-invalid={!!errors[key]} aria-describedby={errors[key] ? `ad-${key}-err` : undefined} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} {...attrs} />
      {errors[key] && (
        <span id={`ad-${key}-err`} className="err" role="alert">
          {errors[key]}
        </span>
      )}
    </div>
  );

  // 주소: 「우편번호 찾기」(다음 우편번호, 무료)로 고르면 우편번호·주소가 채워진다. 서비스를 못 불러오면 직접 입력으로 바뀐다.
  const manual = postcode.state === "failed";
  const pickAddress = () =>
    postcode.open((d) => {
      const baseAddr = d.userSelectedType === "R" ? d.roadAddress : d.jibunAddress;
      const extra = d.userSelectedType === "R" && d.apartment === "Y" && d.buildingName ? ` (${d.buildingName})` : "";
      setForm((f) => ({ ...f, zipCode: d.zonecode.replace(/\D/g, "").slice(0, 5), address1: `${baseAddr}${extra}`.slice(0, 200) }));
      setErrors((e) => ({ ...e, zipCode: undefined, address1: undefined }));
      document.getElementById("ad-address2")?.focus();
    });
  const addressFields = (
    <>
      {manual && (
        <p className="cart-msg is-err" role="status">
          주소 검색을 열지 못했어요. 우편번호와 주소를 직접 적어 주세요
        </p>
      )}
      <div className="ad-field">
        <label htmlFor="ad-zipCode">
          주소<i aria-hidden="true">*</i>
        </label>
        <div className="ad-zip">
          <input id="ad-zipCode" className="inp" inputMode="numeric" maxLength={5} placeholder="우편번호" aria-label="우편번호" readOnly={!manual} value={form.zipCode} aria-invalid={!!errors.zipCode} onChange={(e) => setForm((f) => ({ ...f, zipCode: e.target.value }))} />
          <button type="button" className="btn btn-out" disabled={postcode.state !== "ready"} onClick={pickAddress}>
            우편번호 찾기
          </button>
        </div>
        {errors.zipCode && (
          <span className="err" role="alert">
            {errors.zipCode}
          </span>
        )}
        <input id="ad-address1" className="inp" maxLength={200} placeholder="기본 주소" aria-label="기본 주소" readOnly={!manual} value={form.address1} aria-invalid={!!errors.address1} onChange={(e) => setForm((f) => ({ ...f, address1: e.target.value }))} />
        {errors.address1 && (
          <span className="err" role="alert">
            {errors.address1}
          </span>
        )}
      </div>
    </>
  );

  const body =
    view.kind === "loading" ? (
      <p className="shop-empty" aria-busy="true">
        배송지를 불러오고 있어요
      </p>
    ) : view.kind === "login" ? (
      <div className="cart-empty">
        <p>로그인하면 볼 수 있어요</p>
        <Link className="btn" href={`${base}/login?next=${encodeURIComponent(`${base}/me/addresses`)}`}>
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
        <p className="ad-count">
          최대 {LIMIT}개 · {items.length} / {LIMIT}
        </p>
        {msg && (
          <p className={`cart-msg${msg.ok ? "" : " is-err"}`} role="status">
            {msg.text}
          </p>
        )}
        {items.length === 0 && editing !== "new" && (
          <div className="cart-empty">
            <h2>저장한 배송지가 없어요</h2>
            <p>자주 쓰는 주소를 저장해 두면 주문이 빨라져요.</p>
          </div>
        )}
        <ul className="ad-list">
          {items.map((a) => (
            <li key={a.id} className="ad-card">
              {editing === a.id ? (
                <form className="ad-form" onSubmit={submit} noValidate aria-label={`${a.label ?? a.recipientName} 배송지 수정`}>
                  {field("label", "배송지 이름", false, { placeholder: "예: 집", maxLength: 20 })}
                  {field("recipientName", "받는 분", true, { autoComplete: "name", maxLength: 30 })}
                  {field("phone", "연락처", true, { autoComplete: "tel", inputMode: "tel", maxLength: 13 })}
                  {addressFields}
                  {field("address2", "상세 주소", false, { autoComplete: "address-line2", maxLength: 100 })}
                  <label className="ad-check">
                    <input type="checkbox" checked={form.isDefault} disabled={a.isDefault} onChange={(e) => setForm((f) => ({ ...f, isDefault: e.target.checked }))} />
                    기본 배송지로 저장
                  </label>
                  <div className="ad-actions">
                    <button className="btn btn-out" type="button" disabled={busy} onClick={close}>
                      취소
                    </button>
                    <button className="btn" type="submit" disabled={busy} aria-busy={busy}>
                      {busy ? "저장하고 있어요" : "저장"}
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="ad-head">
                    <b>{a.label ?? a.recipientName}</b>
                    {a.isDefault && <span className="ad-chip">기본</span>}
                    <span className="ad-links">
                      <button type="button" className="shop-linkbtn" disabled={busy} onClick={() => open(a)}>
                        수정
                      </button>
                      <button type="button" className="shop-linkbtn" disabled={busy} onClick={() => void remove(a)}>
                        삭제
                      </button>
                    </span>
                  </div>
                  <p className="ad-who">
                    {a.recipientName} · {a.phone}
                  </p>
                  <p className="ad-addr">
                    {a.address1}
                    {a.address2 ? `, ${a.address2}` : ""} ({a.zipCode})
                  </p>
                  {!a.isDefault && (
                    <button type="button" className="btn btn-sm btn-out" disabled={busy} onClick={() => void makeDefault(a)}>
                      기본 배송지로
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
        {editing === "new" && (
          <form className="ad-form ad-card" onSubmit={submit} noValidate aria-label="새 배송지 추가">
            <h2>새 배송지 추가</h2>
            {field("label", "배송지 이름", false, { placeholder: "예: 집", maxLength: 20 })}
            {field("recipientName", "받는 분", true, { autoComplete: "name", maxLength: 30 })}
            {field("phone", "연락처", true, { autoComplete: "tel", inputMode: "tel", maxLength: 13 })}
            {addressFields}
            {field("address2", "상세 주소", false, { autoComplete: "address-line2", maxLength: 100 })}
            <label className="ad-check">
              <input type="checkbox" checked={form.isDefault} onChange={(e) => setForm((f) => ({ ...f, isDefault: e.target.checked }))} />
              기본 배송지로 저장
            </label>
            <div className="ad-actions">
              <button className="btn btn-out" type="button" disabled={busy} onClick={close}>
                취소
              </button>
              <button className="btn" type="submit" disabled={busy} aria-busy={busy}>
                {busy ? "저장하고 있어요" : "저장"}
              </button>
            </div>
          </form>
        )}
        {full ? (
          <p className="cart-msg is-err" role="status">
            배송지는 {LIMIT}개까지 저장할 수 있어요 · 안 쓰는 배송지를 지운 뒤 추가해 주세요
          </p>
        ) : (
          editing !== "new" && (
            <button type="button" className="btn ad-add" disabled={busy} onClick={() => open(null)}>
              새 배송지 추가
            </button>
          )
        )}
      </>
    );

  return (
    <div className="shop-wrap cart-wrap">
      <ShopBack fallback={`${base}/me`} label="내 정보" />
      <div className="cart-head">
        <h1>배송지 관리</h1>
      </div>
      <div className="my-wrap">
        <MyMenu slug={slug} />
        <div>{body}</div>
      </div>
    </div>
  );
}
