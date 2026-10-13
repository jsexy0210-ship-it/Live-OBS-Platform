"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorState, LoadingRows } from "../../../../components/seller/States";
import { FormRow, FormSection } from "../../../../components/admin-ui";
import type { getSellerRewards } from "../../../../lib/server/admin/sellerRewards";
import { adminApi } from "./api";
import { dayTime, won } from "./partners";

type Source = NonNullable<Awaited<ReturnType<typeof getSellerRewards>>>;
type Data = Omit<Source, "livePayout" | "history"> & {
  livePayout: Omit<Source["livePayout"], "changedAt"> & { changedAt: string | null };
  history: (Omit<Source["history"][number], "at"> & { at: string })[];
};
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; data: Data };
const rate = (value: number | null) => value === null ? "-" : `${value}%`;

// MA-012-7 FINAL: existing seller-scoped read-only API. No payout or policy mutation.
export function PartnerRewards({ sellerId }: { sellerId: string }) {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const request = useRef(0);
  const load = useCallback(async () => {
    const current = ++request.current;
    setState({ kind: "loading" });
    const response = await adminApi<Data>(`/api/admin/sellers/${encodeURIComponent(sellerId)}/rewards`);
    if (current !== request.current) return;
    setState(response.ok ? { kind: "ok", data: response.data } : { kind: "error" });
  }, [sellerId]);
  useEffect(() => { void load(); return () => { request.current++; }; }, [load]);
  if (state.kind === "loading") return <LoadingRows rows={4} />;
  if (state.kind === "error") return <ErrorState title="적립금 설정을 불러오지 못했습니다." onRetry={() => void load()} />;
  const { policy, limits, livePayout, totals, history, anomalies } = state.data;
  return (
    <div className="col" style={{ gap: 20 }} data-testid="partner-rewards">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))", gap: 20 }}>
        <section className="card pad col" style={{ gap: 16 }}>
          <FormSection title="파트너스 적립 정책">
            <table className="tbl" aria-label="회원 등급별 적립률">
              <thead><tr><th>회원 등급</th><th className="num">카드</th><th className="num">무통장</th><th className="num">회원</th></tr></thead>
              <tbody>{policy.grades.map((grade) => <tr key={grade.id}><td>{grade.name}</td><td className="num">{rate(grade.cardRate)}</td><td className="num">{rate(grade.bankTransferRate)}</td><td className="num">{grade.members.toLocaleString("ko-KR")}</td></tr>)}</tbody>
            </table>
            {!policy.saved && <p className="t-l2 c-alt">저장된 적립 정책이 없습니다.</p>}
            <FormRow label="적립금 지급 시점">{policy.earnTiming === "ON_PAYMENT" ? "결제 시" : policy.earnTiming === "ON_DELIVERY" ? "배송 완료 후" : "-"}</FormRow>
            <FormRow label="회수 모드">{policy.revokeMode === "AUTO" ? "자동" : policy.revokeMode === "MANUAL" ? "수동" : "-"}</FormRow>
            <FormRow label="유효 기간">{policy.expiryYears}년</FormRow>
            <FormRow label="최대 사용">{rate(policy.useMaxRatio)}</FormRow>
          </FormSection>
          <span className="t-c1 c-alt">기본 정책 상한: 적립률 {rate(limits.rateMax)} · {limits.withinLimits ? "준수 중" : "확인 필요"}</span>
        </section>
        <section className="card pad col" style={{ gap: 16 }}>
          <FormSection title="실지급 상태">
            <FormRow label="상태">{livePayout.enabled ? "실지급 켜짐" : "실지급 꺼짐"}</FormRow>
            <FormRow label="전환 시각">{dayTime(livePayout.changedAt)}{livePayout.changedByName ? ` · ${livePayout.changedByName}` : ""}</FormRow>
            <FormRow label="발행 잔액 총액">{won(totals.balance)}</FormRow>
            <FormRow label="이번 달 지급 / 사용">{won(totals.monthGranted)} / {won(totals.monthUsed)}</FormRow>
            <FormRow label="지급 대기">{totals.pending.count}건 · {won(totals.pending.amount)}</FormRow>
            <FormRow label="지급 실패">{totals.failed.count}건 · {won(totals.failed.amount)}</FormRow>
          </FormSection>
          <FormSection title="전환 이력">
            <table className="tbl" aria-label="적립금 전환 이력"><thead><tr><th>일시</th><th>내용</th></tr></thead><tbody>{history.map((item) => <tr key={item.id}><td>{dayTime(item.at)}</td><td>{item.enabled ? "켬" : "끔"}{item.actorName ? ` · ${item.actorName}` : ""}{item.settled ? ` · ${item.settled.count}건 ${won(item.settled.amount)} 지급` : ""}</td></tr>)}</tbody></table>
            {history.length === 0 && <p className="t-l2 c-alt">전환 이력이 없습니다.</p>}
          </FormSection>
        </section>
      </div>
      <section className="card pad">
        <FormSection title="이상 징후">
          <table className="tbl" aria-label="적립금 이상 징후"><thead><tr><th>항목</th><th className="num">값</th><th>판정</th></tr></thead><tbody>{[
            ["잔액 총액 / 월 거래액", rate(anomalies.balanceRatio.ratio), anomalies.balanceRatio.status],
            ["수동 지급", `${won(anomalies.manualGrant.amount)} · ${anomalies.manualGrant.count}건`, anomalies.manualGrant.status],
            ["특정 회원 집중", rate(anomalies.concentration.ratio), anomalies.concentration.status],
            ["지급 실패 반복", `${anomalies.failRepeat.count}건`, anomalies.failRepeat.status],
          ].map(([label, value, status]) => <tr key={label}><td>{label}</td><td className="num">{value}</td><td>{status === "OK" ? "정상" : "확인 필요"}</td></tr>)}</tbody></table>
        </FormSection>
      </section>
    </div>
  );
}
