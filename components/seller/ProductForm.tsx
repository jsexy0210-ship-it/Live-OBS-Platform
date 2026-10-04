"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Topbar } from "./SellerShell";
import { NoImage, Toast } from "./States";
import { api, failMessage, type Product, type ProductOption, type ProductStatus, type StockDeductMode } from "./api";
import { INT4_MAX, STATUS_LABEL, parseAmount, statusBadge, textLength, won } from "./format";
import { cleanText } from "../../lib/server/text/clean";

// SA-012 상품 등록 · SA-012-E 상품 수정. 지금 API가 받는 항목(상품명·설명·판매가·판매 상태·옵션)만 보여 준다.
// 이미지·카테고리·이벤트 할인 등은 API가 생기면 붙인다.

const NAME_MAX = 100;
const DESC_MAX = 5000;
const OPTION_MAX = 100;

type OptRow = {
  key: number;
  id?: string;
  name: string;
  priceDelta: string;
  stock: string;
  // 서버에 저장된 값(수정 화면). 바뀐 것만 보낸다.
  orig?: { name: string; priceDelta: number; stock: number };
};

type Errors = { name?: string; description?: string; price?: string; options?: string; rows: Record<number, { name?: string; priceDelta?: string; stock?: string }> };

const STATUS_HELP: Record<ProductStatus, string> = {
  ON_SALE: "쇼핑몰과 방송 주문대기에 바로 표시됩니다",
  SOLD_OUT: "쇼핑몰에 「품절」로 표시되고 주문은 받지 않습니다",
  HIDDEN: "쇼핑몰에 표시되지 않습니다. 언제든 다시 판매할 수 있습니다",
  DRAFT: "아직 쇼핑몰에 표시되지 않습니다",
};

let seq = 0;
const toRow = (o: ProductOption): OptRow => ({
  key: ++seq,
  id: o.id,
  name: o.name,
  priceDelta: String(o.priceDelta),
  stock: String(o.stock),
  orig: { name: o.name, priceDelta: o.priceDelta, stock: o.stock },
});
const blankRow = (name = ""): OptRow => ({ key: ++seq, name, priceDelta: "0", stock: "0" });

// 서버와 같은 글자 규칙(lib/server/text/clean.ts)으로 미리 검사해, 서버만 거부하는 글자(폭 없는 공백·채움 문자 등)가 어느 칸인지 알려 준다
const BAD_CHARS = "사용할 수 없는 글자가 들어 있습니다. 보이지 않는 글자나 빈칸 문자를 지워 주십시오";
const badLine = (v: string) => v.trim() !== "" && cleanText(v, Number.MAX_SAFE_INTEGER, "name") === null;
const badMultiline = (v: string) => v.trim() !== "" && cleanText(v, Number.MAX_SAFE_INTEGER, "multiline") === null;

function validate(name: string, description: string, price: string, status: ProductStatus, rows: OptRow[]): Errors {
  const e: Errors = { rows: {} };
  const len = textLength(name);
  if (len === 0) e.name = "상품명을 입력해 주십시오";
  else if (len > NAME_MAX) e.name = `상품명은 ${NAME_MAX}자까지 입력할 수 있습니다`;
  else if (badLine(name)) e.name = BAD_CHARS;
  if (textLength(description) > DESC_MAX) e.description = `설명은 ${DESC_MAX.toLocaleString("ko-KR")}자까지 입력할 수 있습니다`;
  else if (badMultiline(description)) e.description = BAD_CHARS;
  const p = parseAmount(price);
  if (p === null) e.price = "숫자만 입력해 주십시오";
  else if (p < 1 || p > INT4_MAX) e.price = "가격은 1원 이상, 21억 원 이하로 입력해 주십시오";
  // 판매가가 올바를 때만 옵션 단가(판매가 + 추가 금액)를 검사한다
  const priceOk = !e.price && p !== null;
  for (const r of rows) {
    const re: Errors["rows"][number] = {};
    const n = textLength(r.name);
    if (n === 0) re.name = "옵션명을 입력해 주십시오";
    else if (n > NAME_MAX) re.name = `옵션명은 ${NAME_MAX}자까지 입력할 수 있습니다`;
    else if (badLine(r.name)) re.name = BAD_CHARS;
    const d = parseAmount(r.priceDelta);
    if (d === null) re.priceDelta = "숫자만 입력해 주십시오";
    else if (priceOk && (p + d < 1 || p + d > INT4_MAX)) re.priceDelta = "추가 금액을 더한 가격이 1원보다 작거나 너무 큽니다";
    const s = parseAmount(r.stock);
    if (s === null) re.stock = "숫자만 입력해 주십시오";
    else if (s < 0 || s > INT4_MAX) re.stock = "재고는 0개 이상으로 입력해 주십시오";
    if (Object.keys(re).length) e.rows[r.key] = re;
  }
  if (rows.length > OPTION_MAX) e.options = `옵션은 ${OPTION_MAX}개까지 만들 수 있습니다`;
  else if (status === "ON_SALE" && rows.length === 0) e.options = "판매하려면 옵션이 하나 이상 있어야 합니다";
  return e;
}

const errorCount = (e: Errors) =>
  [e.name, e.description, e.price, e.options].filter(Boolean).length + Object.keys(e.rows).length;

function errorFields(e: Errors): string {
  const f: string[] = [];
  if (e.name) f.push("상품명");
  if (e.description) f.push("설명");
  if (e.price) f.push("판매가");
  if (e.options || Object.keys(e.rows).length) f.push("옵션");
  return f.join(" · ");
}

export function ProductForm({ initial }: { initial?: Product }) {
  const router = useRouter();
  const isEdit = !!initial;
  const [base, setBase] = useState<Product | undefined>(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [price, setPrice] = useState(initial ? String(initial.price) : "");
  const [status, setStatus] = useState<ProductStatus>(initial?.status ?? "ON_SALE");
  const [deduct, setDeduct] = useState<StockDeductMode>(initial?.stockDeductMode ?? "PAYMENT");
  // 취소·반품 때 재고를 되돌릴지는 주문 설정(restockOnCancel)을 따른다. 쇼핑몰 설정 권한이 없으면 읽지 못하므로 설정 이름만 안내한다
  const [restock, setRestock] = useState<boolean | null>(null);
  useEffect(() => {
    void api<{ policy: { restockOnCancel: boolean } }>("/api/seller/order-policy").then((r) => {
      if (r.ok) setRestock(r.data.policy.restockOnCancel);
    });
  }, []);
  const restockText =
    restock === null
      ? "취소·반품 때 재고를 되돌릴지는 주문 설정의 「취소·반품하면 재고 되돌리기」를 따릅니다"
      : restock
        ? "주문 취소·발송 전 환불이면 재고가 돌아옵니다(주문 설정에서 켜져 있습니다). 발송 뒤 환불이나 개봉한 상품은 돌아오지 않습니다"
        : "취소·환불해도 재고가 돌아오지 않습니다(주문 설정에서 꺼져 있습니다)";
  const [rows, setRows] = useState<OptRow[]>(() => (initial ? initial.options.map(toRow) : [blankRow("기본")]));
  const [removed, setRemoved] = useState<string[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState<null | "save" | "draft">(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const topRef = useRef<HTMLDivElement>(null);

  const errors = validate(name, description, price, status, rows);
  const shown: Errors = showErrors ? errors : { rows: {} };
  const nameLen = textLength(name);
  const priceNum = parseAmount(price);
  const required = nameLen > 0 && price.trim() !== "" && rows.every((r) => r.name.trim() !== "");

  const setRow = (key: number, patch: Partial<OptRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeRow = (r: OptRow) => {
    setRows((rs) => rs.filter((x) => x.key !== r.key));
    if (r.id) setRemoved((ids) => [...ids, r.id!]);
  };

  const fail = (msg: string) => {
    setFailure(msg);
    setSaving(null);
    topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const checkFirst = (st: ProductStatus) => {
    const e = validate(name, description, price, st, rows);
    if (errorCount(e) > 0) {
      setShowErrors(true);
      fail(`아래 ${errorCount(e)}개 항목을 확인해 주십시오: ${errorFields(e)}`);
      return false;
    }
    return true;
  };

  const create = async (st: ProductStatus) => {
    if (!checkFirst(st)) return;
    setSaving(st === "DRAFT" ? "draft" : "save");
    setFailure(null);
    const r = await api<Product>("/api/seller/products", {
      method: "POST",
      body: {
        name: name.trim(),
        description: description.trim() === "" ? null : description.trim(),
        price: priceNum,
        status: st,
        stockDeductMode: deduct,
        options: rows.map((o, i) => ({ name: o.name.trim(), priceDelta: parseAmount(o.priceDelta), stock: parseAmount(o.stock), sortOrder: i })),
      },
    });
    if (!r.ok) return fail(failMessage(r, "admin", "상품을 등록하지 못했습니다. 입력한 내용은 그대로 있습니다"));
    router.push(`/seller/products?toast=${st === "DRAFT" ? "draft" : "created"}`);
  };

  // 수정: 바뀐 것만 하나씩 보낸다. 한 단계가 실패하면 거기서 멈추고, 이미 저장된 단계는 기준값에 반영해 다시 보내지 않는다.
  const update = async () => {
    if (!base || !checkFirst(status)) return;
    setSaving("save");
    setFailure(null);
    let current = base;
    let list = rows;
    let gone = removed;
    // 서버는 단계마다 「판매가 + 추가 금액 ≥ 1원」, 「판매 중이면 옵션 1개 이상」을 검사한다. 중간 상태가 늘 올바르도록
    // 판매가를 올리거나 판매 중이 아닌 상태로 바꾸는 것은 옵션보다 먼저(early), 판매가를 내리거나 판매 중으로 바꾸는 것은 옵션 뒤에(late) 보낸다.
    const early: Record<string, unknown> = {};
    const late: Record<string, unknown> = {};
    const desc = description.trim() === "" ? null : description.trim();
    if (name.trim() !== current.name) early.name = name.trim();
    if (desc !== (current.description ?? null)) early.description = desc;
    if (priceNum !== current.price) (priceNum! > current.price ? early : late).price = priceNum;
    if (status !== current.status) (status === "ON_SALE" ? late : early).status = status;
    if (deduct !== current.stockDeductMode) early.stockDeductMode = deduct;

    const patchProduct = async (patch: Record<string, unknown>) => {
      if (Object.keys(patch).length === 0) return true;
      const r = await api<Product>(`/api/seller/products/${current.id}`, { method: "PATCH", body: patch });
      if (!r.ok) {
        fail(failMessage(r, "admin", "저장하지 못했습니다"));
        return false;
      }
      current = r.data;
      setBase(current);
      return true;
    };

    if (!(await patchProduct(early))) return;

    for (const [i, o] of rows.entries()) {
      const delta = parseAmount(o.priceDelta)!;
      const stock = parseAmount(o.stock)!;
      if (!o.id) {
        const known = new Set(current.options.map((x) => x.id));
        const r = await api<Product>(`/api/seller/products/${current.id}/options`, {
          method: "POST",
          body: { name: o.name.trim(), priceDelta: delta, stock, sortOrder: i },
        });
        if (!r.ok) return fail(failMessage(r, "admin", "옵션을 추가하지 못했습니다"));
        current = r.data;
        const made = current.options.find((x) => !known.has(x.id));
        list = list.map((x) => (x.key === o.key && made ? { ...x, id: made.id, orig: { name: made.name, priceDelta: made.priceDelta, stock: made.stock } } : x));
        setRows(list);
        continue;
      }
      const body: Record<string, unknown> = {};
      if (o.orig && o.name.trim() !== o.orig.name) body.name = o.name.trim();
      if (o.orig && delta !== o.orig.priceDelta) body.priceDelta = delta;
      if (o.orig && stock !== o.orig.stock) Object.assign(body, { stock, expectedStock: o.orig.stock });
      if (Object.keys(body).length === 0) continue;
      const r = await api<Product>(`/api/seller/products/${current.id}/options/${o.id}`, { method: "PATCH", body });
      if (!r.ok) {
        // 그사이 재고가 바뀌었으면 지금 재고를 알려 주고 그 값으로 바꿔 둔다. 다시 확인하고 저장하게 한다
        if (r.error === "stock_conflict") {
          const fresh = await api<Product>(`/api/seller/products/${current.id}`);
          const now = fresh.ok ? fresh.data.options.find((x) => x.id === o.id) : undefined;
          if (now) {
            setRows(list.map((x) => (x.key === o.key ? { ...x, stock: String(now.stock), orig: { ...x.orig!, stock: now.stock } } : x)));
            return fail(`그사이 「${o.name.trim()}」 재고가 변경되었습니다. 지금 재고는 ${now.stock.toLocaleString("ko-KR")}개입니다. 확인하고 다시 저장해 주십시오`);
          }
        }
        return fail(failMessage(r, "admin", "옵션을 저장하지 못했습니다"));
      }
      current = r.data;
      list = list.map((x) => (x.key === o.key ? { ...x, orig: { name: o.name.trim(), priceDelta: delta, stock } } : x));
      setRows(list);
    }

    for (const id of removed) {
      const r = await api<Product>(`/api/seller/products/${current.id}/options/${id}`, { method: "DELETE" });
      if (!r.ok && r.status !== 404) return fail(failMessage(r, "admin", "옵션을 삭제하지 못했습니다"));
      if (r.ok) current = r.data;
      gone = gone.filter((x) => x !== id);
      setRemoved(gone);
    }

    if (!(await patchProduct(late))) return;
    setBase(current);
    setRows(current.options.map(toRow));
    setRemoved([]);
    setShowErrors(false);
    setSaving(null);
    setToast("저장했습니다");
  };

  const busy = saving !== null;
  const statusChoices: ProductStatus[] = base?.status === "DRAFT" ? ["ON_SALE", "HIDDEN", "SOLD_OUT", "DRAFT"] : ["ON_SALE", "HIDDEN", "SOLD_OUT"];
  const crumbName = base ? base.name : "상품 등록";
  const badge = base ? statusBadge(base) : null;

  const saveButtons = (block: boolean) =>
    isEdit ? (
      <button className={`btn${block ? " btn-lg btn-block" : " btn-sm"}${saving ? " is-loading" : ""}`} type="button" disabled={busy || !required} onClick={() => void update()}>
        {saving ? "저장 중" : "저장"}
      </button>
    ) : (
      <>
        <button className={`btn btn-out${block ? " btn-lg btn-block" : " btn-sm"}`} type="button" disabled={busy || !required} onClick={() => void create("DRAFT")}>
          {saving === "draft" ? "저장 중" : "임시 저장"}
        </button>
        <button className={`btn${block ? " btn-lg btn-block" : " btn-sm"}${saving === "save" ? " is-loading" : ""}`} type="button" disabled={busy || !required} onClick={() => void create(status)}>
          {saving === "save" ? "등록 중" : "등록"}
        </button>
      </>
    );

  return (
    <>
      <Topbar crumb={`판매 › 상품 › ${crumbName}`} badge={badge && <span className={`bdg ${badge.cls}`}>{badge.label}</span>}>
        <Link className="btn btn-sm btn-out" href="/seller/products">
          취소
        </Link>
        {saveButtons(false)}
      </Topbar>
      <main className="main form-grid">
        <div className="col" style={{ gap: 20 }} ref={topRef}>
          {failure && (
            <div className="msg msg-neg" role="alert">
              <span>
                <b>저장할 수 없습니다.</b> {failure}
              </span>
            </div>
          )}

          <section className="card pad-l col" style={{ gap: 16 }}>
            <h2 className="t-hl1">기본 정보</h2>
            <div className="fld">
              <label htmlFor="p-name" className="req">
                상품명
              </label>
              <div style={{ position: "relative" }}>
                <input
                  id="p-name"
                  className={`inp${shown.name || nameLen > NAME_MAX ? " is-error" : ""}`}
                  type="text"
                  placeholder="예: 스타라이트 부스터 박스"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  style={{ paddingRight: 80 }}
                  aria-invalid={!!shown.name}
                />
                <span className={`t-c1 num name-count ${nameLen > NAME_MAX ? "c-neg" : "c-alt"}`} data-testid="name-count">
                  {nameLen}/{NAME_MAX}
                </span>
              </div>
              {shown.name || nameLen > NAME_MAX ? (
                <span className="err">{shown.name ?? `상품명은 ${NAME_MAX}자까지 입력할 수 있습니다`}</span>
              ) : (
                <span className="help">목록에서 잘 보이려면 50자 이내가 좋습니다 · 공백 포함 최대 100자 · 쇼핑몰과 오버레이에 그대로 표시됩니다</span>
              )}
            </div>
            <div className="fld">
              <label htmlFor="p-desc">상품 설명</label>
              <textarea
                id="p-desc"
                className={`inp${shown.description ? " is-error" : ""}`}
                placeholder="구성 · 상태 · 배송 안내를 입력해 주십시오"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
              {shown.description && <span className="err">{shown.description}</span>}
            </div>
          </section>

          <section className="card pad-l col" style={{ gap: 16 }}>
            <h2 className="t-hl1">가격</h2>
            <div className="g3">
              <div className="fld">
                <label htmlFor="p-price" className="req">
                  판매가
                </label>
                <input
                  id="p-price"
                  className={`inp num${shown.price ? " is-error" : ""}`}
                  type="text"
                  inputMode="numeric"
                  placeholder="0"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  style={{ textAlign: "right" }}
                  aria-invalid={!!shown.price}
                />
                {shown.price ? <span className="err">{shown.price}</span> : <span className="help">원 · 부가세 포함</span>}
              </div>
            </div>
          </section>

          <section className="card pad-l col" style={{ gap: 12 }}>
            <div className="row between">
              <h2 className="t-hl1">
                옵션 <span className="c-alt fw5 t-l2">{rows.length}</span>
              </h2>
              <button className="btn btn-sm btn-out" type="button" onClick={() => setRows((rs) => [...rs, blankRow()])} disabled={rows.length >= OPTION_MAX}>
                + 옵션 추가
              </button>
            </div>
            <span className="help">재고는 옵션마다 따로 관리합니다. 재고가 0이 되면 그 옵션은 주문할 수 없습니다</span>
            <div className="opt-head" aria-hidden="true">
              <span>옵션명</span>
              <span className="r">추가 금액</span>
              <span className="r">재고</span>
              <span />
            </div>
            {rows.map((o, i) => {
              const re = shown.rows[o.key] ?? {};
              return (
                <div className="opt-row" key={o.key} data-testid="option-row">
                  <div className="fld opt-name">
                    <input
                      className={`inp inp-sm${re.name ? " is-error" : ""}`}
                      type="text"
                      placeholder="예: 1박스 (36팩)"
                      aria-label={`옵션 ${i + 1} 이름`}
                      value={o.name}
                      onChange={(e) => setRow(o.key, { name: e.target.value })}
                    />
                    {re.name && <span className="err">{re.name}</span>}
                  </div>
                  <div className="fld">
                    <span className="opt-lbl">추가 금액</span>
                    <input
                      className={`inp inp-sm num${re.priceDelta ? " is-error" : ""}`}
                      type="text"
                      inputMode="numeric"
                      aria-label={`옵션 ${i + 1} 추가 금액`}
                      value={o.priceDelta}
                      onChange={(e) => setRow(o.key, { priceDelta: e.target.value })}
                      style={{ textAlign: "right" }}
                    />
                    {re.priceDelta && <span className="err">{re.priceDelta}</span>}
                  </div>
                  <div className="fld">
                    <span className="opt-lbl">재고</span>
                    <input
                      className={`inp inp-sm num${re.stock ? " is-error" : ""}`}
                      type="text"
                      inputMode="numeric"
                      aria-label={`옵션 ${i + 1} 재고`}
                      value={o.stock}
                      onChange={(e) => setRow(o.key, { stock: e.target.value })}
                      style={{ textAlign: "right" }}
                    />
                    {re.stock && <span className="err">{re.stock}</span>}
                  </div>
                  <button className="icon-btn opt-del" type="button" aria-label={`옵션 ${i + 1} 삭제`} onClick={() => removeRow(o)} style={{ width: 32, height: 32 }}>
                    ×
                  </button>
                </div>
              );
            })}
            {rows.length === 0 && <span className="t-l2 c-alt">옵션이 없습니다. 옵션을 추가해야 판매할 수 있습니다</span>}
            {shown.options && <span className="err">{shown.options}</span>}
          </section>

          <section className="card pad-l col" style={{ gap: 12 }}>
            <h2 className="t-hl1">판매 상태</h2>
            <div className="seg" role="radiogroup" aria-label="판매 상태" style={{ alignSelf: "flex-start" }}>
              {statusChoices.map((s) => (
                <button key={s} type="button" role="radio" aria-checked={status === s} className={status === s ? "on" : ""} onClick={() => setStatus(s)}>
                  {STATUS_LABEL[s]}
                </button>
              ))}
            </div>
            <span className="help">{STATUS_HELP[status]}</span>
          </section>

          <section className="card pad-l col" style={{ gap: 12 }}>
            <h2 className="t-hl1">재고 차감 기준</h2>
            <div className="seg" role="radiogroup" aria-label="재고 차감 기준" style={{ alignSelf: "flex-start" }}>
              {(
                [
                  ["PAYMENT", "결제하면 차감"],
                  ["ORDER", "주문하면 바로 차감"],
                ] as const
              ).map(([v, label]) => (
                <button key={v} type="button" role="radio" aria-checked={deduct === v} className={deduct === v ? "on" : ""} onClick={() => setDeduct(v)}>
                  {label}
                </button>
              ))}
            </div>
            <span className="help">
              기본은 결제하면 차감입니다 · 「주문하면 바로 차감」은 선착순·한정 판매에 적합합니다 · {restockText}
              {isEdit ? " · 변경하면 다음 주문부터 적용됩니다" : ""}
            </span>
          </section>

          {isEdit && (
            <section className="card pad-l col" style={{ gap: 12, boxShadow: "inset 0 0 0 1px var(--wds-line-status-negative-normal)" }}>
              <h2 className="t-hl1 c-neg">상품 삭제</h2>
              <div className="row between" style={{ gap: 12 }}>
                <span className="t-c1 c-alt">판매한 적이 있는 상품은 삭제 대신 「숨김」을 권장합니다. 삭제해도 주문 기록은 남습니다.</span>
                <button className="btn btn-out" type="button" style={{ color: "var(--neg-text)" }} onClick={() => setConfirmDelete(true)} disabled={busy}>
                  삭제
                </button>
              </div>
            </section>
          )}
        </div>

        <aside className="col aside-sticky" style={{ gap: 16 }}>
          <ProductPreview name={name} description={description} price={priceNum} status={status} rows={rows} />
          <div className="card pad col" style={{ gap: 8 }}>
            <span className="t-hl2">필수 입력 항목</span>
            <span className="t-l2 c-neu">상품명, 판매가, 옵션 이름은 비워 둘 수 없습니다</span>
          </div>
          <div className="col" style={{ gap: 8 }}>
            {saveButtons(true)}
            {!required && (
              <span className="t-c1 c-alt" style={{ textAlign: "center" }}>
                필수 항목을 채우면 {isEdit ? "저장" : "등록"}할 수 있습니다
              </span>
            )}
          </div>
        </aside>
      </main>
      {confirmDelete && base && (
        <DeleteDialog
          product={base}
          onClose={() => setConfirmDelete(false)}
          onHidden={(p) => {
            setBase(p);
            setStatus(p.status);
            setConfirmDelete(false);
            setToast("숨김으로 변경했습니다");
          }}
        />
      )}
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}

// 쇼핑몰 미리보기: 저장 전 입력값(상품명·설명·판매가·옵션·판매 상태)을 그대로 그린다(저장된 서버 값을 쓰지 않음).
// 설명은 구매자 화면처럼 줄바꿈을 지키고, 길면 몇 줄 뒤 접어 「더보기」로 편다. 사진 기능이 없어 사진 칸은 낮게 둔다.
const DESC_PREVIEW_LINES = 6;
function ProductPreview({ name, description, price, status, rows }: { name: string; description: string; price: number | null; status: ProductStatus; rows: OptRow[] }) {
  const [open, setOpen] = useState(false);
  const desc = description.trim();
  const long = desc.split("\n").length > DESC_PREVIEW_LINES || textLength(desc) > DESC_PREVIEW_LINES * 22;
  const options = rows.filter((r) => r.name.trim() !== "");
  const priceText = (r: OptRow) => {
    const delta = parseAmount(r.priceDelta) ?? 0;
    return price === null ? "—" : won(Math.max(0, price + delta));
  };
  const soldOut = status === "SOLD_OUT";
  return (
    <div className="card pad col pcard pv" style={{ gap: 10 }} data-testid="product-preview">
      <span className="t-hl2">쇼핑몰 미리보기</span>
      {(status === "HIDDEN" || status === "DRAFT") && (
        <span className="t-c1 c-alt" data-testid="preview-status-note">
          {status === "HIDDEN" ? "숨김 상태라 쇼핑몰에 표시되지 않습니다" : "임시 저장 상태라 쇼핑몰에 표시되지 않습니다"}
        </span>
      )}
      <div className="img pv-img" title="이미지 없음">
        <NoImage size={32} />
      </div>
      {soldOut && (
        <span className="pbadge">
          <span className="bdg b-fail">품절</span>
        </span>
      )}
      <span className={`t-b1 fw6 pname${textLength(name) ? "" : " c-ast"}`} data-testid="preview-name">
        {textLength(name) ? name.trim() : "상품명을 입력해 주십시오"}
      </span>
      <span className="pprice">
        <span className={`t-hl1 num${price ? "" : " c-ast"}`} data-testid="preview-price">
          {won(price ?? 0)}
        </span>
      </span>
      {options.length > 1 || (options.length === 1 && options[0].name.trim() !== "기본") ? (
        <ul className="pv-opts" data-testid="preview-options">
          {options.map((r) => (
            <li key={r.key} className="row between t-l2" style={{ gap: 8 }}>
              <span className="ell">{r.name.trim()}</span>
              <span className="num c-alt">{soldOut || parseAmount(r.stock) === 0 ? "품절" : priceText(r)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {desc ? (
        <div className="col" style={{ gap: 4 }}>
          <p className={`t-l2 pv-desc${long && !open ? " clamp" : ""}`} data-testid="preview-description">
            {desc}
          </p>
          {long && (
            <button className="btn btn-sm btn-ghost" type="button" style={{ alignSelf: "flex-start" }} onClick={() => setOpen((v) => !v)}>
              {open ? "접기" : "더보기"}
            </button>
          )}
        </div>
      ) : (
        <span className="t-l2 c-ast" data-testid="preview-description">
          상품 설명을 입력하면 여기에 표시됩니다
        </span>
      )}
    </div>
  );
}

// 받침이 있으면 「을」, 없으면 「를」
function objectParticle(word: string): string {
  const c = word.trim().charCodeAt(word.trim().length - 1);
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0 ? "을" : "를";
}

// SA-012-D 삭제 확인: 숨김을 먼저 권하고, 완전 삭제는 상품명을 그대로 입력해야 할 수 있다
function DeleteDialog({ product, onClose, onHidden }: { product: Product; onClose: () => void; onHidden: (p: Product) => void }) {
  const router = useRouter();
  const [mode, setMode] = useState<"hide" | "delete">("hide");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = mode === "hide" || typed.trim() === product.name;

  const run = async () => {
    setBusy(true);
    setError(null);
    if (mode === "hide") {
      const r = await api<Product>(`/api/seller/products/${product.id}`, { method: "PATCH", body: { status: "HIDDEN" } });
      setBusy(false);
      if (!r.ok) return setError(failMessage(r, "admin", "숨기지 못했습니다"));
      return onHidden(r.data);
    }
    const r = await api(`/api/seller/products/${product.id}`, { method: "DELETE" });
    if (!r.ok) {
      setBusy(false);
      return setError(failMessage(r, "admin", "삭제하지 못했습니다"));
    }
    router.push("/seller/products?toast=deleted");
  };

  return (
    <div className="dim dim-fixed" role="dialog" aria-modal="true" aria-labelledby="del-title">
      <div className="modal">
        <div className="modal-h">
          <h3 id="del-title" className="t-hl1 c-neg">
            「{product.name}」{objectParticle(product.name)} 삭제하시겠습니까?
          </h3>
          <p className="t-b2 c-neu">쇼핑몰과 주문대기에서 바로 사라집니다. 지난 주문 기록은 남지만 상품은 되살릴 수 없습니다.</p>
        </div>
        {error && (
          <div className="msg msg-neg" role="alert">
            {error}
          </div>
        )}
        <div className="col" style={{ gap: 8 }}>
          <label className={`row choice${mode === "hide" ? " on" : ""}`} style={{ gap: 10 }}>
            <input className="rdo" type="radio" name="del-mode" checked={mode === "hide"} onChange={() => setMode("hide")} />
            <span className="col">
              <span className="t-l1 fw6">숨김으로 변경 (권장)</span>
              <span className="t-c1 c-alt">쇼핑몰에서만 사라지고 언제든 다시 판매할 수 있습니다</span>
            </span>
          </label>
          <label className={`row choice${mode === "delete" ? " on" : ""}`} style={{ gap: 10 }}>
            <input className="rdo" type="radio" name="del-mode" checked={mode === "delete"} onChange={() => setMode("delete")} />
            <span className="col">
              <span className="t-l1 fw6 c-neg">완전 삭제</span>
              <span className="t-c1 c-alt">되돌릴 수 없습니다 · 상품명을 입력해 확인합니다</span>
            </span>
          </label>
          {mode === "delete" && (
            <input className="inp" type="text" placeholder={product.name} aria-label="삭제할 상품명 입력" value={typed} onChange={(e) => setTyped(e.target.value)} />
          )}
        </div>
        <div className="modal-f">
          <button className="btn btn-out" type="button" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button className={`btn${mode === "delete" ? " btn-neg" : ""}`} type="button" onClick={() => void run()} disabled={busy || !ok}>
            {mode === "hide" ? "숨김으로 변경" : "삭제"}
          </button>
        </div>
      </div>
    </div>
  );
}
