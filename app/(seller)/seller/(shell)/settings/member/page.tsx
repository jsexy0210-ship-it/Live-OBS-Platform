"use client";

import { useCallback, useEffect, useState } from "react";
import { FormFoot, FormRow, FormSection, PageHead, useConfirm } from "../../../../../../components/admin-ui";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";
import { useUnsavedGuard } from "../../../../../../lib/client/navigation";

// SA-068 회원 정책: 재가입 제한(기본 꺼짐). 켜면 탈퇴한 사람이 정한 기간 동안 다시 가입할 수 없다(대표님 결정 2026-10-03).
// 서버는 1~365일을 받고, 화면은 디자인대로 30·90·180·365일 중에서 고른다. API: GET·PUT /api/seller/member-policy(회원·적립금 권한).

type Policy = { rejoinRestrictionEnabled: boolean; rejoinRestrictionDays: number };
const CHOICES = [30, 90, 180, 365] as const;
const label = (d: number) => (d === 365 ? "1년" : `${d}일`);

export default function MemberSettingsPage() {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; saved: Policy }>({ kind: "loading" });
  // 동의 철회 기능이 준비되기 전에는 켤 수 없다(서버가 알려 줌). 이미 켜진 쇼핑몰은 끄기만 된다.
  const [available, setAvailable] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [days, setDays] = useState(30);
  const { confirm } = useConfirm();
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const apply = (p: Policy) => {
    setEnabled(p.rejoinRestrictionEnabled);
    setDays(p.rejoinRestrictionDays);
  };

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await api<{ policy: Policy; restrictionAvailable?: boolean }>("/api/seller/member-policy");
    if (!r.ok) return setState({ kind: "error", status: r.status });
    setAvailable(r.data.restrictionAvailable !== false);
    apply(r.data.policy);
    setState({ kind: "ok", saved: r.data.policy });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saved = state.kind === "ok" ? state.saved : null;
  const dirty = !!saved && (saved.rejoinRestrictionEnabled !== enabled || saved.rejoinRestrictionDays !== days);
  useUnsavedGuard(dirty); // 링크·브라우저 Back·새로고침에 같은 확인(docs/IA.md Back 규칙 7항)

  // 저장 전에 확인 창을 거친다. 끄고 저장하면 보관하던 탈퇴 회원 기록이 바로 지워지므로 그 경우만 위험 색·되돌릴 수 없음 안내
  const save = async () => {
    if (!saved) return;
    const turningOff = saved.rejoinRestrictionEnabled && !enabled;
    let next: Policy | undefined;
    const ok = await confirm({
      title: turningOff ? "탈퇴한 사람 다시 가입 막기를 끄시겠습니까?" : "회원 정책을 저장하시겠습니까?",
      body: turningOff
        ? "보관하던 탈퇴 회원 기록이 바로 지워지며 되돌릴 수 없습니다."
        : enabled
          ? `탈퇴한 사람은 ${label(days)} 동안 다시 가입할 수 없습니다. 저장한 뒤 가입·탈퇴하는 회원부터 적용됩니다.`
          : "바꾼 내용은 저장한 뒤 가입·탈퇴하는 회원부터 적용됩니다.",
      confirmLabel: turningOff ? "끄기" : "저장",
      danger: turningOff,
      run: async () => {
        setSaving(true);
        const r = await api<{ policy: Policy }>("/api/seller/member-policy", { method: "PUT", body: { rejoinRestrictionEnabled: enabled, rejoinRestrictionDays: days } });
        setSaving(false);
        if (!r.ok) return failMessage(r, "admin", "저장하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오");
        next = r.data.policy;
      },
    });
    if (!ok || !next) return;
    apply(next);
    setState({ kind: "ok", saved: next });
    setToast("회원 정책을 저장했습니다");
  };

  // 저장된 기간이 선택지에 없으면(API로 다른 값을 넣은 경우) 그 값도 보여 준다
  const choices = CHOICES.includes(days as (typeof CHOICES)[number]) ? [...CHOICES] : [...CHOICES, days].sort((a, b) => a - b);

  return (
    <>
      <Topbar crumb="설정 › 쇼핑몰 설정 › 회원 정책" />
      <main className="main">
        <PageHead title="회원 정책" />

        {state.kind !== "ok" ? (
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={3} />}
            {state.kind === "error" &&
              (state.status === 403 ? (
                <NoPermission need="회원·적립금" />
              ) : state.status === 402 ? (
                <Locked />
              ) : (
                <ErrorState title="회원 정책을 불러오지 못했습니다" onRetry={() => void load()} />
              ))}
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {/* 저장하는 동안은 칸을 잠근다: 보낸 값과 다른 수정이 응답으로 덮이지 않게 */}
            <fieldset className="settings-fields" disabled={saving}>
              <FormSection title="재가입 제한">
                <FormRow
                  label="탈퇴한 사람 다시 가입 막기"
                  help={
                    <span id="rj-help">
                      {!available && !enabled
                        ? "회원이 보관 동의를 취소할 수 있는 화면이 준비되면 켤 수 있습니다"
                        : "켜면 정한 기간 동안 같은 사람(본인인증 기준)이 다시 가입할 수 없습니다 · 가입 화면에는 「지금은 다시 가입할 수 없어요」"}
                    </span>
                  }
                >
                  <div className="row" style={{ gap: 16 }} role="radiogroup" aria-label="탈퇴한 사람 다시 가입 막기" aria-describedby="rj-help">
                    <label className="chk">
                      <input type="radio" name="rj" checked={!enabled} onChange={() => setEnabled(false)} />
                      끔 (기본)
                    </label>
                    <label className="chk">
                      <input type="radio" name="rj" checked={enabled} disabled={!available && !enabled} onChange={() => setEnabled(true)} />켬
                    </label>
                  </div>
                </FormRow>
                <FormRow label="제한 기간" htmlFor="rj-days" help="기간이 지나면 다시 가입 가능">
                  <select id="rj-days" className="inp" style={{ width: 120 }} value={days} disabled={!enabled} onChange={(e) => setDays(Number(e.target.value))}>
                    {choices.map((d) => (
                      <option key={d} value={d}>
                        {label(d)}
                      </option>
                    ))}
                  </select>
                </FormRow>
                <FormRow label="보관 동의">
                  <span className="t-l2">켜면 회원가입 동의 항목에 「재가입 제한 정보 보관」 줄이 추가됩니다 · 개인정보처리방침 2-(3) 항목 자동 표시</span>
                </FormRow>
              </FormSection>

              <div style={{ marginTop: 32 }}>
                <FormSection title="탈퇴 회원 처리">
                  <FormRow label="탈퇴 즉시" help="결제를 마쳤는데 배송이 끝나지 않은 주문이 있으면 탈퇴가 보류됩니다 · 배송이 끝난 뒤 다시 신청">
                    <span className="t-l2">로그인 차단 · 적립금 · 쿠폰 소멸 · 결제 대기 주문은 취소</span>
                  </FormRow>
                  <FormRow label="기록 보관">
                    <span className="t-l2">주문 · 결제 기록은 전자상거래법 기간(5년) 보관 · 조회만 가능</span>
                  </FormRow>
                </FormSection>
              </div>

              <div style={{ marginTop: 32 }}>
                <FormSection title="구매자에게 보이는 안내">
                  <tr>
                    <td colSpan={2} style={{ padding: 0 }}>
                      <div className="card pad col" style={{ gap: 4, maxWidth: 420 }}>
                        <span className="t-l1 fw6">지금은 다시 가입할 수 없어요</span>
                        <span className="t-c1 c-alt">탈퇴한 날부터 {days}일이 지나면 다시 가입할 수 있어요</span>
                      </div>
                    </td>
                  </tr>
                </FormSection>
              </div>
              <p className="help" style={{ marginTop: 16 }}>
                이 기능을 켜면 가입할 때 「탈퇴 기록 보관」에 동의를 따로 받습니다. 이미 가입한 회원은 가입할 때 동의한 기간까지만 막습니다. 이 기능을 끄면 보관하던 탈퇴 회원 기록이 바로 지워집니다.
              </p>
            </fieldset>
            <FormFoot>
              <button className="btn btn-lg" type="submit" disabled={saving || !dirty}>
                {saving ? "저장 중" : "저장"}
              </button>
            </FormFoot>
          </form>
        )}
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
