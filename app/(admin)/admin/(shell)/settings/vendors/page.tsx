"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead, ListTable, ListHead } from "../../../../../../components/admin-ui";
import { Modal } from "../../../../../../components/admin-ui/Modal";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { adminCan } from "../../../../../../lib/server/authz/permissions";
import { adminApi, failMessage } from "../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../_components/AdminShell";
import { criterionLabel, FEATURE_LABEL, VENDOR_CATEGORIES, VENDOR_CATEGORY_LABEL, type Vendor, type VendorBoard, type VendorCategory } from "../../../_components/vendors";
import { useUrlState } from "../../../../../../lib/client/navigation";

// MA-087 외부 서비스 연동(GET /api/admin/service-vendors: 모든 마스터 역할 조회, 변경은 최고관리자·운영 vendor.manage).
// 분야 탭 → 업체 카드(로고·추천·사용 중·기능·참고 요금·ONQ 점수) → 상세 비교표. 선택·추천 변경·가중치 편집·업체 등록·수정·로고는 변경 권한자에게만 보인다.
// 점수는 평가 항목을 모두 채웠을 때만 계산되고, 아니면 「평가 중 n/m」로 보인다. 업체는 지우지 않고 사용 안 함으로 둔다.
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; boards: Record<VendorCategory, VendorBoard> };
type Dialog =
  | { kind: "select"; vendor: Vendor }
  | { kind: "recommend"; vendor: Vendor }
  | { kind: "weights" }
  | { kind: "form"; vendor: Vendor | null };

const sum = (w: Record<string, number>) => Object.values(w).reduce((a, b) => a + b, 0);

function Logo({ v, size = 40 }: { v: Vendor; size?: number }) {
  return v.logoUrl ? (
    <img src={v.logoUrl} alt={`${v.name} 로고`} style={{ height: size, maxWidth: 120, objectFit: "contain" }} />
  ) : (
    <span aria-hidden className="bdg b-gray" style={{ width: size, height: size, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>
      {v.name.slice(0, 1)}
    </span>
  );
}

export default function VendorsPage() {
  const { me } = useAdmin();
  const canEdit = adminCan(me.role, "vendor.manage");
  const [url, setUrl] = useUrlState({ cat: "PG" });
  const cat: VendorCategory = (VENDOR_CATEGORIES as string[]).includes(url.cat) ? (url.cat as VendorCategory) : "PG";
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [compare, setCompare] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const logoFor = useRef<string | null>(null);

  const load = useCallback(async (quiet: boolean) => {
    if (!quiet) setState({ kind: "loading" });
    const r = await adminApi<{ categories: VendorBoard[] }>("/api/admin/service-vendors");
    if (!r.ok) {
      if (!quiet) setState({ kind: "error" });
      return;
    }
    setState({ kind: "ok", boards: Object.fromEntries(r.data.categories.map((b) => [b.category, b])) as Record<VendorCategory, VendorBoard> });
  }, []);
  useEffect(() => void load(false), [load]);

  const board = state.kind === "ok" ? state.boards[cat] : null;
  const vendors = board?.vendors ?? [];
  const shown = vendors.filter((v) => v.active || canEdit);

  // 변경 요청 공통: 성공하면 조용히 다시 불러와 카드만 바뀐다
  const run = async (path: string, init: Parameters<typeof adminApi>[1], done: string, close = true): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const r = await adminApi(path, init);
    setBusy(false);
    if (!r.ok) {
      setError(failMessage(r));
      return false;
    }
    if (close) setDialog(null);
    setToast({ text: done });
    await load(true);
    return true;
  };
  const putCategory = (json: unknown, done: string) => run(`/api/admin/service-vendor-categories/${cat}`, { method: "PUT", json }, done);

  const pickLogo = async (file: File | undefined) => {
    const id = logoFor.current;
    if (!file || !id) return;
    setError(null);
    setBusy(true);
    const r = await adminApi(`/api/admin/service-vendors/${id}/logo`, { method: "PUT", file });
    setBusy(false);
    if (!r.ok) return setToast({ text: failMessage(r), neg: true });
    setToast({ text: "로고를 올렸습니다." });
    await load(true);
  };
  const removeLogo = async (v: Vendor) => {
    setBusy(true);
    const r = await adminApi(`/api/admin/service-vendors/${v.id}/logo`, { method: "DELETE" });
    setBusy(false);
    if (!r.ok) return setToast({ text: failMessage(r), neg: true });
    setToast({ text: "로고를 삭제했습니다." });
    await load(true);
  };

  const open = (d: Dialog) => {
    setError(null);
    setDialog(d);
  };

  return (
    <>
      <AdminTopbar crumb="설정 › 외부 서비스 연동" />
      <main className="main">
        <PageHead description="외부 서비스 업체의 요금·기능과 비교 점수 기준을 관리합니다."
          title="외부 서비스 연동"
          actions={
            canEdit && board ? (
              <>
                <button className="btn btn-out btn-level-secondary" type="button" onClick={() => open({ kind: "weights" })}>
                  점수 비중 바꾸기
                </button>
                <button className="btn btn-level-primary" type="button" onClick={() => open({ kind: "form", vendor: null })}>
                  업체 등록
                </button>
              </>
            ) : undefined
          }
        />
        <div className="col" style={{ gap: 20 }}>
          <p className="c-alt t-l2">업체 선택은 마스터 관리자가 하고, 파트너스 화면에는 업체 이름 없이 기능만 보입니다. 수수료·요금은 공개 기준 참고값이며 실제 계약 조건은 계약 때 확인합니다.</p>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }} role="group" aria-label="분야">
            {VENDOR_CATEGORIES.map((c) => (
              <button key={c} type="button" className={`btn btn-sm ${cat === c ? "" : "btn-out"}`} aria-pressed={cat === c} onClick={() => setUrl({ cat: c })}>
                {VENDOR_CATEGORY_LABEL[c]}
              </button>
            ))}
          </div>
          {state.kind === "loading" && <div className="card"><LoadingRows rows={4} /></div>}
          {state.kind === "error" && (
            <div className="card">
              <ErrorState title="불러오지 못했습니다." onRetry={() => void load(false)} />
            </div>
          )}
          {board && shown.length === 0 && (
            <div className="card st">
              <span className="t">등록된 업체가 없습니다.{canEdit ? " 업체를 등록하면 카드로 비교할 수 있습니다." : ""}</span>
              {canEdit && (
                <button className="btn" type="button" onClick={() => open({ kind: "form", vendor: null })}>
                  업체 등록
                </button>
              )}
            </div>
          )}
          {board && shown.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
              {shown.map((v) => (
                <div key={v.id} className="card pad col" style={{ gap: 12, opacity: v.active ? 1 : 0.6 }} data-testid="vendor-card">
                  <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <Logo v={v} />
                    <span className="row" style={{ gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
                      {v.recommended && <span className="bdg b-info">추천</span>}
                      {v.selected && <span className="bdg b-done">사용 중</span>}
                      {!v.active && <span className="bdg b-gray">사용 안 함</span>}
                    </span>
                  </div>
                  <b>{v.name}</b>
                  <div className="col" style={{ gap: 4 }}>
                    {board.featureKeys.map((k) => (
                      <div key={k} className="row" style={{ justifyContent: "space-between" }}>
                        <span className="c-alt">{FEATURE_LABEL[k] ?? "이름 없는 항목"}</span>
                        <span>{v.features.includes(k) ? "지원" : "—"}</span>
                      </div>
                    ))}
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <span className="c-alt">참고 요금</span>
                      <span>{v.referenceFee ?? "확정 전"}</span>
                    </div>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <span className="c-alt">종합 점수</span>
                      <b>{v.score === null ? `평가 중 ${v.ratedCount}/${board.criteria.length}` : `${v.score}점`}</b>
                    </div>
                  </div>
                  {v.memo && <p className="c-alt t-l2">{v.memo}</p>}
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    <button className="btn btn-sm btn-out" type="button" aria-pressed={compare === v.id} onClick={() => setCompare(compare ? null : v.id)}>
                      상세 비교
                    </button>
                    {canEdit && (
                      <>
                        <button className="btn btn-sm" type="button" disabled={v.selected || !v.active || busy} onClick={() => open({ kind: "select", vendor: v })}>
                          {v.selected ? "사용 중" : "사용 업체로 선택"}
                        </button>
                        {!v.recommended && v.active && (
                          <button className="btn btn-sm btn-out" type="button" disabled={busy} onClick={() => open({ kind: "recommend", vendor: v })}>
                            추천으로 지정
                          </button>
                        )}
                        <button className="btn btn-sm btn-out" type="button" onClick={() => open({ kind: "form", vendor: v })}>
                          수정
                        </button>
                        <button
                          className="btn btn-sm btn-out"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            logoFor.current = v.id;
                            fileRef.current?.click();
                          }}
                        >
                          {v.logoUrl ? "로고 바꾸기" : "로고 올리기"}
                        </button>
                        {v.logoUrl && (
                          <button className="btn btn-sm btn-out" type="button" disabled={busy} onClick={() => void removeLogo(v)}>
                            로고 삭제
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {canEdit && <p className="c-alt t-l2">로고 파일: PNG, 용량 256KB 이하, 가로·세로 16~600 사이. 업체가 공식으로 배포한 로고만 올려 주십시오. 로고가 없으면 업체 이름 첫 글자가 보입니다.</p>}
          {board && shown.length > 0 && compare && (
            <>
              <ListHead total={shown.length} loaded />
              <ListTable>
              <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                <thead>
                  <tr>
                    <th>평가 항목(비중)</th>
                    {shown.map((v) => (
                      <th key={v.id}>{v.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {board.criteria.map((c) => (
                    <tr key={c.key}>
                      <td>
                        {criterionLabel(cat, c.key)} ({c.weight})
                      </td>
                      {shown.map((v) => (
                        <td key={v.id}>{v.ratings[c.key] === undefined ? "—" : `${v.ratings[c.key]}/10`}</td>
                      ))}
                    </tr>
                  ))}
                  <tr>
                    <td>
                      <b>종합 점수</b>
                    </td>
                    {shown.map((v) => (
                      <td key={v.id}>
                        <b>{v.score === null ? "평가 중" : v.score}</b>
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </ListTable>
            </>
          )}
        </div>
        <input ref={fileRef} type="file" accept=".png,image/png" hidden onChange={(e) => { void pickLogo(e.target.files?.[0]); e.target.value = ""; }} aria-label="로고 파일" />
      </main>

      {dialog?.kind === "select" && (
        <ConfirmDialog
          id="vendor-select"
          title={`${VENDOR_CATEGORY_LABEL[cat]} 업체를 ${dialog.vendor.name}(으)로 바꾸시겠습니까?`}
          body="선택해도 업체 계약과 유료 연동은 대표님 승인 뒤에 시작합니다. 파트너스 화면에는 업체 이름 없이 기능만 보입니다. 결제는 ONQ가 계약한 결제대행사 한 곳으로 받습니다."
          action="사용 업체로 선택"
          busy={busy}
          error={error}
          onClose={() => setDialog(null)}
          onOk={() => void putCategory({ selectedVendorId: dialog.vendor.id }, `${dialog.vendor.name}을(를) 선택했습니다.`)}
        />
      )}
      {dialog?.kind === "recommend" && (
        <ConfirmDialog
          id="vendor-recommend"
          title={`추천 업체를 ${dialog.vendor.name}(으)로 바꾸시겠습니까?`}
          body="「추천」 배지만 옮깁니다. 점수와 사용 중인 업체는 그대로이며, 변경은 로그 추적에 남습니다."
          action="추천 변경"
          busy={busy}
          error={error}
          onClose={() => setDialog(null)}
          onOk={() => void putCategory({ recommendedVendorId: dialog.vendor.id }, `추천 업체를 ${dialog.vendor.name}(으)로 바꿨습니다.`)}
        />
      )}
      {dialog?.kind === "weights" && board && (
        <WeightsDialog
          board={board}
          busy={busy}
          error={error}
          onClose={() => setDialog(null)}
          onSave={(weights) => void putCategory({ weights }, "가중치를 저장했습니다. 점수를 다시 계산했습니다.")}
        />
      )}
      {dialog?.kind === "form" && board && (
        <VendorFormDialog
          key={dialog.vendor?.id ?? "new"}
          board={board}
          vendor={dialog.vendor}
          busy={busy}
          error={error}
          onClose={() => setDialog(null)}
          onSave={(body) =>
            void (dialog.vendor
              ? run(`/api/admin/service-vendors/${dialog.vendor.id}`, { method: "PATCH", json: body }, "업체를 수정했습니다.")
              : run("/api/admin/service-vendors", { method: "POST", json: { category: cat, ...body } }, "업체를 등록했습니다."))
          }
        />
      )}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}

function ConfirmDialog(p: { id: string; title: string; body: string; action: string; busy: boolean; error: string | null; onClose: () => void; onOk: () => void }) {
  return (
    <Modal labelId={p.id} busy={p.busy} onClose={p.onClose}>
      {(requestClose) => (
        <div className="col" style={{ gap: 16 }}>
          <div className="modal-h">
            <h2 className="modal-t" id={p.id}>
              {p.title}
            </h2>
          </div>
          <p>{p.body}</p>
          {p.error && (
            <span className="err" role="alert">
              {p.error}
            </span>
          )}
          <div className="modal-f">
            <button className="btn btn-out" type="button" onClick={requestClose} disabled={p.busy}>
              취소
            </button>
            <button className="btn" type="button" onClick={p.onOk} disabled={p.busy}>
              {p.busy ? "처리 중" : p.action}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function WeightsDialog(p: { board: VendorBoard; busy: boolean; error: string | null; onClose: () => void; onSave: (w: Record<string, number>) => void }) {
  const cat = p.board.category;
  const [w, setW] = useState<Record<string, string>>(() => Object.fromEntries(p.board.criteria.map((c) => [c.key, String(c.weight)])));
  const nums = Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v === "" ? NaN : Number(v)]));
  const valid = Object.values(nums).every((n) => Number.isInteger(n) && n >= 0 && n <= 100);
  const total = valid ? sum(nums) : null;
  const dirty = p.board.criteria.some((c) => w[c.key] !== String(c.weight));
  return (
    <Modal labelId="vendor-weights" busy={p.busy} dirty={dirty} onClose={p.onClose}>
      {(requestClose) => (
        <div className="col" style={{ gap: 16 }}>
          <div className="modal-h">
            <h2 className="modal-t" id="vendor-weights">
              점수 비중 바꾸기 · {VENDOR_CATEGORY_LABEL[cat]}
            </h2>
          </div>
          {p.board.criteria.map((c) => (
            <div key={c.key} className="field">
              <label htmlFor={`w-${c.key}`}>{criterionLabel(cat, c.key)}</label>
              <span className="row" style={{ gap: 6, alignItems: "center" }}>
                <input id={`w-${c.key}`} className="inp" inputMode="numeric" value={w[c.key]} onChange={(e) => setW({ ...w, [c.key]: e.target.value.replace(/\D/g, "").slice(0, 3) })} style={{ width: 80 }} />점
              </span>
            </div>
          ))}
          <b data-testid="weights-total">합계 {total ?? "—"} / 100</b>
          {total !== null && total !== 100 && (
            <span className="err" role="alert">
              가중치 합계가 {total}입니다. 100이 되도록 맞춘 뒤 저장해 주십시오.
            </span>
          )}
          {p.error && (
            <span className="err" role="alert">
              {p.error}
            </span>
          )}
          <div className="modal-f">
            <button className="btn btn-out" type="button" onClick={requestClose} disabled={p.busy}>
              취소
            </button>
            <button className="btn" type="button" disabled={p.busy || total !== 100} onClick={() => p.onSave(nums)}>
              {p.busy ? "저장 중" : "저장"}
            </button>
          </div>
          <span className="c-alt t-l2">합계가 100일 때만 저장할 수 있습니다. 저장하면 모든 업체 점수를 다시 계산합니다.</span>
        </div>
      )}
    </Modal>
  );
}

function VendorFormDialog(p: { board: VendorBoard; vendor: Vendor | null; busy: boolean; error: string | null; onClose: () => void; onSave: (body: Record<string, unknown>) => void }) {
  const cat = p.board.category;
  const v = p.vendor;
  const [name, setName] = useState(v?.name ?? "");
  const [fee, setFee] = useState(v?.referenceFee ?? "");
  const [memo, setMemo] = useState(v?.memo ?? "");
  const [features, setFeatures] = useState<string[]>(v?.features ?? []);
  const [ratings, setRatings] = useState<Record<string, string>>(() => Object.fromEntries(p.board.criteria.map((c) => [c.key, v?.ratings[c.key] === undefined ? "" : String(v.ratings[c.key])])));
  const [active, setActive] = useState(v?.active ?? true);
  const snap = (n: string, f: string, m: string, ft: string[], r: Record<string, string>, a: boolean) => JSON.stringify([n, f, m, [...ft].sort(), r, a]);
  const [first] = useState(() => snap(name, fee, memo, features, ratings, active));
  const dirty = snap(name, fee, memo, features, ratings, active) !== first;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const r: Record<string, number | null> = {};
    for (const c of p.board.criteria) {
      const val = ratings[c.key];
      if (val !== "") r[c.key] = Number(val);
      else if (v && v.ratings[c.key] !== undefined) r[c.key] = null;
    }
    const body: Record<string, unknown> = { name, features, referenceFee: fee.trim() === "" ? null : fee, memo: memo.trim() === "" ? null : memo, ratings: r };
    if (v) body.active = active;
    p.onSave(body);
  };
  return (
    <Modal labelId="vendor-form" busy={p.busy} dirty={dirty} onClose={p.onClose}>
      {(requestClose) => (
        <form className="col" style={{ gap: 14 }} onSubmit={submit} noValidate>
          <div className="modal-h">
            <h2 className="modal-t" id="vendor-form">
              {v ? "업체 수정" : "업체 등록"} · {VENDOR_CATEGORY_LABEL[cat]}
            </h2>
          </div>
          <div className="field">
            <label htmlFor="vf-name">업체 이름</label>
            <input id="vf-name" className="inp" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="vf-fee">참고 요금 (공개 기준)</label>
            <input id="vf-fee" className="inp" maxLength={200} value={fee} onChange={(e) => setFee(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="vf-memo">메모</label>
            <textarea id="vf-memo" className="inp" rows={3} maxLength={500} value={memo} onChange={(e) => setMemo(e.target.value)} />
          </div>
          <fieldset className="col" style={{ gap: 6, border: 0, padding: 0 }}>
            <legend>지원 기능</legend>
            {p.board.featureKeys.map((k) => (
              <label key={k} className="row" style={{ gap: 8, alignItems: "center" }}>
                <input type="checkbox" checked={features.includes(k)} onChange={(e) => setFeatures(e.target.checked ? [...features, k] : features.filter((x) => x !== k))} />
                {FEATURE_LABEL[k] ?? "이름 없는 항목"}
              </label>
            ))}
          </fieldset>
          <fieldset className="col" style={{ gap: 6, border: 0, padding: 0 }}>
            <legend>평가 (0~10점, 모두 채우면 점수가 계산됩니다)</legend>
            {p.board.criteria.map((c) => (
              <div key={c.key} className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <label htmlFor={`vr-${c.key}`}>{criterionLabel(cat, c.key)}</label>
                <select id={`vr-${c.key}`} className="inp" style={{ width: 90 }} value={ratings[c.key]} onChange={(e) => setRatings({ ...ratings, [c.key]: e.target.value })}>
                  <option value="">미평가</option>
                  {Array.from({ length: 11 }, (_, i) => (
                    <option key={i} value={i}>
                      {i}점
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </fieldset>
          {v && (
            <label className="row" style={{ gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
              사용 (끄면 카드가 흐리게 보이고 선택할 수 없습니다)
            </label>
          )}
          {p.error && (
            <span className="err" role="alert">
              {p.error}
            </span>
          )}
          <div className="modal-f">
            <button className="btn btn-out" type="button" onClick={requestClose} disabled={p.busy}>
              취소
            </button>
            <button className="btn" type="submit" disabled={p.busy || name.trim() === ""}>
              {p.busy ? "저장 중" : "저장"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
