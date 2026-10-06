"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FormFoot, FormRow, FormSection, PageHead, useConfirm } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";
import { won } from "../../../../../../components/seller/format";
import { formatDateTime } from "../../../../../../lib/client/format";
import "../rewards.css";

// SA-034 적립금 실제 지급 켜기(정본 SA-034 FINAL, 대표자만 바꾸고 조회는 회원·적립금 권한).
// API: GET·PUT /api/seller/reward-live-payout(+ /settle, /history). 기본은 꺼짐: 꺼져 있으면 적립은 「대기」로만 기록된다.
// 켜기 조건(적립 정책 설정 완료·최근 7일 지급 실패 0건·구독 이용 중)은 서버가 막지 않으므로 충족하지 않으면 버튼을 잠근다.
// 켜면 대기분을 일괄 지급한다(한 번에 회원 200명): 남은 건이 있으면 /settle을 이어서 부르며 「지급 중… 21 / 37」을 보인다.
type LivePayout = { enabled: boolean; changedAt: string | null; changedByName: string | null };
type Sum = { count: number; amount: number };
type Condition = { key: "policy" | "noRecentFailures" | "subscription"; met: boolean; failedCount: number | null };
type Settlement = { settled: number; settledAmount: number; revokedAmount: number; failed: number; remaining: number; skipped: "not_live" | null };
type Data = { livePayout: LivePayout; pending: Sum; recentFailed: Sum; conditions: Condition[]; canEnable: boolean };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; data: Data };
type HistoryRow = { id: string; at: string; enabled: boolean; actorName: string | null; settled: Sum | null };

const COND_LABEL: Record<Condition["key"], string> = { policy: "적립 정책 설정 완료", noRecentFailures: "최근 7일 지급 실패 0건", subscription: "구독 상태 이용 중" };
const n = (v: number) => v.toLocaleString("ko-KR");

export default function LivePayoutPage() {
  const { me } = useSeller();
  const [state, setState] = useState<Load>({ kind: "loading" });
  const { confirm } = useConfirm();
  const [failure, setFailure] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [history, setHistory] = useState<{ rows: HistoryRow[]; next: string | null } | "error" | null>(null);

  const loadHistory = useCallback(async (cursor?: string) => {
    const r = await api<{ history: HistoryRow[]; nextCursor: string | null }>(`/api/seller/reward-live-payout/history?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (!r.ok) return cursor ? undefined : setHistory("error");
    setHistory((prev) => ({ rows: cursor && prev && prev !== "error" ? [...prev.rows, ...r.data.history] : r.data.history, next: r.data.nextCursor }));
  }, []);
  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await api<Data>("/api/seller/reward-live-payout");
    setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error", status: r.status });
    if (r.ok) void loadHistory();
  }, [loadHistory]);
  useEffect(() => void load(), [load]);

  const data = state.kind === "ok" ? state.data : null;

  const change = async (enabled: boolean) => {
    if (!data) return;
    setFailure(null);
    let settlement: Settlement | null = null;
    let saved = false;
    const ok = await confirm({
      title: enabled ? "적립금을 실제로 지급하도록 켜시겠습니까?" : "적립금 실제 지급을 끄시겠습니까?",
      body: enabled
        ? `지급 대기 ${n(data.pending.count)}건 · ${won(data.pending.amount)}이 즉시 회원 잔액에 반영됩니다. 이 작업은 되돌릴 수 없고 로그 추적에 남습니다.`
        : "끄면 이후 생기는 적립은 다시 「대기」로 기록됩니다. 이미 지급한 적립금은 그대로입니다.",
      confirmLabel: enabled ? "실제 지급 켜기" : "실제 지급 끄기",
      danger: enabled,
      run: async () => {
        const r = await api<{ settlement: Settlement | null }>("/api/seller/reward-live-payout", { method: "PUT", body: enabled ? { enabled: true, confirm: true } : { enabled: false } });
        if (!r.ok) return failMessage(r, "admin", "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오");
        settlement = r.data.settlement;
        saved = true;
      },
    });
    if (!ok || !saved) return;
    // 켠 직후 남은 대기분을 이어서 지급한다(한 번에 200명). 중간에 실패해도 이미 켜진 상태는 그대로다
    const total = (s: Settlement) => s.settled + s.failed + s.remaining;
    let cur: Settlement | null = settlement;
    let guard = 0;
    while (enabled && cur && cur.remaining > 0 && guard++ < 200) {
      setProgress({ done: cur.settled + cur.failed, total: total(cur) });
      const r = await api<{ settlement: Settlement }>("/api/seller/reward-live-payout/settle", { method: "POST" });
      if (!r.ok) {
        setFailure("남은 대기분을 지급하지 못했습니다. 잠시 후 이 화면을 다시 열면 이어서 지급됩니다.");
        break;
      }
      cur = { ...r.data.settlement, settled: cur.settled + r.data.settlement.settled, failed: cur.failed + r.data.settlement.failed };
    }
    setProgress(null);
    const failed = cur?.failed ?? 0;
    setToast(enabled ? `실제 지급을 켰습니다${cur && cur.settled > 0 ? ` · ${n(cur.settled)}건 지급${failed > 0 ? ` · ${n(failed)}건 실패` : ""}` : ""}` : "실제 지급을 껐습니다");
    void load();
  };

  const failedCond = data?.conditions.find((c) => c.key === "noRecentFailures");
  const blockedLabel = failedCond && !failedCond.met && failedCond.failedCount ? `실패 ${n(failedCond.failedCount)}건 먼저 확인` : null;

  return (
    <>
      <Topbar crumb="고객 › 적립금 › 실제 지급 켜기" />
      <main className="main">
        <PageHead title="실제 지급 켜기" />
        {state.kind === "loading" && (
          <div className="card">
            <LoadingRows rows={3} />
          </div>
        )}
        {state.kind === "error" && (
          <div className="card">
            {state.status === 403 ? <NoPermission need="회원·적립금" /> : state.status === 402 ? <Locked /> : <ErrorState title="실제 지급 설정을 불러오지 못했습니다" onRetry={() => void load()} />}
          </div>
        )}
        {data && (
          <div className="rw-form">
            {failure && (
              <div className="msg msg-neg" role="alert" style={{ marginBottom: 16 }}>
                <span>{failure}</span>
              </div>
            )}
            {progress && (
              <div className="msg msg-info" role="status" data-testid="live-progress" style={{ marginBottom: 16 }}>
                <span>
                  지급 중… {n(progress.done)} / {n(progress.total)}
                </span>
              </div>
            )}
            {data.livePayout.enabled ? (
              <div className="msg msg-pos" role="note" data-testid="live-on" style={{ marginBottom: 16 }}>
                <span>
                  <b>실제 지급 켜짐</b>
                  {data.livePayout.changedAt ? ` · ${formatDateTime(data.livePayout.changedAt)}부터` : ""}. 끄면 그때부터 다시 「대기」로 기록합니다.
                </span>
              </div>
            ) : (
              <div className="msg msg-info" role="note" data-testid="live-status" style={{ marginBottom: 16 }}>
                <span>
                  <b>적립금 실제 지급 · 현재 꺼짐 (기본).</b> 꺼져 있으면 모든 적립은 「대기」로만 기록되고 회원 잔액에 반영되지 않습니다. 켜면 대기분이 일괄 지급되고 이후 정책대로 실제 지급됩니다.
                </span>
              </div>
            )}

            {!data.livePayout.enabled && (
              <>
                <FormSection title="켜기 전 확인">
                  <FormRow label="지급 대기">
                    <span data-testid="live-pending">
                      {n(data.pending.count)}건 · {won(data.pending.amount)}
                    </span>
                    <span className="help" style={{ display: "block" }}>
                      켜면 즉시 회원 잔액에 반영되고 구매자가 바로 사용할 수 있습니다
                    </span>
                  </FormRow>
                  <FormRow label="기록">
                    <span>이 작업은 로그 추적에 남고 플랫폼 운영팀에 표시됩니다</span>
                  </FormRow>
                </FormSection>

                <section className="au-fs">
                  <div className="au-fs-h">
                    <h2 className="au-fs-t">켜기 조건</h2>
                    <span className="t-l2 c-alt">화면 안내와 버튼 비활성 표시용입니다 · 서버가 켜기를 막지는 않습니다</span>
                  </div>
                  <div className="card sts-scroll">
                    <table className="tbl tbl-card" data-testid="live-conditions">
                      <thead>
                        <tr>
                          <th>조건</th>
                          <th>상태</th>
                          <th>비고</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.conditions.map((c) => (
                          <tr key={c.key}>
                            <td className="col-text" data-card="title">
                              {COND_LABEL[c.key]}
                            </td>
                            <td data-card="status">
                              <span className={`bdg ${c.met ? "b-done" : "b-fail"}`}>{c.met ? "충족" : "미충족"}</span>
                            </td>
                            <td className="col-text" data-card="wide">
                              {!c.met && c.key === "noRecentFailures" && c.failedCount ? (
                                <>
                                  실패 {n(c.failedCount)}건 · <Link href="/seller/rewards/ledger?status=FAILED&period=all">원장에서 재시도</Link>
                                </>
                              ) : !c.met && c.key === "policy" ? (
                                <Link href="/seller/rewards">적립 정책 설정</Link>
                              ) : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="au-fs">
                  <div className="au-fs-h">
                    <h2 className="au-fs-t">켜면 일어나는 일</h2>
                  </div>
                  <ol className="card col" style={{ gap: 6, margin: 0, padding: "16px 16px 16px 36px" }}>
                    <li>대기 {n(data.pending.count)}건이 「성공」으로 바뀌고 잔액에 더해집니다</li>
                    <li>이후 개봉 완료마다 정책대로 바로 지급됩니다</li>
                    <li>취소 · 환불하면 자동으로 회수됩니다 · 잔액이 모자라면 실패로 남습니다</li>
                    <li>쇼핑몰 주문서에 「적립금 사용」 영역이 보입니다</li>
                    <li>끄면 그때부터 다시 「대기」로 기록하고 이미 지급된 잔액은 그대로입니다</li>
                  </ol>
                </section>
              </>
            )}

            <section className="au-fs">
              <div className="au-fs-h">
                <h2 className="au-fs-t">전환 이력</h2>
                <span className="t-l2 c-alt">켬 · 끔 전환은 사유 없이 일시 · 처리자만 남습니다</span>
              </div>
              <div className="card sts-scroll">
                {history === null ? (
                  <LoadingRows rows={2} />
                ) : history === "error" ? (
                  <ErrorState title="전환 이력을 불러오지 못했습니다" onRetry={() => void loadHistory()} />
                ) : history.rows.length === 0 ? (
                  <div className="st" style={{ boxShadow: "none", minHeight: 80 }}>
                    <span className="t">전환 이력이 없습니다</span>
                  </div>
                ) : (
                  <table className="tbl tbl-card" data-testid="live-history">
                    <thead>
                      <tr>
                        <th>일시</th>
                        <th>전환</th>
                        <th>처리</th>
                        <th>비고</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.rows.map((h) => (
                        <tr key={h.id}>
                          <td className="num">{formatDateTime(h.at)}</td>
                          <td>
                            <span className={`bdg ${h.enabled ? "b-done" : "b-gray"} nodot`}>{h.enabled ? "켬" : "끔"}</span>
                          </td>
                          <td>{h.actorName ?? "-"}</td>
                          <td className="col-text" data-card="wide">
                            {h.settled ? `대기 ${n(h.settled.count)}건 ${n(h.settled.amount)}원 지급` : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              {history && history !== "error" && history.next && (
                <div className="row" style={{ justifyContent: "center", marginTop: 8 }}>
                  <button className="btn btn-out" type="button" onClick={() => void loadHistory(history.next!)}>
                    이력 더 보기
                  </button>
                </div>
              )}
            </section>

            <FormFoot>
              {me.isOwner ? (
                data.livePayout.enabled ? (
                  <button className="btn btn-out btn-lg" type="button" disabled={!!progress} onClick={() => void change(false)} data-testid="live-off">
                    실제 지급 끄기
                  </button>
                ) : (
                  <>
                    <button className="btn btn-lg" type="button" disabled={!data.canEnable || !!progress} onClick={() => void change(true)} data-testid="live-on-button">
                      실제 지급 켜기
                    </button>
                    {blockedLabel && (
                      <Link className="btn btn-lg btn-out" href="/seller/rewards/ledger?status=FAILED&period=all">
                        {blockedLabel}
                      </Link>
                    )}
                  </>
                )
              ) : (
                <span className="t-l2 c-alt">변경은 대표자만 할 수 있습니다 (읽기 전용)</span>
              )}
            </FormFoot>
          </div>
        )}
      </main>

      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
