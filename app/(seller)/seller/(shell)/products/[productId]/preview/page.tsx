"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { FormRow, PageHead } from "../../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../../components/seller/SellerShell";
import { SmartBackButton } from "../../../../../../../components/seller/SmartBackButton";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../../components/seller/States";
import { api, type Product } from "../../../../../../../components/seller/api";
import { won } from "../../../../../../../components/seller/format";
import "./preview.css";

// SA-013 상품 상세 미리보기(파트너스 관리자, 상품 › 상품 목록 › 미리보기, 정본 v320). 구매자에게 보이는 상품 화면(모바일 · PC)과 점검 항목, 공유 링크. 숨김 상품도 미리볼 수 있고 「쇼핑몰에서 열기」만 막는다.
// 값은 기존 API를 모아 쓴다: GET /api/seller/products/{id}(상품 · 옵션 재고 · 이미지 · 이벤트 할인), …/categories + /api/seller/categories(이름), /api/seller/shop-content/logo(로고), /api/seller/reward-policy(적립 안내).
type EventView = { active?: boolean; discountedPrice?: number; type?: string; value?: number } | null;
type ProductView = Product & { event?: EventView };
type Cat = { id: string; name: string; children?: Cat[] };
type Grade = { name: string; systemKey: string | null; card: number | null; bankTransfer: number | null };
const LOW_STOCK = 5; // 목록의 「재고 적음」 기준과 같다

export default function ProductPreviewPage() {
  const { productId } = useParams<{ productId: string }>();
  const { me, can } = useSeller();
  const allowed = can("PRODUCT_MANAGE");
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; product: ProductView }>({ kind: "loading" });
  const [cats, setCats] = useState<string[]>([]);
  const [logo, setLogo] = useState<string | null>(null);
  const [reward, setReward] = useState<string | null>(null);
  const [view, setView] = useState<"mobile" | "pc">("mobile");
  const [host, setHost] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await api<ProductView>(`/api/seller/products/${productId}`);
    if (!r.ok) return setState({ kind: "error", status: r.status });
    setState({ kind: "ok", product: r.data });
    const [mine, all, lg, rp] = await Promise.all([
      api<{ categoryIds: string[] }>(`/api/seller/products/${productId}/categories`),
      api<{ categories: Cat[] }>("/api/seller/categories"),
      api<{ logo: { url: string } | null }>("/api/seller/shop-content/logo"),
      api<{ policy: { configured: boolean; grades: Grade[] } }>("/api/seller/reward-policy"),
    ]);
    if (mine.ok && all.ok) {
      // 카테고리 트리를 「대분류 · 소분류」 이름 표로 편다
      const names = new Map<string, string>();
      for (const top of all.data.categories) {
        names.set(top.id, top.name);
        for (const c of top.children ?? []) names.set(c.id, `${top.name} · ${c.name}`);
      }
      setCats(mine.data.categoryIds.map((id) => names.get(id)).filter((n): n is string => !!n));
    }
    if (lg.ok) setLogo(lg.data.logo?.url ?? null);
    if (rp.ok && rp.data.policy.configured) {
      const g = rp.data.policy.grades.find((x) => x.systemKey === "DEFAULT" || x.systemKey === "GENERAL") ?? rp.data.policy.grades[0];
      if (g && (g.card || g.bankTransfer)) setReward(`${g.card ? `카드 결제 시 ${g.card}%` : ""}${g.card && g.bankTransfer ? " · " : ""}${g.bankTransfer ? `무통장 ${g.bankTransfer}%` : ""} 적립 (${g.name} 등급)`);
    }
  }, [productId]);
  useEffect(() => {
    setHost(window.location.host);
    if (allowed) void load();
  }, [allowed, load]);

  const shopUrl = `${typeof window === "undefined" ? "" : window.location.protocol}//${host}/shop/${me.shop.slug}/products/${productId}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shopUrl);
      setToast("상품 주소를 복사했습니다");
    } catch {
      setToast("복사하지 못했습니다. 주소를 직접 선택해 복사해 주십시오");
    }
  };

  const p = state.kind === "ok" ? state.product : null;
  const images = p?.images ?? [];
  const stock = p ? p.options.reduce((n, o) => n + o.stock, 0) : 0;
  const soldOut = !!p && (p.status === "SOLD_OUT" || (p.options.length > 0 && stock === 0));
  const hidden = p?.status === "HIDDEN" || p?.status === "DRAFT";
  const ev = p?.event?.active && typeof p.event.discountedPrice === "number" ? p.event : null;
  const rate = ev && p && p.price > 0 ? Math.round((1 - ev.discountedPrice! / p.price) * 100) : null;
  const shownPrice = ev ? ev.discountedPrice! : (p?.price ?? 0);

  return (
    <>
      <Topbar crumb="상품 › 상품 목록 › 상품 상세 미리보기" />
      <main className="main">
        <PageHead description="상품이 구매자 화면에 어떻게 표시되는지 확인합니다."
          back="/seller/products"
          title="상품 상세 미리보기"
          actions={
            p && (
              <>
                <Link className="btn btn-out" href={`/seller/products/${productId}`}>
                  상품 수정
                </Link>
                {hidden ? (
                  <button className="btn" type="button" disabled>
                    쇼핑몰에서 열기
                  </button>
                ) : (
                  <a className="btn" href={`/shop/${me.shop.slug}/products/${productId}`} target="_blank" rel="noreferrer">
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
                    <span>{me.shop.name}</span>
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
                      {soldOut ? <span className="bdg b-fail nodot">품절</span> : <span className="bdg b-gray nodot">재고 {stock.toLocaleString("ko-KR")}</span>}
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
                      <FormRow label="이미지">
                        {images.length === 0 ? (
                          <>
                            <span className="bdg b-warn nodot">주의</span> 이미지가 없습니다 · 구매자 화면에 빈 자리로 보입니다
                          </>
                        ) : (
                          <>
                            <span className="bdg b-done nodot">확인</span> {images.length}장{images[0].width === images[0].height ? " · 1:1" : ` · ${images[0].width}×${images[0].height}`}
                          </>
                        )}
                      </FormRow>
                      <FormRow label="설명 · 가격 · 할인">
                        {p.description || p.price > 0 ? (
                          <>
                            <span className="bdg b-done nodot">확인</span> 표시 정상
                          </>
                        ) : (
                          <>
                            <span className="bdg b-warn nodot">주의</span> 설명이 없습니다
                          </>
                        )}
                      </FormRow>
                      <FormRow label="재고">
                        {stock > LOW_STOCK ? (
                          <>
                            <span className="bdg b-done nodot">확인</span> 재고 {stock.toLocaleString("ko-KR")}
                          </>
                        ) : (
                          <>
                            <span className="bdg b-warn nodot">주의</span> 재고 {stock.toLocaleString("ko-KR")} · {stock === 0 ? "품절로 보입니다" : "방송 중에 품절될 수 있습니다"}
                          </>
                        )}
                      </FormRow>
                      <FormRow label="카테고리">{cats.length > 0 ? cats.join(" / ") : "지정한 카테고리가 없습니다"}</FormRow>
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
