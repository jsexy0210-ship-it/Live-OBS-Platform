"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FormRow, FormSection, PageHead } from "../../../../../../components/admin-ui";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import { won } from "../../../../../../components/seller/format";

// SA-080 알림 설정(주문자 알림). 지금은 「이번 달 제공량 사용 현황 · 발송·이용 충전금」 요약만(API: GET /api/seller/message-balance, 대표자 전용).
// 발송 채널(알림톡·문자)·이벤트별 문구·메일 종류별 켜기·끄기는 설정 API가 생기면 붙인다.

type Balance = {
  paidBalance: number;
  freeBalance: number;
  total: number;
  lowBalanceThreshold: number;
  lowBalance: boolean;
  chargingEnabled: boolean;
  mail: { month: string; quota: number; sent: number; chargedSent: number; pending: number; skippedBalance: number; skippedPlatformLimit: number; failed: number };
};

const MAILS = [
  ["주문 완료", "결제 확인 뒤 · 주문대기 순서 · 무통장이면 입금 계좌와 기한"],
  ["발송", "송장 등록 뒤 · 택배사 · 송장번호 · 배송 조회"],
  ["배송 완료", "배송 완료 뒤 · 다시보기 안내 · 적립금"],
  ["취소 · 환불", "취소 처리 뒤 · 환불 금액 · 수단 · 예정일"],
] as const;

export default function OrderNotificationsPage() {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; b: Balance }>({ kind: "loading" });
  const load = useCallback(async () => {
    const r = await api<Balance>("/api/seller/message-balance");
    setState(r.ok ? { kind: "ok", b: r.data } : { kind: "error", status: r.status });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind !== "ok") {
    return (
      <>
        <Topbar crumb="설정 › 알림 설정" />
        <main className="main">
          <PageHead description="주문·배송 안내의 발송 채널과 사용 현황을 확인합니다." title="알림 설정" />
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={4} />}
            {state.kind === "error" &&
              (state.status === 403 ? <NoPermission need="대표자" /> : state.status === 402 ? <Locked /> : <ErrorState title="알림 설정을 불러오지 못했습니다" onRetry={() => void load()} />)}
          </div>
        </main>
      </>
    );
  }

  const b = state.b;
  const exhausted = b.mail.quota > 0 && b.mail.sent >= b.mail.quota;

  return (
    <>
      <Topbar crumb="설정 › 알림 설정" />
      <main className="main">
        <PageHead description="주문·배송 안내의 발송 채널과 사용 현황을 확인합니다." title="알림 설정" />

        {b.mail.skippedBalance > 0 && (
          <div className="msg msg-neg" role="alert" data-testid="skipped-note" style={{ marginBottom: 16 }}>
            <span>
              <b>충전금이 모자라 알림 {b.mail.skippedBalance.toLocaleString("ko-KR")}건을 보내지 못했습니다.</b> 주문과 배송은 그대로 처리됐습니다. 충전하려면 「발송·이용 충전」으로 가십시오.
            </span>
          </div>
        )}
        {exhausted && (
          <div className="msg msg-info" role="note" data-testid="exhausted-note" style={{ marginBottom: 16 }}>
            <span>이번 달 무료 안내 메일을 다 써서 지금부터는 충전금에서 한 통씩 빠집니다. 남은 충전금 {won(b.total)}</span>
          </div>
        )}

        <FormSection title="발송 채널">
          <FormRow label="이메일" help="주문·배송 안내 메일은 법으로 정해진 안내라 받는 사람이 거부할 수 없습니다 · 보낸 기록은 주문 상세에 남습니다">
            <span>주문 완료 · 발송 · 배송 완료 · 취소 안내 메일 4종을 구매자 이메일로 보냅니다</span>
          </FormRow>
          <FormRow label="카카오 알림톡 · 문자" help="보내는 사람 등록과 알림별 문구 설정은 아직 쓸 수 없습니다">
            <span className="c-alt">아직 쓸 수 없습니다</span>
          </FormRow>
        </FormSection>
        <div style={{ marginTop: 16 }}>
          <div style={{ overflowX: "auto" }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>메일</th>
                  <th>보내는 때 · 내용</th>
                </tr>
              </thead>
              <tbody>
                {MAILS.map(([k, v]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td className="col-text">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ marginTop: 32 }}>
          <FormSection title="이번 달 무료 메일 사용 현황">
            <FormRow
              label="매달 무료로 보낼 수 있는 안내 메일"
              help="주문 완료 · 발송 · 배송 완료 · 취소 메일 4종 합계 · 매월 1일 0시에 다시 채워집니다 · 다 쓰면 한 통당 가격만큼 충전금에서 빠집니다"
            >
              <b className="num" data-testid="quota">
                {b.mail.sent.toLocaleString("ko-KR")} / {b.mail.quota.toLocaleString("ko-KR")}통
              </b>
              <span className="t-l2 c-alt">{exhausted ? "다 씀" : "여유"}</span>
            </FormRow>
            <FormRow label="발송·이용 충전금" help="무료 수를 넘은 안내 메일과 광고 메일 · 문자 · 알림톡은 충전금에서 한 건씩 빠집니다. 충전금이 모자라면 보내지 않고 「보내지 못함」으로 남습니다. 한 건 가격은 「발송·이용 충전」에서 확인합니다">
              <b className="num" data-testid="balance">
                {won(b.total)}
              </b>
              <Link className="btn btn-sm btn-out" href="/seller/settings/message-balance">
                발송·이용 충전
              </Link>
            </FormRow>
            <FormRow label="이번 달 빠진 금액" help="무료 수를 넘은 안내 메일 기준입니다 · 문자 · 알림톡 · 광고 메일은 사용 내역에서 봅니다">
              <span className="num" data-testid="charged">
                무료 수 초과 메일 {b.mail.chargedSent.toLocaleString("ko-KR")}통
              </span>
            </FormRow>
            <FormRow label="충전금 부족 알림" help="기준은 「발송·이용 충전」에서 바꿉니다">
              <span data-testid="threshold">{b.lowBalanceThreshold > 0 ? `충전금이 ${won(b.lowBalanceThreshold)} 아래로 내려가면 알립니다` : "알리지 않음"}</span>
            </FormRow>
          </FormSection>
        </div>
      </main>
    </>
  );
}
