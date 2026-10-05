"use client";

import { useEffect, useState } from "react";
import { api, failMessage, type Product, type ProductStatus } from "./api";
import { INT4_MAX, parseAmount, won } from "./format";
import "./ProductQuick.css";

// 상품 목록 빠른 처리(IA 결정): 판매 상태와 재고만 목록에서 바로 바꾼다. 다른 칸은 상품 수정에서 고친다.
// - 판매 상태: PATCH /api/seller/products/{id} { status }. 서버가 옵션 없는 상품의 판매 중 전환 등을 막으면 원래 값으로 되돌리고 이유를 알려 준다.
// - 재고: 옵션이 하나인 상품만. PATCH /api/seller/products/{id}/options/{optionId} { stock, expectedStock } — 상품 수정과 같은 규칙으로 보내
//   그사이 재고가 바뀌었으면(stock_conflict) 저장하지 않고 지금 재고로 갱신한 뒤 다시 확인하게 한다.
// 화면 값은 서버 응답을 받은 뒤에만 바뀌므로, 실패하면 저절로 원래 값으로 돌아온다.
// undo: 되돌릴 수 있는 변경이면 되돌리는 함수를 함께 준다(토스트 「되돌리기」). 성공하면 true
export type QuickUndo = () => Promise<boolean>;
export type QuickDone = (p: Pick<Product, "id" | "status" | "options"> & { price?: number }, text?: string, undo?: QuickUndo) => void;
export type QuickFail = (text: string) => void;

// 되돌리기가 실패했을 때: 그사이 다른 사람이 먼저 바꿨으면(409) 되돌리지 않고 지금 값으로 한 줄을 갱신한 뒤 알린다
async function undoFailed(back: { status: number; error?: string; message?: string }, product: Product, conflict: "price_conflict" | "status_conflict", onDone: QuickDone, onFail: QuickFail) {
  if (back.error === conflict) {
    const fresh = await api<Product>(`/api/seller/products/${product.id}`);
    if (fresh.ok) onDone(fresh.data);
    return onFail(`다른 사람이 먼저 바꿔서 되돌리지 않았습니다. 「${product.name}」의 지금 ${conflict === "price_conflict" ? "판매가" : "판매 상태"}를 확인해 주십시오`);
  }
  onFail(failMessage(back, "admin", "되돌리지 못했습니다. 상품 수정에서 확인해 주십시오"));
}

const STATUS_CHOICES: { key: ProductStatus; label: string }[] = [
  { key: "ON_SALE", label: "판매 중" },
  { key: "SOLD_OUT", label: "품절" },
  { key: "HIDDEN", label: "숨김" },
];

// 임시 저장 상품은 목록에서 바꾸지 않는다(상품 수정에서 등록한다)
export function QuickStatus({ product, onDone, onFail }: { product: Product; onDone: QuickDone; onFail: QuickFail }) {
  const [busy, setBusy] = useState(false);
  if (product.status === "DRAFT") return null;
  const change = async (status: ProductStatus) => {
    if (status === product.status) return;
    setBusy(true);
    const r = await api<Product>(`/api/seller/products/${product.id}`, { method: "PATCH", body: { status } });
    setBusy(false);
    if (!r.ok) return onFail(failMessage(r, "admin", "판매 상태를 바꾸지 못했습니다. 원래 상태로 되돌렸습니다"));
    const prev = product.status;
    onDone(r.data, `「${product.name}」 판매 상태를 ${STATUS_CHOICES.find((c) => c.key === status)?.label ?? ""}(으)로 바꿨습니다`, async () => {
      // 바꾼 뒤의 상태(expectedStatus)를 함께 보낸다: 그사이 다른 사람이 또 바꿨으면 서버가 막는다(status_conflict)
      const back = await api<Product>(`/api/seller/products/${product.id}`, { method: "PATCH", body: { status: prev, expectedStatus: status } });
      if (back.ok) onDone(back.data, `「${product.name}」 판매 상태를 되돌렸습니다`);
      else await undoFailed(back, product, "status_conflict", onDone, onFail);
      return back.ok;
    });
  };
  return (
    <select className={`inp inp-sm pq-sel${busy ? " pq-busy" : ""}`} aria-label={`${product.name} 판매 상태`} value={product.status} disabled={busy} onChange={(e) => void change(e.target.value as ProductStatus)}>
      {/* 이름은 label 속성으로만 둔다: 목록 행의 글자(상태 배지 등)와 섞여 행 글자 검색에 걸리지 않게 한다 */}
      {STATUS_CHOICES.map((c) => (
        <option key={c.key} value={c.key} label={c.label} />
      ))}
    </select>
  );
}

// 옵션이 하나인 상품의 재고. 옵션이 여럿이면 합계만 보이고 상품 수정에서 옵션별로 고친다
export function QuickStock({ product, onDone, onFail }: { product: Product; onDone: QuickDone; onFail: QuickFail }) {
  const option = product.options.length === 1 ? product.options[0] : null;
  const current = option ? String(option.stock) : "";
  const [text, setText] = useState(current);
  const [busy, setBusy] = useState(false);
  // 서버 값이 바뀌면(저장·새로 읽기) 입력 칸도 맞춘다
  useEffect(() => setText(current), [current]);
  if (!option) return null;

  const commit = async () => {
    const next = parseAmount(text);
    if (next === null || next < 0 || next > INT4_MAX) {
      setText(current);
      return onFail("재고는 0개 이상의 숫자로 입력해 주십시오. 원래 값으로 되돌렸습니다");
    }
    if (next === option.stock) return setText(current);
    setBusy(true);
    const r = await api<Product>(`/api/seller/products/${product.id}/options/${option.id}`, { method: "PATCH", body: { stock: next, expectedStock: option.stock } });
    if (r.ok) {
      setBusy(false);
      const before = option.stock;
      return onDone(r.data, `「${product.name}」 재고를 ${next.toLocaleString("ko-KR")}개로 바꿨습니다`, async () => {
        // 그사이 재고가 또 바뀌었으면 expectedStock으로 서버가 막는다
        const back = await api<Product>(`/api/seller/products/${product.id}/options/${option.id}`, { method: "PATCH", body: { stock: before, expectedStock: next } });
        if (back.ok) {
          onDone(back.data, `「${product.name}」 재고를 되돌렸습니다`);
          return true;
        }
        if (back.error === "stock_conflict") {
          const fresh = await api<Product>(`/api/seller/products/${product.id}`);
          if (fresh.ok) onDone(fresh.data);
          onFail("그사이 재고가 변경되어 되돌리지 않았습니다. 지금 재고를 확인해 주십시오");
        } else onFail(failMessage(back, "admin", "되돌리지 못했습니다. 상품 수정에서 확인해 주십시오"));
        return false;
      });
    }
    // 그사이 재고가 바뀌었으면 지금 값으로 갱신해 두고 다시 확인하게 한다
    if (r.error === "stock_conflict") {
      const fresh = await api<Product>(`/api/seller/products/${product.id}`);
      setBusy(false);
      if (fresh.ok) {
        setText(String(fresh.data.options.find((o) => o.id === option.id)?.stock ?? current));
        onDone(fresh.data);
        return onFail(`그사이 「${product.name}」 재고가 변경되었습니다. 지금 재고를 확인하고 다시 입력해 주십시오`);
      }
    } else setBusy(false);
    setText(current);
    onFail(failMessage(r, "admin", "재고를 바꾸지 못했습니다. 원래 값으로 되돌렸습니다"));
  };

  return (
    <input
      className={`inp inp-sm num pq-stock${busy ? " pq-busy" : ""}`}
      aria-label={`${product.name} 재고`}
      inputMode="numeric"
      value={text}
      disabled={busy}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setText(current);
      }}
    />
  );
}

// 판매가(접근성 이름은 「가격」: 상품 수정 화면의 「판매가」 칸 이름과 겹치지 않게). 평소에는 금액 글자로 보이고(목록 글자 검색·읽기 그대로), 누르면 입력 칸이 된다.
// 옵션 추가금을 더한 단가·이벤트 할인 규칙은 서버가 검사하고, 막으면 원래 값으로 되돌리고 이유를 알린다
export function QuickPrice({ product, onDone, onFail }: { product: Product; onDone: QuickDone; onFail: QuickFail }) {
  const current = String(product.price);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(current);
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(current), [current]);

  const close = () => {
    setText(current);
    setEditing(false);
  };
  const commit = async () => {
    const next = parseAmount(text);
    if (next === null || next < 1 || next > INT4_MAX) {
      close();
      return onFail("판매가는 1원 이상의 숫자로 입력해 주십시오. 원래 값으로 되돌렸습니다");
    }
    if (next === product.price) return close();
    setBusy(true);
    const r = await api<Product>(`/api/seller/products/${product.id}`, { method: "PATCH", body: { price: next } });
    setBusy(false);
    setEditing(false);
    if (!r.ok) {
      setText(current);
      return onFail(failMessage(r, "admin", "판매가를 바꾸지 못했습니다. 원래 값으로 되돌렸습니다"));
    }
    const before = product.price;
    onDone(r.data, `「${product.name}」 판매가를 ${next.toLocaleString("ko-KR")}원으로 바꿨습니다`, async () => {
      // 바꾼 뒤의 판매가(expectedPrice)를 함께 보낸다: 그사이 다른 사람이 또 바꿨으면 서버가 막는다(price_conflict)
      const back = await api<Product>(`/api/seller/products/${product.id}`, { method: "PATCH", body: { price: before, expectedPrice: next } });
      if (back.ok) onDone(back.data, `「${product.name}」 판매가를 되돌렸습니다`);
      else await undoFailed(back, product, "price_conflict", onDone, onFail);
      return back.ok;
    });
  };

  if (!editing) {
    return (
      <button className="pq-edit num" type="button" aria-label={`${product.name} 가격 변경`} title="눌러서 판매가 수정" onClick={() => setEditing(true)}>
        {won(product.price)}
      </button>
    );
  }
  return (
    <input
      className={`inp inp-sm num pq-price${busy ? " pq-busy" : ""}`}
      aria-label={`${product.name} 가격`}
      inputMode="numeric"
      value={text}
      disabled={busy}
      autoFocus
      onChange={(e) => setText(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") close();
      }}
    />
  );
}
