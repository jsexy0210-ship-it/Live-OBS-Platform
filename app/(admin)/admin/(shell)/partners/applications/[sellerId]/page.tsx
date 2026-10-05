"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { adminCan } from "../../../../../../../lib/server/authz/permissions";
import { PageHead } from "../../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../../components/seller/States";
import { adminApi, failMessage } from "../../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../../_components/AdminShell";
import { SELLER_STATUS, day, dayTime, reasonLabel, text, type ReviewRow, type SellerDetail } from "../../../../_components/partners";
import { RejectApplicationDialog } from "../../../../_components/RejectApplicationDialog";
import { setFlash, takeFlash } from "../../../../_components/flash";
import { useSmartBack } from "../../../../../../../lib/client/navigation";

// MA-014 가입 신청 상세: 신청 내용(GET /api/admin/sellers/{id})과 확인 필요 항목(GET …/review)을 보고 승인·반려한다.
// 승인·반려는 최고관리자·운영만 보인다. 반려는 사유 필수(1~200자). 이미 처리됐으면(409) 최신 상태로 다시 읽는다.
// 대기 중인 신청 순서(서버가 주는 오래 기다린 순)로 [이전] N/M [다음]을 보이고, 승인·반려한 뒤에는 목록으로 돌아가지 않고 다음 건으로 넘어간다(없으면 목록).
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; seller: SellerDetail; reasons: string[]; queue: string[] };

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

export default function ApplicationDetailPage() {
  const back = useSmartBack("/admin/partners/applications");
  const router = useRouter();
  const { sellerId } = useParams<{ sellerId: string }>();
  const { me } = useAdmin();
  const canModerate = adminCan(me.role, "seller.moderate");
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [reject, setReject] = useState(false);
  const [approving, setApproving] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const [d, rv] = await Promise.all([
      adminApi<{ seller: SellerDetail }>(`/api/admin/sellers/${encodeURIComponent(sellerId)}`),
      adminApi<{ sellers: ReviewRow[] }>("/api/admin/sellers/review"),
    ]);
    if (!d.ok) return setState({ kind: "error", status: d.status });
    const reasons = rv.ok ? (rv.data.sellers.find((x) => x.id === sellerId)?.reviewReasons ?? []) : [];
    setState({ kind: "ok", seller: d.data.seller, reasons, queue: rv.ok ? rv.data.sellers.map((x) => x.id) : [] });
  }, [sellerId]);
  useEffect(() => void load(), [load]);
  // 이전 건에서 승인·반려하고 넘어왔다면 그 결과 안내를 이어서 보인다
  useEffect(() => {
    const m = takeFlash();
    if (m) setToast({ text: m });
  }, [sellerId]);

  const stale = () => {
    setReject(false);
    setToast({ text: "다른 곳에서 이미 처리됐습니다. 최신 상태를 불러옵니다.", neg: true });
    void load();
  };
  const queue = state.kind === "ok" ? state.queue : [];
  const pos = queue.indexOf(sellerId);
  const go = (id: string | undefined) => id && router.replace(`/admin/partners/applications/${id}`);
  // 처리한 건을 뺀 순서에서 같은 자리의 다음 건(마지막이었다면 앞 건), 없으면 목록
  const goNext = (message: string) => {
    setFlash(message);
    const rest = queue.filter((x) => x !== sellerId);
    const next = rest[pos] ?? rest[rest.length - 1];
    if (next) go(next);
    else router.replace("/admin/partners/applications");
  };
  const approve = async () => {
    if (approving) return;
    setApproving(true);
    const r = await adminApi(`/api/admin/sellers/${encodeURIComponent(sellerId)}/approve`, { method: "POST", json: {} });
    setApproving(false);
    if (r.ok) {
      return goNext("가입을 승인했습니다.");
    }
    if (r.status === 404 || r.status === 409) return stale();
    setToast({ text: failMessage(r, "승인하지 못했습니다. 잠시 후 다시 시도해 주십시오."), neg: true });
  };

  const s = state.kind === "ok" ? state.seller : null;
  const biz = s?.businessInfo ?? null;
  const pending = s?.status === "PENDING";

  return (
    <>
      <AdminTopbar crumb="파트너스 › 가입 신청 › 가입 신청 상세" />
      <main className="main">
        <PageHead
          title={s ? s.shopName : "가입 신청 상세"}
          actions={
            <>
              {s && canModerate && pending && (
                <>
                  <button className="btn btn-out" type="button" onClick={() => setReject(true)} disabled={approving}>
                    반려
                  </button>
                  <button className="btn" type="button" onClick={() => void approve()} disabled={approving}>
                    {approving ? "처리 중" : "승인"}
                  </button>
                </>
              )}
              {pos >= 0 && queue.length > 1 && (
                <span className="row" style={{ gap: 4, alignItems: "center" }} data-testid="application-nav">
                  <button className="btn btn-out" type="button" onClick={() => go(queue[pos - 1])} disabled={pos === 0}>
                    이전
                  </button>
                  <span className="t-l2 c-alt">
                    {pos + 1} / {queue.length}
                  </span>
                  <button className="btn btn-out" type="button" onClick={() => go(queue[pos + 1])} disabled={pos === queue.length - 1}>
                    다음
                  </button>
                </span>
              )}
              <button className="btn btn-out" type="button" onClick={back}>가입 신청 목록</button>
            </>
          }
        />
        {!s ? (
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={4} />}
            {state.kind === "error" &&
              (state.status === 404 ? (
                <div className="st">
                  <span className="t">가입 신청을 찾을 수 없습니다.</span>
                </div>
              ) : (
                <ErrorState title="가입 신청을 불러오지 못했습니다." onRetry={() => void load()} />
              ))}
          </div>
        ) : (
          <div className="col" style={{ gap: 20 }}>
            {!pending && (
              <div className="card pad" role="status" data-testid="application-processed">
                이미 처리된 신청입니다. 현재 상태는 「{SELLER_STATUS[s.status].label}」입니다.{" "}
                <Link className="fw6" href={`/admin/partners/${s.id}`}>
                  파트너스 상세 보기
                </Link>
              </div>
            )}
            {pending && (
              <Info
                title="확인할 것"
                id="application-reasons"
                rows={[
                  [
                    "자동으로 확인한 결과",
                    state.kind === "ok" && state.reasons.length > 0 ? (
                      <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                        {state.reasons.map((c) => (
                          <span key={c} className="bdg b-warn">
                            {reasonLabel(c)}
                          </span>
                        ))}
                      </span>
                    ) : (
                      "문제가 된 항목이 없습니다."
                    ),
                  ],
                ]}
              />
            )}
            <Info
              title="신청 내용"
              id="application-basic"
              rows={[
                ["쇼핑몰 주소", s.slug],
                ["상태", <span key="st" className={`bdg ${SELLER_STATUS[s.status].cls}`}>{SELLER_STATUS[s.status].label}</span>],
                ["요금제", s.plan?.name ?? "-"],
                ["신청일", dayTime(s.createdAt)],
                ...(s.status === "REJECTED" ? ([["반려 사유", text(s.rejectedReason)], ["반려일", day(s.rejectedAt)]] as [string, React.ReactNode][]) : []),
              ]}
            />
            <Info
              title="대표자"
              id="application-owner"
              rows={[
                ["이름", s.owner?.name ?? "-"],
                ["이메일", s.owner?.email ?? "-"],
              ]}
            />
            <Info
              title="사업자 정보"
              id="application-business"
              rows={[
                ["상호", text(biz?.companyName)],
                ["사업자등록번호", text(biz?.businessNumber)],
                ["대표자명", text(biz?.representativeName)],
                ["개업일", text(biz?.openedOn)],
                ["통신판매업 신고번호", text(biz?.mailOrderNumber)],
                ["국세청 확인", biz?.businessInfoValid === true ? "일치" : biz?.businessInfoValid === false ? "불일치" : "확인 못함"],
                ["통신판매업 조회", text(biz?.mailOrderStatus)],
                ["점검 시각", dayTime(typeof biz?.checkedAt === "string" ? biz.checkedAt : null)],
              ]}
            />
          </div>
        )}
      </main>
      {reject && s && (
        <RejectApplicationDialog
          id={s.id}
          shopName={s.shopName}
          onClose={() => setReject(false)}
          onDone={() => {
            setReject(false);
            goNext("가입을 반려했습니다.");
          }}
          onStale={stale}
        />
      )}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
