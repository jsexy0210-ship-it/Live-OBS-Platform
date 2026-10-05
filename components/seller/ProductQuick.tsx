"use client";

import { useEffect, useState } from "react";
import { api, failMessage, type Product, type ProductStatus } from "./api";
import { INT4_MAX, parseAmount } from "./format";
import "./ProductQuick.css";

// 상품 목록 빠른 처리(IA 결정): 판매 상태와 재고만 목록에서 바로 바꾼다. 다른 칸은 상품 수정에서 고친다.
// - 판매 상태: PATCH /api/seller/products/{id} { status }. 서버가 옵션 없는 상품의 판매 중 전환 등을 막으면 원래 값으로 되돌리고 이유를 알려 준다.
// - 재고: 옵션이 하나인 상품만. PATCH /api/seller/products/{id}/options/{optionId} { stock, expectedStock } — 상품 수정과 같은 규칙으로 보내
//   그사이 재고가 바뀌었으면(stock_conflict) 저장하지 않고 지금 재고로 갱신한 뒤 다시 확인하게 한다.
// 화면 값은 서버 응답을 받은 뒤에만 바뀌므로, 실패하면 저절로 원래 값으로 돌아온다.
export type QuickDone = (p: Pick<Product, "id" | "status" | "options">, text?: string) => void;
export type QuickFail = (text: string) => void;

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
    onDone(r.data, `「${product.name}」 판매 상태를 ${STATUS_CHOICES.find((c) => c.key === status)?.label ?? ""}(으)로 바꿨습니다`);
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
      return onDone(r.data, `「${product.name}」 재고를 ${next.toLocaleString("ko-KR")}개로 바꿨습니다`);
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
