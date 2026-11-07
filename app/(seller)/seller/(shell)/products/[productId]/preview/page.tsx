"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { FormRow, PageHead } from "../../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../../components/seller/SellerShell";
import { SmartBackButton } from "../../../../../../../components/seller/SmartBackButton";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../../components/seller/States";
import { api } from "../../../../../../../components/seller/api";
import { won } from "../../../../../../../components/seller/format";
import "./preview.css";

// SA-013 상품 상세 미리보기(파트너스 관리자, 상품 › 상품 목록 › 미리보기, 정본 v336). 구매자에게 보이는 상품 화면(모바일 · PC)과 점검 항목, 공유 링크.
// 값은 GET /api/seller/products/{id}/preview 한 번으로 받는다(구매자 상품 상세와 같은 규칙: 보이는 카테고리 · 적립 예정 · 방송 중 여부 · 점검 항목 · 열기 주소). 로고만 /api/seller/shop-content/logo.
// 상품별 구매 제한은 서버에 모델이 없어(purchaseLimits null) 정본의 「구매 제한」 점검 행은 두지 않는다(서버 필요).
type Preview = {
  shop: { slug: string; name: string };
  product: {
    id: string;
    name: string;
    description: string;
    isLive: boolean;
    status: string;
    price: number;
    event: { active: boolean; discountedPrice: number; discountRate: number | null } | null;
    stock: number;
    soldOut: boolean;
    visibleToBuyers: boolean;
    images: { id: string; url: string; width: number; height: number; isThumbnail: boolean }[];
    categories: string[];
  };
  reward: { card: { rate: number; amount: number } | null; bankTransfer: { rate: number; amount: number } | null } | null;
  checks: { key: "images" | "description" | "price" | "stock" | "categories"; status: "ok" | "warn"; detail: string }[];
  open: { canOpen: boolean; path: string };
  share: { path: string; card: { title: string; price: number; imageUrl: string | null } };
};
const CHECK_LABEL: Record<Preview["checks"][number]["key"], string> = { images: "이미지", description: "설명 · 가격 · 할인", price: "설명 · 가격 · 할인", stock: "재고", categories: "카테고리" };

export default function ProductPreviewPage() {
  const { productId } = useParams<{ productId: string }>();
  const { me, can } = useSeller();
  const allowed = can("PRODUCT_MANAGE");
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; data: Preview }>({ kind: "loading" });
  const [logo, setLogo] = useState<string | null>(null);
  const [view, setView] = useState<"mobile" | "pc">("mobile");
  const [host, setHost] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await api<Preview>(`/api/seller/products/${productId}/preview`);
    if (!r.ok) return setState({ kind: "error", status: r.status });
    setState({ kind: "ok", data: r.data });
    const lg = await api<{ logo: { url: string } | null }>("/api/seller/shop-content/logo");
    if (lg.ok) setLogo(lg.data.logo?.url ?? null);
  }, [productId]);
  useEffect(() => {
    setHost(window.location.host);
    if (allowed) void load();
  }, [allowed, load]);

  const data = state.kind === "ok" ? state.data : null;
  const shopUrl = `${typeof window === "undefined" ? "" : window.location.protocol}//${host}${data?.share.path ?? `/shop/${me.shop.slug}/products/${productId}`}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shopUrl);
      setToast("상품 주소를 복사했습니다");
    } catch {
      setToast("복사하지 못했습니다. 주소를 직접 선택해 복사해 주십시오");
    }
  };

  const p = data?.product ?? null;
  const images = p?.images ?? [];
  const soldOut = !!p?.soldOut;
  const hidden = !!p && !p.visibleToBuyers;
  const ev = p?.event?.active ? p.event : null;
  const rate = ev?.discountRate ?? null;
  const shownPrice = ev ? ev.discountedPrice : (p?.price ?? 0);
  const reward = data?.reward
    ? `${data.reward.card ? `카드 결제 시 ${data.reward.card.rate}%` : ""}${data.reward.card && data.reward.bankTransfer ? " · " : ""}${data.reward.bankTransfer ? `무통장 ${data.reward.bankTransfer.rate}%` : ""} 적립`
    : null;
  // 서버 점검 항목: 설명 · 가격은 정본에서 한 행이라 합치고(하나라도 주의면 주의), 나머지는 한 줄씩
  const rows: { label: string; status: "ok" | "warn"; detail: string }[] = [];
  for (const c of data?.checks ?? []) {
    const label = CHECK_LABEL[c.key];
    const last = rows[rows.length - 1];
    if (c.key === "price" && last?.label === label) {
      last.detail = `${last.detail} · ${c.detail}`;
      if (c.status === "warn") last.status = "warn";
    } else rows.push({ label, status: c.status, detail: c.detail });
  }

  return (
    <>
      <Topbar crumb="상품 › 상품 목록 › 상품 상세 미리보기" />
      <main className="main">
        <PageHead
          back="/seller/products"
          title="상품 상세 미리보기"
          actions={
            p && (
              <>
                <Link className="btn btn-out" href={`/seller/products/${productId}`}>
                  상품 수정
                </Link>
                {hidden || !data?.open.canOpen ? (
                  <button className="btn" type="button" disabled>
                    쇼핑몰에서 열기
                  </button>
                ) : (
                  <a className="btn" href={data?.open.path ?? `/shop/${me.shop.slug}/products/${productId}`} target="_blank" rel="noreferrer">
                    쇼핑몰에서 열기
                  </a>
                )}
              </>
            )
          }
        />
        {!allowed && (
          <div className="card">
            <NoPermission need="상품" />
          </div>
        )}
        {allowed && state.kind === "loading" && (
          <div className="card">
            <LoadingRows rows={5} />
          </div>
        )}
        {allowed && state.kind === "error" && (
          <div className="card">
            {state.status === 404 ? (
              <div className="st" style={{ boxShadow: "none" }}>
                <span className="t">상품을 찾을 수 없습니다</span>
                <span className="s">이미 삭제된 상품일 수 있습니다.</span>
                <SmartBackButton fallback="/seller/products" className="btn btn-sm btn-out">상품 목록</SmartBackButton>
              </div>
            ) : state.status === 402 ? (
              <Locked />
            ) : (
              <ErrorState title="미리보기를 불러오지 못했습니다" onRetry={() => void load()} />
            )}
          </div>
        )}
        {allowed && p && (
          <>
            {hidden && (
              <div className="msg msg-cau" role="note" style={{ marginBottom: 16 }}>
                <span>
                  <b>{p.status === "DRAFT" ? "임시 저장 상태" : "숨김 상태"}</b> · 구매자에게 보이지 않습니다 · 미리보기는 할 수 있고 「쇼핑몰에서 열기」는 눌리지 않습니다
                </span>
              </div>
            )}
            <div className="pv-two">
              <section className="au-fs">
                <div className="au-fs-h">
                  <h2 className="au-fs-t">구매자 화면</h2>
                  <div className="seg" role="group" aria-label="보기 방식">
                    <button type="button" className={view === "mobile" ? "on" : ""} aria-pressed={view === "mobile"} onClick={() => setView("mobile")}>
                      모바일
                    </button>
                    <button type="button" className={view === "pc" ? "on" : ""} aria-pressed={view === "pc"} onClick={() => setView("pc")}>
                      PC
                    </button>
                  </div>
                </div>
                <div className={`pv-frame${view === "pc" ? " is-pc" : ""}`} data-testid="preview-frame">
                  <div className="pv-top">
                    <span aria-hidden="true">‹</span>
                    {logo && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={logo} alt="" width={20} height={20} style={{ borderRadius: 4 }} />
                    )}
                    <span>{data?.shop.name ?? me.shop.name}</span>
                  </div>
                  <div className="pv-img">
                    {images[0] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={images[0].url} alt="대표 이미지" />
                    ) : (
                      <span>이미지 없음</span>
                    )}
                  </div>
                  {images.length > 0 && <div className="t-c1 c-alt" style={{ padding: "8px 16px 0" }}>대표 이미지 1 / {images.length}</div>}
                  <div className="pv-body">
                    <span className="row" style={{ gap: 6 }}>
                      {p.isLive && <span className="bdg b-info nodot">방송 주문대기 상품</span>}
                      {soldOut ? <span className="bdg b-fail nodot">품절</span> : <span className="bdg b-gray nodot">재고 {p.stock.toLocaleString("ko-KR")}</span>}
                    </span>
                    <div className="pv-name" data-testid="preview-name">
                      {p.name}
                    </div>
                    <div className="row" style={{ gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                      <b data-testid="preview-price">{won(shownPrice)}</b>
                      {ev && (
                        <>
                          <s className="c-alt">{won(p.price)}</s>
                          {rate !== null && <span className="bdg b-fail nodot">{rate}%</span>}
                        </>
                      )}
                    </div>
                    {reward && <div className="t-c1 c-alt">{reward}</div>}
                    {p.description && <div className="pv-desc">{p.description}</div>}
                  </div>
                  <div className="pv-buy" aria-hidden="true">
                    {soldOut ? (
                      <>
                        <button className="btn btn-lg btn-out" type="button" tabIndex={-1} disabled>
                          품절
                        </button>
                        <button className="btn btn-lg" type="button" tabIndex={-1}>
                          재입고 알림 받기
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="btn btn-lg btn-out" type="button" tabIndex={-1}>
                          장바구니
                        </button>
                        <button className="btn btn-lg" type="button" tabIndex={-1}>
                          바로 주문
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </section>
              <div className="col" style={{ gap: 16 }}>
                <div className="msg msg-info" role="note">
                  <span>구매자에게 보이는 그대로입니다 · 테마색 · 로고는 쇼핑몰 정보를 따릅니다</span>
                </div>
                <section className="au-fs">
                  <div className="au-fs-h">
                    <h2 className="au-fs-t">점검 항목</h2>
                  </div>
                  <table className="au-ft" data-testid="preview-checks">
                    <tbody>
                      {rows.map((c) => (
                        <FormRow key={c.label} label={c.label}>
                          <span className={`bdg ${c.status === "ok" ? "b-done" : "b-warn"} nodot`}>{c.status === "ok" ? "확인" : "주의"}</span> {c.detail}
                        </FormRow>
                      ))}
                    </tbody>
                  </table>
                </section>
                <section className="au-fs">
                  <div className="au-fs-h">
                    <h2 className="au-fs-t">공유 링크</h2>
                  </div>
                  <table className="au-ft">
                    <tbody>
                      <FormRow label="상품 주소" help="공유 카드는 상품 대표 이미지 · 상품명 · 가격으로 만들어집니다">
                        <input className="inp" readOnly value={shopUrl} aria-label="상품 주소" style={{ width: 360, maxWidth: "100%" }} />
                        <button className="btn btn-out" type="button" onClick={() => void copy()}>
                          복사
                        </button>
                      </FormRow>
                    </tbody>
                  </table>
                </section>
                <div>
                  <Link className="btn btn-out" href="/seller/products">
                    상품 목록
                  </Link>
                </div>
              </div>
            </div>
          </>
        )}
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
