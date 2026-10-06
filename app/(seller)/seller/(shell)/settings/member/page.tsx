"use client";

import { useCallback, useEffect, useState } from "react";
import { FormFoot, FormRow, FormSection, PageHead } from "../../../../../../components/admin-ui";
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
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
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

  const save = async () => {
    if (!saved) return;
    setSaving(true);
    setFailure(null);
    const r = await api<{ policy: Policy }>("/api/seller/member-policy", { method: "PUT", body: { rejoinRestrictionEnabled: enabled, rejoinRestrictionDays: days } });
    setSaving(false);
    if (!r.ok) return setFailure(failMessage(r, "admin", "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오"));
    apply(r.data.policy);
    setState({ kind: "ok", saved: r.data.policy });
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
              {failure && (
                <div className="msg msg-neg" role="alert" style={{ marginBottom: 16 }}>
                  <span>
                    <b>저장할 수 없습니다.</b> {failure}
                  </span>
                </div>
              )}
              <FormSection title="재가입 제한">
                <FormRow
                  label="탈퇴한 사람의 재가입 막기"
                  help={
                    <span id="rj-help">
                      {!available && !enabled
                        ? "회원이 동의를 철회할 수 있는 화면이 준비되면 켤 수 있습니다"
                        : enabled
                          ? `탈퇴한 날부터 ${label(days)} 동안 같은 사람이 다시 가입할 수 없습니다`
                          : "꺼 두면 탈퇴한 사람도 바로 다시 가입할 수 있습니다 · 기본 꺼짐"}
                    </span>
                  }
                >
                  <button
                    className={`sw${enabled ? " on" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-label="탈퇴한 사람의 재가입 막기"
                    aria-describedby="rj-help"
                    disabled={!available && !enabled}
                    onClick={() => setEnabled((v) => !v)}
                  />
                </FormRow>
                {enabled && (
                  <FormRow label="제한 기간">
                    <div className="seg" role="radiogroup" aria-label="제한 기간">
                      {choices.map((d) => (
                        <button key={d} type="button" role="radio" aria-checked={days === d} className={days === d ? "on" : ""} onClick={() => setDays(d)}>
                          {label(d)}
                        </button>
                      ))}
                    </div>
                  </FormRow>
                )}
              </FormSection>
              <p className="help" style={{ marginTop: 16 }}>
                켜면 가입할 때 「재가입 제한 정보 보관」 동의를 따로 받습니다. 이미 가입한 회원은 가입할 때 동의한 기간까지만 적용됩니다. 끄면 보관하던 탈퇴 회원 정보는 바로 삭제합니다.
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
