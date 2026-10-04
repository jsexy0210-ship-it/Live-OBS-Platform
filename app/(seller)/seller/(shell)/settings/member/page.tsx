"use client";

import { useCallback, useEffect, useState } from "react";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { SettingsTabs } from "../../../../../../components/seller/SettingsTabs";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";

// SA-043 회원 정책: 재가입 제한(기본 꺼짐). 켜면 탈퇴한 사람이 정한 기간 동안 다시 가입할 수 없다(대표님 결정 2026-10-03).
// 서버는 1~365일을 받고, 화면은 디자인대로 30·90·180·365일 중에서 고른다. API: GET·PUT /api/seller/member-policy(회원·적립금 권한).

type Policy = { rejoinRestrictionEnabled: boolean; rejoinRestrictionDays: number };
const CHOICES = [30, 90, 180, 365] as const;
const label = (d: number) => (d === 365 ? "1년" : `${d}일`);
const SET_ROW = { padding: "12px 0", gap: 12, boxShadow: "inset 0 -1px 0 var(--wds-line-normal-alternative)" };

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
      <Topbar crumb="설정 › 쇼핑몰 설정 › 회원 정책">
        {saved && (
          <button className="btn btn-sm" type="button" onClick={() => void save()} disabled={saving || !dirty}>
            {saving ? "저장 중" : "저장"}
          </button>
        )}
      </Topbar>
      <main className="main">
        <SettingsTabs />
        <div className="ph">
          <div className="col" style={{ gap: 6 }}>
            <h1 className="t-t3">회원 정책</h1>
            <span className="t-l2 c-alt">탈퇴한 사람의 재가입 기준을 정합니다. 저장하면 바로 적용됩니다.</span>
          </div>
        </div>

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
          <div className="form-grid">
            {/* 저장하는 동안은 칸을 잠근다: 보낸 값과 다른 수정이 응답으로 덮이지 않게 */}
            <fieldset className="col settings-fields" style={{ gap: 20 }} disabled={saving}>
              {failure && (
                <div className="msg msg-neg" role="alert">
                  <span>
                    <b>저장할 수 없습니다.</b> {failure}
                  </span>
                </div>
              )}
              <section className="card pad col" style={{ gap: 10 }}>
                <h2 className="t-hl2">재가입 제한</h2>
                <div className="row between" style={SET_ROW}>
                  <span className="col" style={{ gap: 2 }}>
                    <span className="t-l1 fw6" id="rj-label">
                      탈퇴한 사람의 재가입 막기
                    </span>
                    <span className="t-c1 c-alt" id="rj-help">
                      {!available && !enabled
                        ? "회원이 동의를 철회할 수 있는 화면이 준비되면 켤 수 있습니다"
                        : enabled
                          ? `탈퇴한 날부터 ${label(days)} 동안 같은 사람이 다시 가입할 수 없습니다`
                          : "꺼 두면 탈퇴한 사람도 바로 다시 가입할 수 있습니다 · 기본 꺼짐"}
                    </span>
                  </span>
                  <button
                    className={`sw${enabled ? " on" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-labelledby="rj-label"
                    aria-describedby="rj-help"
                    disabled={!available && !enabled}
                    onClick={() => setEnabled((v) => !v)}
                  />
                </div>
                {enabled && (
                  <div className="col" style={{ gap: 8 }}>
                    <span className="t-l2 fw6" id="rj-days-label">
                      제한 기간
                    </span>
                    <div className="seg" role="radiogroup" aria-labelledby="rj-days-label" style={{ alignSelf: "flex-start" }}>
                      {choices.map((d) => (
                        <button key={d} type="button" role="radio" aria-checked={days === d} className={days === d ? "on" : ""} onClick={() => setDays(d)}>
                          {label(d)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            </fieldset>
            <aside className="col aside-sticky" style={{ gap: 16 }}>
              <div className="card pad col" style={{ gap: 8 }}>
                <span className="t-hl2">참고</span>
                <span className="t-c1 c-alt" style={{ lineHeight: 1.6 }}>
                  켜면 가입할 때 「재가입 제한 정보 보관」 동의를 따로 받습니다. 이미 가입한 회원은 가입할 때 동의한 기간까지만 적용됩니다. 끄면 보관하던 탈퇴 회원 정보는 바로 삭제합니다.
                </span>
              </div>
              <button className="btn btn-lg btn-block" type="button" onClick={() => void save()} disabled={saving || !dirty}>
                {saving ? "저장 중" : "저장"}
              </button>
            </aside>
          </div>
        )}
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
