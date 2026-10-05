"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PageHead, useConfirm } from "../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";

// SA-003 시작하기 · SA-004 온보딩(파트너스 관리자). 가입 때 정해진 갈래(쇼핑몰 통합 / 오버레이 전용)의 단계를 체크리스트로 보이고, 나갔다 돌아와도 첫 미완료 단계에서 이어 하게 한다.
// 단계 완료는 서버가 기존 데이터에서 계산한다(상품·구독·공유 문구·주문 설정·오버레이 배치·외부 쇼핑몰 연동). 「오버레이 주소 복사」만 오버레이 화면에서 복사를 눌렀을 때 저장된다.
// 닫기·다시 열기는 대표자·쇼핑몰 설정 권한 직원만(그 외에는 버튼을 숨긴다). 갈래가 없으면(알 수 없는 플랜) 체크리스트를 보이지 않는다.
// API: GET /api/seller/onboarding → { track, trialEndsAt, steps:[{ key, done, href }], doneCount, total, currentStep, completed, dismissed }, POST { action: "dismiss" | "reopen" }
type Step = { key: string; done: boolean; href: string };
type Data = { track: "INTEGRATED" | "OVERLAY_ONLY" | null; planCode: string | null; trialEndsAt: string | null; steps: Step[]; doneCount: number; total: number; currentStep: string | null; completed: boolean; dismissed: boolean };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; data: Data };

const STEP: Record<string, { title: string; desc: string; go: string }> = {
  subscription: { title: "이용권 결제", desc: "이용권 요금을 결제하면 쇼핑몰과 방송 기능을 쓸 수 있습니다.", go: "구독 · 결제로" },
  shop_info: { title: "쇼핑몰 정보 입력", desc: "구매자에게 보이는 공유 문구를 입력합니다.", go: "쇼핑몰 정보로" },
  products: { title: "상품 등록", desc: "판매할 상품을 한 개 이상 등록합니다.", go: "상품 등록으로" },
  order_policy: { title: "주문 규칙", desc: "입금해야 하는 시간과 자동 취소 같은 주문 규칙을 저장합니다.", go: "주문 설정으로" },
  overlay: { title: "방송 화면 꾸미기", desc: "방송 화면에 보일 배치를 저장합니다.", go: "방송 화면 꾸미기로" },
  overlay_url: { title: "방송 화면 주소 복사", desc: "방송 화면 꾸미기에서 주소를 만들어 복사한 뒤, 방송 프로그램(OBS)의 「브라우저 소스」 칸에 붙여 넣습니다.", go: "방송 화면 꾸미기로" },
  external_shop: { title: "다른 쇼핑몰 이어 쓰기", desc: "운영 중인 쇼핑몰의 주소를 확인하고 이어 둡니다.", go: "다른 쇼핑몰 이어 쓰기로" },
};
const TRACK: Record<"INTEGRATED" | "OVERLAY_ONLY", string> = { INTEGRATED: "쇼핑몰까지 쓰기", OVERLAY_ONLY: "방송 화면만 쓰기" };

function trialLeft(iso: string | null): string | null {
  if (!iso) return null;
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  return days > 0 ? `체험 ${days}일 남음` : "체험 기간이 끝났습니다";
}

export default function OnboardingPage() {
  const { can } = useSeller();
  const canClose = can("SHOP_SETTINGS");
  const [state, setState] = useState<Load>({ kind: "loading" });
  const { confirm } = useConfirm();

  const load = useCallback(async () => {
    const r = await api<Data>("/api/seller/onboarding");
    setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error" });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: "dismiss" | "reopen") => {
    const dismiss = action === "dismiss";
    const ok = await confirm({
      title: dismiss ? "시작하기 안내를 숨기시겠습니까?" : "시작하기 안내를 다시 보이시겠습니까?",
      body: dismiss ? "홈에서 시작하기 안내가 사라집니다. 이 화면에서 다시 열 수 있습니다." : "홈에 시작하기 안내가 다시 나타납니다.",
      confirmLabel: dismiss ? "숨기기" : "다시 보이기",
      run: async () => {
        const r = await api("/api/seller/onboarding", { method: "POST", body: { action } });
        return r.ok ? undefined : (r.message ?? "안내를 바꾸지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오");
      },
    });
    if (ok) await load();
  };

  const d = state.kind === "ok" ? state.data : null;
  const current = d?.steps.find((s) => s.key === d.currentStep) ?? null;
  const pct = d && d.total > 0 ? Math.round((d.doneCount / d.total) * 100) : 0;

  return (
    <>
      <Topbar crumb="홈 › 시작하기" />
      <main className="main">
        <PageHead title="시작하기" />
        {state.kind === "loading" && (
          <div className="card">
            <LoadingRows rows={4} />
          </div>
        )}
        {state.kind === "error" && (
          <div className="card">
            <ErrorState title="시작하기를 불러오지 못했습니다" onRetry={() => void load()} />
          </div>
        )}
        {d && d.track === null && (
          <div className="card">
            <div className="st" style={{ boxShadow: "none" }}>
              <span className="t">표시할 시작 단계가 없습니다</span>
              <span className="s">계정에 맞는 시작 안내가 없습니다. 메뉴에서 필요한 화면을 열어 주십시오.</span>
            </div>
          </div>
        )}
        {d && d.track !== null && (
          <div className="col" style={{ gap: 16, maxWidth: 760 }}>
            <section className="card pad-l col" style={{ gap: 12 }} aria-labelledby="ob-progress">
              <div className="row between" style={{ gap: 12, flexWrap: "wrap" }}>
                <h2 className="t-hl1" id="ob-progress">
                  {TRACK[d.track]}
                  {trialLeft(d.trialEndsAt) ? <span className="t-l2 c-alt"> · {trialLeft(d.trialEndsAt)}</span> : null}
                </h2>
                <span className="t-l1 fw6 num" data-testid="ob-count">
                  {d.doneCount} / {d.total} 완료
                </span>
              </div>
              <div role="progressbar" aria-valuemin={0} aria-valuemax={d.total} aria-valuenow={d.doneCount} aria-label="시작하기 진행" style={{ height: 8, borderRadius: 4, background: "var(--wds-fill-normal)", overflow: "hidden" }}>
                <div style={{ width: `${pct}%`, height: "100%", background: "var(--wds-primary-normal, #2563eb)" }} />
              </div>
              {d.completed ? (
                <span className="t-l1" data-testid="ob-completed">모든 단계를 마쳤습니다. 이제 방송을 시작할 수 있습니다.</span>
              ) : (
                current && (
                  <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span className="t-l1">다음 단계: <b>{STEP[current.key]?.title ?? current.key}</b></span>
                    <Link className="btn btn-sm" href={current.href} data-testid="ob-continue">
                      이어서 하기
                    </Link>
                  </div>
                )
              )}
            </section>

            {d.dismissed ? (
              <div className="msg msg-info" role="status">
                <span>시작하기를 닫았습니다. 필요하면 다시 열 수 있습니다.</span>
                {canClose && (
                  <button className="btn btn-sm" type="button" onClick={() => void act("reopen")}>
                    다시 보이기
                  </button>
                )}
              </div>
            ) : (
              <section className="card" aria-label="시작 단계">
                <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {d.steps.map((s, i) => {
                    const info = STEP[s.key] ?? { title: "확인할 일", desc: "", go: "이동" };
                    const isCurrent = s.key === d.currentStep;
                    return (
                      <li key={s.key} data-testid="ob-step" data-key={s.key} data-done={s.done ? "true" : "false"} data-current={isCurrent ? "true" : "false"} className="row" style={{ gap: 14, padding: "16px 20px", alignItems: "center", borderTop: i === 0 ? "none" : "1px solid var(--wds-line-normal-alternative)", background: isCurrent ? "var(--wds-fill-alternative)" : undefined }}>
                        <span className={`bdg ${s.done ? "b-done" : isCurrent ? "b-info" : "b-gray nodot"}`} style={{ minWidth: 64, justifyContent: "center" }}>
                          {s.done ? "완료" : isCurrent ? "지금 할 차례" : "기다리는 중"}
                        </span>
                        <div className="col" style={{ gap: 2, flex: 1, minWidth: 0 }}>
                          <span className="t-l1 fw6">{i + 1}. {info.title}</span>
                          <span className="t-c1 c-alt">{info.desc}</span>
                        </div>
                        <Link className={`btn btn-sm${s.done ? " btn-out" : ""}`} href={s.href}>
                          {s.done ? "다시 보기" : info.go}
                        </Link>
                      </li>
                    );
                  })}
                </ol>
              </section>
            )}

            {!d.dismissed && canClose && (
              <div className="row">
                <button className="btn btn-sm btn-text" type="button" onClick={() => void act("dismiss")}>
                  안내 숨기기
                </button>
              </div>
            )}
          </div>
        )}
      </main>
    </>
  );
}
