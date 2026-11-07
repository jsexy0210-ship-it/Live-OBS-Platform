"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ListHead, ListTable, PageHead, useConfirm } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";
import { won } from "../../../../../../components/seller/format";

// SA-082 배송 자동화(주문 · 배송 설정 › 배송 자동화 탭). 서버: GET·PUT /api/seller/shipping-automation(계약은 lib/server/sellers/shippingAutomation.ts).
// 기능 4개의 켜기/끄기는 확인 창을 거친다. 켜기 확인 문구의 단가 설명은 정본 그대로, 단가·사용 금액·잔액은 서버 값 그대로 보인다.
// 왼쪽 메뉴의 「배송 자동화」 탭 연결은 셸(SellerShell) 소관이라 레이아웃 전담에 요청한다.

type Feature = "invoiceIssue" | "invoiceLabel" | "deliveryTracking" | "returnInvoice";
type Row = { feature: Feature; enabled: boolean; unitPrice: number; monthCount: number; monthAmount: number };
type Data = { features: Row[]; enabledCount: number; monthCount: number; monthAmount: number; balance: number; chargingEnabled: boolean; shortage: Feature[] };

const INFO: Record<Feature, { name: string; desc: string; offBody: string }> = {
  invoiceIssue: { name: "송장 자동 발급", desc: "주문에서 송장 번호를 자동으로 받아 입력합니다", offBody: "끄면 새 주문의 송장은 직접 입력해야 합니다 · 이미 발급된 송장은 그대로입니다" },
  invoiceLabel: { name: "송장 출력", desc: "송장 라벨을 한꺼번에 출력합니다", offBody: "끄면 송장 라벨을 한꺼번에 출력할 수 없습니다 · 이미 출력한 라벨은 그대로입니다" },
  deliveryTracking: { name: "배송 자동 조회", desc: "배송 상태를 자동으로 확인해 구매자에게 알립니다", offBody: "끄면 배송 상태를 자동으로 확인하지 않습니다 · 이미 쓴 금액은 그대로입니다" },
  returnInvoice: { name: "반품 송장 연동", desc: "반품 접수 때 반품 송장을 자동으로 만듭니다", offBody: "끄면 반품 송장을 직접 입력해야 합니다 · 이미 만든 반품 송장은 그대로입니다" },
};
const PARTICLE: Record<Feature, string> = { invoiceIssue: "을", invoiceLabel: "을", deliveryTracking: "를", returnInvoice: "을" };
const ON_BODY = "켜면 사용 1건마다 건당 단가가 발송 · 이용 충전금에서 차감됩니다 · 끄면 바로 멈추고 이미 쓴 금액은 그대로입니다";

export default function ShippingAutomationPage() {
  const { me } = useSeller();
  const { confirm } = useConfirm();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; data: Data }>({ kind: "loading" });
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  const load = useCallback(async () => {
    const r = await api<Data>("/api/seller/shipping-automation");
    setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error", status: r.status });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (row: Row, next: boolean) => {
    if (row.enabled === next) return;
    const name = INFO[row.feature].name;
    await confirm({
      title: `「${name}」${PARTICLE[row.feature]} ${next ? "켜시겠습니까?" : "끄시겠습니까?"}`,
      body: next ? ON_BODY : INFO[row.feature].offBody,
      confirmLabel: next ? "켜기" : "끄기",
      run: async () => {
        const r = await api<Data>("/api/seller/shipping-automation", { method: "PUT", body: { [row.feature]: next } });
        if (!r.ok) return failMessage(r, "admin", "바꾸지 못했습니다");
        setState({ kind: "ok", data: r.data });
        setToast({ text: `「${name}」${PARTICLE[row.feature]} ${next ? "켰습니다" : "껐습니다"}` });
        return undefined;
      },
    });
  };

  const d = state.kind === "ok" ? state.data : null;
  return (
    <>
      <Topbar crumb="설정 › 주문 · 배송 설정 › 배송 자동화" />
      <main className="main">
        <PageHead
          title="배송 자동화"
          description="기능을 켜면 쓴 만큼만 건당 단가가 발송 · 이용 충전금에서 차감됩니다 · 충전금이 없으면 자동화는 멈추고 주문 처리는 계속됩니다 · 단가는 마스터 관리자가 정합니다"
          actions={
            me.isOwner ? (
              <Link className="btn" href="/seller/settings/message-balance">
                발송 · 이용 충전
              </Link>
            ) : undefined
          }
        />
        {state.kind === "loading" && (
          <div className="card">
            <LoadingRows rows={5} />
          </div>
        )}
        {state.kind === "error" && (
          <div className="card">
            {state.status === 402 ? (
              <Locked />
            ) : state.status === 403 ? (
              <NoPermission need="쇼핑몰 설정" />
            ) : (
              <ErrorState title="배송 자동화를 불러오지 못했습니다" onRetry={() => void load()} />
            )}
          </div>
        )}
        {d && (
          <>
            {d.shortage.length > 0 && (
              <div className="msg msg-neg" role="alert" style={{ marginBottom: 16 }}>
                <span>
                  <b>발송 · 이용 충전금이 부족합니다.</b> 자동화가 멈춰 있고 주문 처리는 계속됩니다 · 충전하면 바로 다시 켜집니다
                </span>
                {me.isOwner && (
                  <Link className="btn btn-pri" href="/seller/settings/message-balance">
                    충전하기
                  </Link>
                )}
              </div>
            )}
            <div className="g3" style={{ marginBottom: 16 }}>
              <div className="card stat">
                <span className="t-l2 c-alt">발송 · 이용 충전금 잔액</span>
                <span className="v">{won(d.balance)}</span>
              </div>
              <div className="card stat">
                <span className="t-l2 c-alt">이번 달 사용 건수</span>
                <span className="v">{d.monthCount.toLocaleString("ko-KR")}건</span>
              </div>
              <div className="card stat">
                <span className="t-l2 c-alt">이번 달 사용 금액</span>
                <span className="v">{won(d.monthAmount)}</span>
              </div>
            </div>
            {d.monthCount === 0 && (
              <div className="msg msg-info" role="note" style={{ marginBottom: 16 }}>
                <span>이번 달 사용한 기능이 없습니다. 기능을 켜면 사용 건수와 금액이 여기에 표시됩니다.</span>
              </div>
            )}
            <section className="au-list-section">
              <ListHead total={d.features.length} unit="개" actions={<span className="t-l2 c-alt">켜진 기능 {d.enabledCount}개</span>} />
              <ListTable aria-label="배송 자동화 기능 표">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 200 }}>기능</th>
                      <th>설명</th>
                      <th style={{ width: 150 }}>사용</th>
                      <th className="num" style={{ width: 120 }}>건당 단가</th>
                      <th className="num" style={{ width: 140 }}>이번 달 사용 건수</th>
                      <th className="num" style={{ width: 140 }}>이번 달 금액</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.features.map((row) => (
                      <tr key={row.feature}>
                        <td className="col-text">
                          <b>{INFO[row.feature].name}</b>
                        </td>
                        <td className="col-desc">{INFO[row.feature].desc}</td>
                        <td>
                          <div className="seg" role="group" aria-label={`${INFO[row.feature].name} 사용`}>
                            <button type="button" className={row.enabled ? "on" : ""} aria-pressed={row.enabled} onClick={() => void toggle(row, true)}>
                              켜짐
                            </button>
                            <button type="button" className={row.enabled ? "" : "on"} aria-pressed={!row.enabled} onClick={() => void toggle(row, false)}>
                              꺼짐
                            </button>
                          </div>
                        </td>
                        <td className="num">{won(row.unitPrice)}</td>
                        <td className="num">{row.monthCount.toLocaleString("ko-KR")}건</td>
                        <td className="num">{won(row.monthAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ListTable>
            </section>
          </>
        )}
      </main>
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
