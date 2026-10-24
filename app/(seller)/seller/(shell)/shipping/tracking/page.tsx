"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ListTable, PageHead } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import { InvoiceSteps } from "../../../../../../components/seller/shipping/InvoiceSteps";
import { INVOICE_EVENT as EVENT, INVOICE_SOURCE as SOURCE, INVOICE_TAG as TAG, type InvoiceRow as Inv, type InvoiceDetail } from "../../../../../../components/seller/InvoiceOperations";
import { formatDateTime } from "../../../../../../lib/client/format";
import { useUrlState } from "../../../../../../lib/client/navigation";
import "../../../../../../styles/seller-orders.css";
import "../../../../../../styles/seller-invoices.css";

// SA-028 송장 출력 · 추적(통합 「배송 · 송장」 탭). 발급 · 출력 · 집하 · 배송 완료를 따로 보여 준다. 배송 접수 업체가 정해지기 전이라 서버는 모의 추적이다.

type Status = Inv["status"];
type Page = { invoices: Inv[]; nextCursor: string | null; counts: Partial<Record<Status, number>>; total: number; mock: boolean; unprinted: number };
type Detail = Pick<InvoiceDetail, "events">;
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; page: Page };

const TABS: { key: string; label: string; status?: Status }[] = [
  { key: "all", label: "전체" },
  { key: "issued", label: "발급됨", status: "ISSUED" },
  { key: "printed", label: "출력됨", status: "PRINTED" },
  { key: "picked", label: "집하됨", status: "PICKED_UP" },
  { key: "delivered", label: "배송 완료", status: "DELIVERED" },
];
const num = (n: string) => n.replace(/\D/g, "").replace(/(\d{4})(?=\d)/g, "$1 ").trim();

export default function InvoiceTrackingPage() {
  const { can, me } = useSeller();
  const canEdit = can("ORDER_SHIPPING") && !me.readOnly;
  const searchParams = useSearchParams().toString();
  const returnTo = `/seller/shipping/tracking${searchParams ? `?${searchParams}` : ""}`;
  const [u, setU] = useUrlState({ tab: "all" });
  const tab = TABS.find((t) => t.key === u.tab) ?? TABS[0];
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [format, setFormat] = useState<"LABEL_100X150" | "A4_2UP">("LABEL_100X150");
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const reqId = useRef(0);
  const openId = useRef<string | null>(null);

  const load = useCallback(async (status?: Status, quiet = false) => {
    const id = ++reqId.current;
    if (!quiet) setState({ kind: "loading" });
    const r = await api<Page>(`/api/seller/invoices${status ? `?status=${status}` : ""}`);
    if (id !== reqId.current) return;
    if (r.ok) setState({ kind: "ok", page: r.data });
    else if (!quiet) setState({ kind: "error", status: r.status });
  }, []);
  useEffect(() => {
    setPicked(new Set());
    setOpen(null);
    void load(tab.status);
  }, [tab.status, load]);

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.page.nextCursor) return;
    const q = new URLSearchParams({ cursor: state.page.nextCursor });
    if (tab.status) q.set("status", tab.status);
    const r = await api<Page>(`/api/seller/invoices?${q}`);
    if (r.ok) setState({ kind: "ok", page: { ...r.data, invoices: [...state.page.invoices, ...r.data.invoices] } });
    else setToast({ text: "더 불러오지 못했습니다. 다시 눌러 주십시오", neg: true });
  };

  const track = async (id: string) => {
    if (open === id) {
      openId.current = null;
      return setOpen(null);
    }
    openId.current = id;
    setOpen(id);
    setDetail(null);
    const r = await api<{ invoice: Detail }>(`/api/seller/invoices/${id}`);
    if (openId.current !== id) return;
    if (r.ok) setDetail(r.data.invoice);
    else setToast({ text: "추적 내용을 불러오지 못했습니다", neg: true });
  };

  const page = state.kind === "ok" ? state.page : null;
  const items = page?.invoices ?? [];
  const delayed = items.filter((i) => i.pickupDelayed);
  const printHref = `/seller/shipping/tracking/print?${new URLSearchParams({ ...(picked.size > 0 ? { ids: [...picked].join(",") } : { scope: "unprinted" }), format, returnTo })}`;
  const detailHref = (id: string) => `/seller/shipping/tracking/${id}?${new URLSearchParams({ returnTo })}`;
  const allPicked = items.length > 0 && items.every((i) => picked.has(i.id));
  const count = (t: (typeof TABS)[number]) => (page ? (t.status ? (page.counts[t.status] ?? 0) : page.total) : null);

  return (
    <>
      <Topbar crumb="주문 › 배송 · 송장 › 송장 출력 · 추적" />
      <main className="main">
        <PageHead
          title="송장 출력 · 추적"
          actions={
            <>
              {canEdit && (
                <Link className="btn btn-out" href="/seller/shipping/invoices">송장 발급</Link>
              )}
              <Link className="btn btn-out" href="/seller/shipping">배송 목록</Link>
            </>
          }
        />
        <InvoiceSteps now={4} />
        <nav className="rtabs" aria-label="송장 상태">
          {TABS.map((t) => (
            <a
              key={t.key}
              href={`?tab=${t.key}`}
              className={tab.key === t.key ? "on" : ""}
              aria-current={tab.key === t.key ? "true" : undefined}
              onClick={(e) => {
                e.preventDefault();
                setU({ tab: t.key });
              }}
            >
              {t.label}
              {count(t) !== null ? ` ${count(t)}` : ""}
            </a>
          ))}
        </nav>

        {page?.mock && (
          <div className="msg msg-info" role="status">
            <span>배송 접수 업체가 정해지기 전이라 발급 · 추적은 모의 데이터입니다. 연동되면 실제 송장번호와 추적이 표시됩니다.</span>
          </div>
        )}
        {delayed.map((d) => (
          <div key={d.id} className="msg msg-neg" role="alert">
            <span>
              <b>{d.nickname ?? "주문"} · 출력 뒤 24시간이 지났는데 집하되지 않았습니다.</b> 택배사 집하 요청을 확인해 주십시오.
            </span>
            {canEdit && (
              <Link className="btn btn-sm btn-out" href={detailHref(d.id)}>집하 요청 상세</Link>
            )}
          </div>
        ))}

        <section className="au-list-section">
          <div className="toolbar" style={{ padding: 16 }}>
            <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              {canEdit && (
                <>
                  <select className="inp inp-sm" style={{ width: "auto" }} aria-label="출력 방식" value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
                    <option value="LABEL_100X150">라벨 프린터</option>
                    <option value="A4_2UP">A4 2매</option>
                  </select>
                  {picked.size > 0 || (page?.unprinted ?? 0) > 0 ? <Link className="btn btn-sm" href={printHref}>{picked.size > 0 ? `고른 송장 ${picked.size}개 출력` : `출력 안 한 송장 ${page?.unprinted ?? 0}개 출력`}</Link> : <button className="btn btn-sm" type="button" disabled>출력 안 한 송장 0개 출력</button>}
                </>
              )}
              <a className="btn btn-sm btn-out" href={`/api/seller/invoices/export${tab.status ? `?status=${tab.status}` : ""}`} download>
                엑셀 내려받기
              </a>
            </span>
          </div>

          {state.kind === "loading" && <div className="card"><LoadingRows rows={5} /></div>}
          {state.kind === "error" && (state.status === 403 ? <NoPermission need="주문·배송" /> : <div className="card"><ErrorState title="송장 목록을 불러오지 못했습니다" onRetry={() => void load(tab.status)} /></div>)}
          {state.kind === "ok" &&
            (items.length === 0 ? (
              <div className="st">
                <span className="t">{tab.status ? "이 상태의 송장이 없습니다" : "발급한 송장이 없습니다"}</span>
              </div>
            ) : (
              <ListTable>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>
                        <input className="cbx" type="checkbox" aria-label="모두 선택" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(items.filter((i) => i.trackingNumber).map((i) => i.id)))} />
                      </th>
                      <th>받는 분</th>
                      <th>택배사 · 송장번호</th>
                      <th style={{ width: 90 }}>상태</th>
                      <th>마지막 추적</th>
                      <th style={{ width: 70 }}>관리</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((i) => {
                      const tag = i.issuing ? { label: "발급 중", cls: "y" } : TAG[i.status];
                      return (
                        <Fragment key={i.id}>
                          <tr>
                            <td>
                              <input
                                className="cbx"
                                type="checkbox"
                                aria-label={`송장 ${i.trackingNumber ?? ""} 선택`}
                                disabled={!i.trackingNumber}
                                checked={picked.has(i.id)}
                                onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(i.id)) n.delete(i.id); else n.add(i.id); return n; })}
                              />
                            </td>
                            <td className="col-text">
                              {i.nickname ?? "—"}
                              {i.orderCount > 1 ? ` (${i.orderCount}건 합배송)` : ""}
                            </td>
                            <td>{i.trackingNumber ? `${i.courierName} ${num(i.trackingNumber)}` : i.courierName}</td>
                            <td>
                              <span className={`inv-tag ${tag.cls}`}>{tag.label}</span>
                            </td>
                            <td>
                              {i.lastEvent ? `${formatDateTime(i.lastEvent.at)} ${EVENT[i.lastEvent.kind] ?? i.lastEvent.kind}${i.lastEvent.note ? ` · ${i.lastEvent.note}` : ""}` : "—"}
                              {i.status === "ISSUED" ? " · 아직 출력 안 함" : i.status === "PRINTED" ? " · 집하 전" : ""}
                            </td>
                            <td>
                              <Link className="btn btn-sm btn-out" href={detailHref(i.id)}>송장 업무 상세</Link>
                              {i.trackingNumber && <button className="btn btn-sm btn-out" type="button" aria-expanded={open === i.id} onClick={() => void track(i.id)}>추적</button>}
                            </td>
                          </tr>
                          {open === i.id && (
                            <tr>
                              <td colSpan={6}>
                                {!detail ? (
                                  <LoadingRows rows={2} />
                                ) : (
                                  <table className="tbl">
                                    <thead>
                                      <tr>
                                        <th style={{ width: 140 }}>시각</th>
                                        <th>상태</th>
                                        <th style={{ width: 120 }}>처리</th>
                                        <th>비고</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {detail.events.map((e, n) => (
                                        <tr key={n}>
                                          <td>{formatDateTime(e.at)}</td>
                                          <td>{EVENT[e.kind] ?? e.kind}</td>
                                          <td>{e.source === "CARRIER" ? i.courierName : (SOURCE[e.source] ?? e.source)}</td>
                                          <td>{e.note ?? ""}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </ListTable>
            ))}
        </section>
        {page?.nextCursor && (
          <div style={{ textAlign: "center", marginTop: 12 }}>
            <button className="btn btn-out" type="button" onClick={() => void loadMore()}>
              더 보기
            </button>
          </div>
        )}
        <span className="t-c1 c-alt" style={{ display: "block", marginTop: 12 }}>
          출력하지 않은 송장은 집하되지 않습니다 · 발급 · 출력 · 집하 · 배송 완료를 따로 표시 · 배송 완료 7일 뒤 구매 확정 자동 전환
        </span>
        {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
      </main>
    </>
  );
}
