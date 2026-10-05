"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { adminCan } from "../../../../../../lib/server/authz/permissions";
import { PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { adminApi } from "../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../_components/AdminShell";
import { SELLER_STATUS, SUBSCRIPTION_STATUS, day, dayTime, text, won, type SellerDetail, type SellerStatus } from "../../../_components/partners";
import { MessageBalanceSection } from "../../../_components/MessageBalanceSection";
import { PARTNER_TABS, PartnerActivity, PartnerBroadcasts, PartnerNotes, PartnerPg, type PartnerTab } from "../../../_components/PartnerTabs";
import { ImpersonateDialog, type ImpersonationStart } from "../../../_components/ImpersonateDialog";
import { SuspendDialog } from "../../../_components/SuspendDialog";
import { useSmartBack, useUrlState } from "../../../../../../lib/client/navigation";

// MA-012 파트너스 상세(GET /api/admin/sellers/{id}, 모든 마스터 역할): 기본 정보·대표자·사업자·구독·최근 30일 주문.
// 이용 정지·해제(MA-015)는 최고관리자·운영만 버튼이 보인다. 대리 조회(MA-016, 읽기 전용 30분)는 최고관리자·운영·CS만, 운영·정지 상태 쇼핑몰에서만 시작한다. 활동 기록·메모 탭은 API가 생기면 붙인다.
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; seller: SellerDetail };
// 내가 열어 둔 대리 조회(GET /api/admin/impersonation)
type Impersonation = { sellerId: string; shopName: string; slug: string; reason: string; startedAt: string; expiresAt: string };

function Info({ title, id, rows }: { title: string; id: string; rows: [string, React.ReactNode][] }) {
  return (
    <section className="card pad-l col" style={{ gap: 14 }} aria-labelledby={id}>
      <h2 className="t-hl1" id={id}>
        {title}
      </h2>
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function PartnerDetail() {
  const back = useSmartBack("/admin/partners");
  const { sellerId } = useParams<{ sellerId: string }>();
  const { me } = useAdmin();
  const canModerate = adminCan(me.role, "seller.moderate");
  const canImpersonate = adminCan(me.role, "seller.impersonate");
  // 탭은 주소 쿼리(?tab=)가 기준이다(새로고침·Back에서 그대로). 없는 값은 「기본 정보」로 본다.
  const [q, setQ] = useUrlState({ tab: "info" });
  const tab: PartnerTab = PARTNER_TABS.some(([k]) => k === q.tab) ? (q.tab as PartnerTab) : "info";
  const [imp, setImp] = useState<Impersonation | null>(null);
  const [impDialog, setImpDialog] = useState(false);
  const [impBusy, setImpBusy] = useState(false);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [dialog, setDialog] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await adminApi<{ seller: SellerDetail }>(`/api/admin/sellers/${encodeURIComponent(sellerId)}`);
    setState(r.ok ? { kind: "ok", seller: r.data.seller } : { kind: "error", status: r.status });
  }, [sellerId]);
  useEffect(() => void load(), [load]);
  const loadImp = useCallback(async () => {
    if (!canImpersonate) return;
    const r = await adminApi<{ active: Impersonation | null }>("/api/admin/impersonation");
    if (r.ok) setImp(r.data.active);
  }, [canImpersonate]);
  useEffect(() => void loadImp(), [loadImp]);
  const endImp = async () => {
    if (impBusy) return;
    setImpBusy(true);
    const r = await adminApi<{ ok: true }>("/api/admin/impersonation", { method: "DELETE" });
    setImpBusy(false);
    if (r.ok) {
      setImp(null);
      return setToast({ text: "대신 보기를 끝냈습니다." });
    }
    setToast({ text: r.message ?? "끝내지 못했습니다. 잠시 후 다시 시도해 주십시오.", neg: true });
  };
  const impStarted = (r: ImpersonationStart) => {
    setImpDialog(false);
    setToast(r.opened ? { text: "대신 보기를 시작했습니다. 새 창에서 파트너스 화면을 읽기 전용으로 봅니다." } : { text: "대신 보기를 시작했습니다. 새 창이 막혀 열지 못했습니다. 「파트너스 화면 열기」를 눌러 주십시오.", neg: true });
    void loadImp();
  };

  const s = state.kind === "ok" ? state.seller : null;
  const done = (status: SellerStatus) => {
    setDialog(false);
    setToast({ text: status === "SUSPENDED" ? "이용을 정지했습니다." : "정지를 해제했습니다." });
    void load();
  };
  const biz = s?.businessInfo ?? null;

  return (
    <>
      <AdminTopbar crumb="파트너스 › 파트너스 목록 › 파트너스 상세" />
      <main className="main">
        <PageHead
          title={s ? s.shopName : "파트너스 상세"}
          actions={
            <>
              {s && canModerate && (s.status === "ACTIVE" || s.status === "SUSPENDED") && (
                <button className="btn btn-out" type="button" onClick={() => setDialog(true)}>
                  {s.status === "ACTIVE" ? "이용 정지" : "정지 해제"}
                </button>
              )}
              {s && canImpersonate && (s.status === "ACTIVE" || s.status === "SUSPENDED") && (
                <button className="btn btn-out" type="button" onClick={() => setImpDialog(true)}>
                  이 파트너스 화면 대신 보기
                </button>
              )}
              {s && (
                <Link className="btn btn-out" href={`/admin/billing/invoices?sellerId=${s.id}`}>
                  청구·결제 내역
                </Link>
              )}
              <button className="btn btn-out" type="button" onClick={back}>파트너스 목록</button>
            </>
          }
        />

        {!s ? (
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={4} />}
            {state.kind === "error" &&
              (state.status === 404 ? (
                <div className="st">
                  <span className="t">파트너스를 찾을 수 없습니다.</span>
                </div>
              ) : (
                <ErrorState title="파트너스 정보를 불러오지 못했습니다." onRetry={() => void load()} />
              ))}
          </div>
        ) : (
          <div className="col" style={{ gap: 20 }}>
            {imp && (
              <div className="card pad row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }} role="status" data-testid="impersonation-active">
                <b>{imp.sellerId === s.id ? "이 파트너스 화면을 대신 보는 중입니다." : `${imp.shopName}을(를) 대리 조회 중입니다.`}</b>
                <span className="t-l2 c-alt">{dayTime(imp.expiresAt)}까지 · 사유: {imp.reason}</span>
                <button className="btn btn-sm btn-out" type="button" onClick={() => window.open("/seller", "_blank")}>
                  파트너스 화면 열기
                </button>
                <button className="btn btn-sm" type="button" onClick={() => void endImp()} disabled={impBusy}>
                  {impBusy ? "끝내는 중" : "대신 보기 끝내기"}
                </button>
              </div>
            )}
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }} role="group" aria-label="파트너스 정보 탭">
              {PARTNER_TABS.map(([k, label]) => (
                <button key={k} type="button" className={`btn btn-sm ${tab === k ? "" : "btn-out"}`} aria-pressed={tab === k} onClick={() => setQ({ tab: k })}>
                  {label}
                </button>
              ))}
            </div>
            {tab === "broadcasts" && <PartnerBroadcasts sellerId={s.id} />}
            {tab === "notes" && <PartnerNotes sellerId={s.id} />}
            {tab === "pg" && <PartnerPg sellerId={s.id} slug={s.slug} />}
            {tab === "activity" && <PartnerActivity sellerId={s.id} />}
            {tab === "info" && (
              <>
              <div className="stat-row" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                {[
                  ["최근 30일 주문", `${s.orders30d.created.toLocaleString("ko-KR")}건`, "partner-orders"],
                  ["최근 30일 결제", `${s.orders30d.paid.toLocaleString("ko-KR")}건`, "partner-paid"],
                  ["최근 30일 결제 금액", won(s.orders30d.paidAmount), "partner-amount"],
                  ["마지막 주문", dayTime(s.orders30d.lastOrderAt), "partner-last"],
                ].map(([label, value, id]) => (
                  <div key={id} className="card pad col" style={{ gap: 4 }}>
                    <span className="t-l2 c-alt">{label}</span>
                    <span className="t-h2" data-testid={id}>
                      {value}
                    </span>
                  </div>
                ))}
              </div>
              <Info
                title="기본 정보"
                id="partner-basic"
                rows={[
                  ["쇼핑몰 주소", s.slug],
                  ["상태", <span key="st" className={`bdg ${SELLER_STATUS[s.status].cls}`}>{SELLER_STATUS[s.status].label}</span>],
                  ...(s.status === "SUSPENDED" ? ([["정지 사유", text(s.suspendedReason)]] as [string, React.ReactNode][]) : []),
                  ...(s.status === "REJECTED" ? ([["반려 사유", text(s.rejectedReason)], ["반려일", day(s.rejectedAt)]] as [string, React.ReactNode][]) : []),
                  ["요금제", s.plan?.name ?? "-"],
                  ["가입일", day(s.createdAt)],
                  ["승인일", day(s.approvedAt)],
                  ["체험 종료", day(s.trialEndsAt)],
                  ["서비스 종료일", day(s.serviceEndedAt)],
                ]}
              />
              <Info
                title="대표자"
                id="partner-owner"
                rows={[
                  ["이름", s.owner?.name ?? "-"],
                  ["이메일", s.owner?.email ?? "-"],
                  ["계정 상태", ({ ACTIVE: "이용 중", SUSPENDED: "정지" } as Record<string, string>)[s.owner?.status ?? ""] ?? s.owner?.status ?? "-"],
                  ["최근 로그인", dayTime(s.owner?.lastLoginAt ?? null)],
                ]}
              />
              <Info
                title="사업자 정보"
                id="partner-business"
                rows={[
                  ["상호", text(biz?.companyName)],
                  ["사업자등록번호", text(biz?.businessNumber)],
                  ["대표자명", text(biz?.representativeName)],
                  ["개업일", text(biz?.openedOn)],
                  ["통신판매업 신고번호", text(biz?.mailOrderNumber)],
                ]}
              />
              <Info
                title="구독"
                id="partner-subscription"
                rows={
                  s.subscription
                    ? [
                        ["상태", <span key="sub" className={`bdg ${SUBSCRIPTION_STATUS[s.subscription.status].cls}`}>{SUBSCRIPTION_STATUS[s.subscription.status].label}</span>],
                        ["결제 카드", text(s.subscription.cardLabel)],
                        ["현재 기간", `${day(s.subscription.currentPeriodStart)} ~ ${day(s.subscription.currentPeriodEnd)}`],
                        ["다음 결제", dayTime(s.subscription.nextChargeAt)],
                        ["이용 기간이 끝나면 해지", s.subscription.cancelAtPeriodEnd ? "예" : "아니요"],
                        ["이용 중인 요금제", s.subscription.planName],
                        ["바뀔 요금제", s.subscription.pendingPlanName ?? "-"],
                        ["결제 못 한 뒤 기다려 주는 날짜", dayTime(s.subscription.graceUntil)],
                        ["결제를 다시 시도한 횟수", `${s.subscription.retryCount}회`],
                      ]
                    : [["상태", "구독 없음"]]
                }
              />
              <MessageBalanceSection sellerId={s.id} />
              </>
            )}
          </div>
        )}
      </main>
      {dialog && s && (
        <SuspendDialog
          seller={s}
          onClose={() => setDialog(false)}
          onDone={done}
          onStale={() => {
            setDialog(false);
            setToast({ text: "다른 곳에서 이미 처리됐습니다. 최신 상태를 불러옵니다.", neg: true });
            void load();
          }}
        />
      )}
      {impDialog && s && <ImpersonateDialog seller={s} onClose={() => setImpDialog(false)} onDone={impStarted} />}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}

export default function PartnerDetailPage() {
  return (
    <Suspense fallback={null}>
      <PartnerDetail />
    </Suspense>
  );
}
