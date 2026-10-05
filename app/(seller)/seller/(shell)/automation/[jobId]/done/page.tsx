"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PageHead } from "../../../../../../../components/admin-ui";
import { Topbar } from "../../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows } from "../../../../../../../components/seller/States";
import { api } from "../../../../../../../components/seller/api";
import { stamp, type Job } from "../../../../../../../components/seller/automation/common";
import { FREE_RECONNECT_DAYS } from "../../../../../../../lib/server/automation/config";

// SA-153 자동 연결 완료. API: GET /api/automation/jobs/{id}. 작동 확인(verifiedAt)이 있는 완료 작업만 보여 준다. 아니면 진행 화면으로 보낸다.
// 보드에 있고 서버에 없는 것(연결된 웹훅 목록, 무료 재설치 기한, 다시 검증, 재설치 결제 진입)은 넣지 않았다. 재설치는 서버 API(/api/automation/reconnect)가 있으나
// 쇼핑몰·PC 식별값을 파트너스 응답으로 내보내지 않아 이 화면에서는 아직 열지 않는다.
export default function AutomationDonePage() {
  const { jobId } = useParams<{ jobId: string }>();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error" } | { kind: "ok"; job: Job }>({ kind: "loading" });
  const load = useCallback(async () => {
    const r = await api<Job>(`/api/automation/jobs/${jobId}`);
    setState(r.ok ? { kind: "ok", job: r.data } : { kind: "error" });
  }, [jobId]);
  useEffect(() => {
    void load();
  }, [load]);

  const crumb = "방송 › 연동 › 자동 연결 › 자동 연결 완료";
  if (state.kind !== "ok") {
    return (
      <>
        <Topbar crumb={crumb} />
        <main className="main">
          <PageHead title="자동 연결 완료" />
          <div className="card">{state.kind === "loading" ? <LoadingRows rows={3} /> : <ErrorState title="자동 연결 정보를 불러오지 못했습니다" onRetry={() => void load()} />}</div>
        </main>
      </>
    );
  }
  const j = state.job;
  const done = j.status === "SUCCEEDED" && !!j.verifiedAt;
  return (
    <>
      <Topbar crumb={crumb} />
      <main className="main">
        <PageHead title="자동 연결 완료" actions={<Link className="btn" href="/seller/broadcast">방송 대시보드로</Link>} />
        {!done ? (
          <div className="msg msg-cau" role="status" data-testid="done-not-yet">
            <span><b>아직 완료되지 않았습니다.</b> <Link href={`/seller/automation/${j.id}`}>진행 확인</Link></span>
          </div>
        ) : (
          <div className="col" style={{ gap: 16 }}>
            <div className="msg msg-pos" role="status" data-testid="done-ok">
              <span><b>설정 완료 · 화면에 나오는 것까지 확인했습니다</b> · {stamp(j.finishedAt ?? j.createdAt)} 완료 · 테스트 주문이 방송 화면에 나온 것을 확인했습니다</span>
            </div>
            <section className="card pad col" style={{ gap: 6 }}>
              <b>끝난 뒤 확인할 것</b>
              <span className="t-l2 c-alt">방송 프로그램(OBS)에서 「ONQ 주문대기」가 켜져 있는지 확인해 주십시오. 쇼핑몰에서 앱 허용을 바꾸면 연결이 끊길 수 있습니다. 방송 화면의 색과 위치는 「방송 화면 꾸미기」에서 바꿉니다</span>
              <span className="t-l2 c-alt">완료 뒤 {FREE_RECONNECT_DAYS}일 동안 같은 쇼핑몰 · 같은 PC는 무료로 재설치해 드립니다</span>
            </section>
            <div className="row" style={{ gap: 8 }}>
              <Link className="btn btn-out" href="/seller/overlay">방송 화면 꾸미기</Link>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
