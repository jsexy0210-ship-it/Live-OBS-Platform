"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PageHead } from "../../../../../../components/admin-ui";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import { won } from "../../../../../../components/seller/format";
import { MemberMemo } from "../../../../../../components/seller/members/MemberMemo";
import { MemberOrders } from "../../../../../../components/seller/members/MemberOrders";
import { MemberRewards } from "../../../../../../components/seller/members/MemberRewards";
import { MemberGradeAdjust } from "../../../../../../components/seller/members/MemberGradeAdjust";
import { MemberRestriction } from "../../../../../../components/seller/members/MemberRestriction";
import { MEMBER_STATUS, memberDay, phoneText, type MemberDetail } from "../../../../../../components/seller/members/types";

// SA-042 회원 상세: 등급·상태·주문 수·누적 결제·적립금 잔액 + 등급 직접 조정 + 구매 제한(현황·직접 걸기·풀기) + 회원 메모 + 주문 목록 + 적립금 내역.
// GET /api/seller/members/{id}, 회원·적립금 권한. 주문 목록은 주문·배송 권한이 없으면 안내만 보인다.
export default function MemberDetailPage() {
  const { memberId } = useParams<{ memberId: string }>();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; member: MemberDetail }>({ kind: "loading" });
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setState({ kind: "loading" });
      const r = await api<{ member: MemberDetail }>(`/api/seller/members/${encodeURIComponent(memberId)}`);
      setState(r.ok ? { kind: "ok", member: r.data.member } : { kind: "error", status: r.status });
    },
    [memberId],
  );
  useEffect(() => void load(), [load]);

  const m = state.kind === "ok" ? state.member : null;

  return (
    <>
      <Topbar crumb="판매 › 회원 › 회원 상세" />
      <main className="main">
        <PageHead
          title={m ? (m.broadcastNickname ?? "닉네임 없음") : "회원 상세"}
        />

        {!m ? (
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={4} />}
            {state.kind === "error" &&
              (state.status === 403 ? (
                <NoPermission need="회원·적립금" />
              ) : state.status === 404 ? (
                <div className="st">
                  <span className="t">회원을 찾을 수 없습니다</span>
                  <span className="s">탈퇴했거나 다른 쇼핑몰 회원일 수 있습니다</span>
                </div>
              ) : (
                <ErrorState title="회원 정보를 불러오지 못했습니다" onRetry={() => void load()} />
              ))}
          </div>
        ) : (
          <div className="col" style={{ gap: 20 }}>
            <div className="stat-row" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              {[
                ["주문", `${m.orderCount.toLocaleString("ko-KR")}건`, "member-orders"],
                ["누적 결제", won(m.totalPaid), "member-paid"],
                ["적립금 잔액", won(m.rewardBalance), "member-reward"],
              ].map(([label, value, id]) => (
                <div key={id} className="card pad col" style={{ gap: 4 }}>
                  <span className="t-l2 c-alt">{label}</span>
                  <span className="t-h2" data-testid={id}>
                    {value}
                  </span>
                </div>
              ))}
            </div>
            <section className="card pad-l col" style={{ gap: 14 }} aria-labelledby="member-info">
              <h2 className="t-hl1" id="member-info">
                회원 정보
              </h2>
              <dl className="kv">
                {m.name !== undefined && (
                  <>
                    <dt>이름</dt>
                    <dd>{m.name}</dd>
                  </>
                )}
                {m.phone !== undefined && (
                  <>
                    <dt>휴대폰</dt>
                    <dd>{phoneText(m.phone)}</dd>
                  </>
                )}
                <dt>등급</dt>
                <dd>{m.grade?.displayName ?? "-"}</dd>
                <dt>상태</dt>
                <dd>
                  <span className={`bdg ${MEMBER_STATUS[m.status].cls}`}>{MEMBER_STATUS[m.status].label}</span>
                </dd>
                <dt>혜택 · 소식 수신</dt>
                <dd>{m.marketingConsent ? "동의" : "동의 안 함"}</dd>
                <dt>가입일</dt>
                <dd>{memberDay(m.createdAt)}</dd>
                <dt>최근 로그인</dt>
                <dd>{memberDay(m.lastLoginAt)}</dd>
              </dl>
              {m.name === undefined && <span className="t-c1 c-alt">이름 · 휴대폰은 개인정보 열람 권한이 있어야 볼 수 있습니다.</span>}
            </section>
            <MemberGradeAdjust
              memberId={m.id}
              currentGradeId={m.grade?.id ?? null}
              active={m.status === "ACTIVE"}
              onDone={async (text) => {
                setToast(text);
                await load(true);
              }}
            />
            <MemberRestriction memberId={m.id} onChanged={(text) => setToast(text)} />
            <MemberMemo memberId={m.id} onSaved={(text) => setToast(text)} />
            <MemberOrders memberId={m.id} />
            <MemberRewards memberId={m.id} />
          </div>
        )}
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
