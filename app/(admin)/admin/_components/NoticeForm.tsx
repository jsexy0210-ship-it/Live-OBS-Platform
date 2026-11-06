"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { textLength } from "../../../../lib/server/text/clean";
import { FormFoot, FormRow, FormSection } from "../../../../components/admin-ui";
import { adminApi, failMessage } from "./api";
import { NOTICE_AUDIENCE, NOTICE_BODY_MAX, NOTICE_CATEGORY, NOTICE_TITLE_MAX, NOTICE_TARGET_MAX, type Notice, type NoticeAudience, type NoticeCategory, type NoticeTarget, type NoticeTargetMode } from "./notices";

// MA-054 공지 작성·수정 폼. 게시(publish: true)와 임시 저장을 나눠 보낸다. 수정은 expectedVersion을 같이 보내고, 다른 곳에서 먼저 고쳤으면(409) 알린다.
// 서버가 받는 값만 둔다: 분류·제목·본문·대상·중요 고정. 예약·이메일·알림톡·읽음 확인은 서버 지원 뒤에 붙인다.
export function NoticeForm({ notice, initialTargets, onSaved, onStale }: { notice?: Notice; initialTargets?: NoticeTarget[]; onSaved: (n: Notice, published: boolean) => void; onStale: () => void }) {
  const [category, setCategory] = useState<NoticeCategory>(notice?.category ?? "GENERAL");
  const [title, setTitle] = useState(notice?.title ?? "");
  const [body, setBody] = useState(notice?.body ?? "");
  const [audience, setAudience] = useState<NoticeAudience>(notice?.audience ?? "PARTNERS");
  const [targetMode, setTargetMode] = useState<NoticeTargetMode>(notice?.targetMode ?? (notice?.targetSellerIds?.length || initialTargets?.length ? "SPECIFIC" : "ALL"));
  const [selected, setSelected] = useState<NoticeTarget[]>(initialTargets ?? (notice?.targetSellerIds ?? []).map((id) => notice?.targetSellers?.find((seller) => seller.id === id) ?? { id, shopName: id, slug: "" }));
  const [targetQuery, setTargetQuery] = useState("");
  const [searchedQuery, setSearchedQuery] = useState("");
  const [targetResults, setTargetResults] = useState<NoticeTarget[]>([]);
  const [targetNext, setTargetNext] = useState<string | null>(null);
  const [targetLoading, setTargetLoading] = useState(false);
  const [targetSearched, setTargetSearched] = useState(false);
  const [targetError, setTargetError] = useState<string | null>(null);
  const targetRequest = useRef(0);
  const [pinned, setPinned] = useState(notice?.isPinned ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  const tl = textLength(title);
  const bl = textLength(body);
  const titleErr = tl === 0 ? "제목을 입력해 주십시오." : tl > NOTICE_TITLE_MAX ? `제목은 ${NOTICE_TITLE_MAX}자 이하로 입력해 주십시오.` : null;
  const bodyErr = bl === 0 ? "내용을 입력해 주십시오." : bl > NOTICE_BODY_MAX ? `내용은 ${NOTICE_BODY_MAX.toLocaleString("ko-KR")}자 이하로 입력해 주십시오.` : null;

  const targetInvalid = targetMode === "SPECIFIC" && audience !== "PARTNERS";
  const targetEmpty = targetMode === "SPECIFIC" && selected.length === 0;
  const findTargets = async (cursor: string | null = null) => {
    if (targetLoading || busy) return;
    const q = cursor ? searchedQuery : targetQuery.trim();
    const n = ++targetRequest.current;
    setTargetLoading(true);
    setTargetError(null);
    const params = new URLSearchParams({ q, limit: "10" });
    if (cursor) params.set("cursor", cursor);
    const r = await adminApi<{ sellers: NoticeTarget[]; nextCursor: string | null }>(`/api/admin/sellers?${params}`);
    if (n !== targetRequest.current) return;
    setTargetLoading(false);
    if (!r.ok) return setTargetError(failMessage(r, "파트너스를 불러오지 못했어요. 다시 검색해 주세요."));
    const rows = r.data.sellers.map(({ id, shopName, slug }) => ({ id, shopName, slug }));
    setTargetResults((current) => cursor ? [...new Map([...current, ...rows].map((seller) => [seller.id, seller])).values()] : rows);
    setSearchedQuery(q);
    setTargetNext(r.data.nextCursor);
    setTargetSearched(true);
  };

  const save = async (publish: boolean) => {
    if (busy) return;
    if (titleErr || bodyErr) return setShowErrors(true);
    if (targetInvalid) return setError("특정 파트너스 공지는 파트너스 관리자만 볼 수 있어요. 대상을 확인해 주세요.");
    if (publish && targetEmpty) return setError("게시할 파트너스를 한 곳 이상 골라 주세요.");
    setBusy(true);
    setError(null);
    const values = { title: title.trim(), body, category, audience, isPinned: pinned, publish, targetMode, targetSellerIds: targetMode === "SPECIFIC" ? selected.map((seller) => seller.id) : [] };
    const r = notice
      ? await adminApi<{ notice: Notice }>(`/api/admin/platform-notices/${notice.id}`, { method: "PUT", json: { ...values, expectedVersion: notice.version } })
      : await adminApi<{ notice: Notice }>("/api/admin/platform-notices", { method: "POST", json: values });
    setBusy(false);
    if (r.ok) return onSaved(r.data.notice, publish);
    if (r.status === 409 || r.status === 404) return onStale();
    setError(r.status === 400 && r.message ? r.message : failMessage(r, "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오."));
  };

  return (
    <form
      className="notice-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save(true);
      }}
      noValidate
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 20, alignItems: "start" }}>
        <div>
          <FormSection title="내용">
            <FormRow label="분류" required>
              {(Object.keys(NOTICE_CATEGORY) as NoticeCategory[]).map((c) => (
                <label key={c} className="chk">
                  <input className="rdo" type="radio" name="category" checked={category === c} onChange={() => setCategory(c)} disabled={busy} />
                  {NOTICE_CATEGORY[c].label}
                </label>
              ))}
            </FormRow>
            <FormRow label="제목" required htmlFor="notice-title" help={`${tl}/${NOTICE_TITLE_MAX}`}>
              <input id="notice-title" className="inp" value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} aria-invalid={showErrors && !!titleErr} />
              {showErrors && titleErr && (
                <span className="err" role="alert">
                  {titleErr}
                </span>
              )}
            </FormRow>
            <FormRow label="본문" required htmlFor="notice-body" help={`${bl.toLocaleString("ko-KR")}/${NOTICE_BODY_MAX.toLocaleString("ko-KR")}`}>
              <textarea id="notice-body" className="inp" rows={10} value={body} onChange={(e) => setBody(e.target.value)} disabled={busy} aria-invalid={showErrors && !!bodyErr} />
              {showErrors && bodyErr && (
                <span className="err" role="alert">
                  {bodyErr}
                </span>
              )}
            </FormRow>
            <FormRow label="중요">
              <label className="chk">
                <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} disabled={busy} />
                중요 공지로 표시 (목록 상단 고정)
              </label>
            </FormRow>
          </FormSection>
          <FormSection title="대상">
            <FormRow label="대상" required>
              {(Object.keys(NOTICE_AUDIENCE) as NoticeAudience[]).map((a) => (
                <label key={a} className="chk">
                  <input className="rdo" type="radio" name="audience" checked={audience === a} onChange={() => setAudience(a)} disabled={busy} />
                  {a === "PARTNERS" ? "파트너스 관리자" : a === "PUBLIC" ? "로그인 없이 누구나 볼 수 있는 공지" : "파트너스 관리자와 일반 방문자"}
                </label>
              ))}
            </FormRow>
            {(audience === "PARTNERS" || targetMode === "SPECIFIC") && (
              <FormRow label="파트너스 선택" required>
                <div className="col" style={{ gap: 8 }}>
                  <label className="chk">
                    <input className="rdo" type="radio" name="targetMode" checked={targetMode === "ALL"} onChange={() => setTargetMode("ALL")} disabled={busy} />
                    전체 파트너스
                  </label>
                  <label className="chk">
                    <input className="rdo" type="radio" name="targetMode" checked={targetMode === "SPECIFIC"} onChange={() => setTargetMode("SPECIFIC")} disabled={busy || audience !== "PARTNERS"} />
                    특정 파트너스 선택
                  </label>
                  {targetInvalid && <span className="err" role="alert">특정 파트너스 공지는 파트너스 관리자만 볼 수 있어요. 대상을 확인해 주세요.</span>}
                  {targetMode === "SPECIFIC" && (
                    <>
                      <label htmlFor="notice-target-query">파트너스 검색</label>
                      <div className="row" style={{ gap: 8 }}>
                        <input id="notice-target-query" className="inp" value={targetQuery} maxLength={50} placeholder="검색어 입력" disabled={busy || targetLoading} onChange={(e) => setTargetQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void findTargets(); } }} />
                        <button className="btn btn-out" type="button" disabled={busy || targetLoading} onClick={() => void findTargets()}>검색</button>
                      </div>
                      {targetLoading && <span role="status">파트너스를 불러오고 있어요.</span>}
                      {targetError && <span className="err" role="alert">{targetError}</span>}
                      {targetSearched && !targetLoading && !targetError && targetResults.length === 0 && <span>검색 결과가 없어요.</span>}
                      <ul className="col" aria-label="파트너스 검색 결과" style={{ listStyle: "none", margin: 0, padding: 0, gap: 8 }}>
                        {targetResults.map((seller) => {
                          const checked = selected.some((item) => item.id === seller.id);
                          return <li key={seller.id}><label className="chk"><input className="cbx" type="checkbox" checked={checked} disabled={busy || (!checked && selected.length >= NOTICE_TARGET_MAX)} onChange={(e) => { const checkedNow = e.currentTarget.checked; setSelected((current) => checkedNow ? current.some((item) => item.id === seller.id) || current.length >= NOTICE_TARGET_MAX ? current : [...current, seller] : current.filter((item) => item.id !== seller.id)); }} />{seller.shopName} · {seller.slug}</label></li>;
                        })}
                      </ul>
                      {targetNext && <button className="btn btn-out" type="button" disabled={busy || targetLoading} onClick={() => void findTargets(targetNext)}>더 불러오기</button>}
                      <span className="t-c1 c-alt">선택 {selected.length}/{NOTICE_TARGET_MAX}</span>
                      <ul className="col" aria-label="선택한 파트너스" style={{ listStyle: "none", margin: 0, padding: 0, gap: 8 }}>
                        {selected.map((seller) => <li key={seller.id} className="row" style={{ gap: 8 }}><span>{seller.shopName}{seller.slug ? ` · ${seller.slug}` : ""}</span><button className="btn btn-sm btn-out" type="button" disabled={busy} aria-label={`${seller.shopName} 선택 해제`} onClick={() => setSelected((current) => current.filter((item) => item.id !== seller.id))}>선택 해제</button></li>)}
                      </ul>
                      {targetEmpty && <span className="t-c1 c-alt">게시할 파트너스를 한 곳 이상 골라 주세요. 선택 전에는 임시 저장만 할 수 있어요.</span>}
                    </>
                  )}
                </div>
              </FormRow>
            )}
          </FormSection>
        </div>
        <div>
          <section className="au-fs" aria-labelledby="notice-preview">
            <div className="au-fs-h">
              <h2 className="au-fs-t" id="notice-preview">
                미리보기
              </h2>
            </div>
            <div className="card pad col" style={{ gap: 8 }} data-testid="notice-preview">
              <span className="row" style={{ gap: 6 }}>
                <span className={`bdg ${NOTICE_CATEGORY[category].cls}`}>{NOTICE_CATEGORY[category].label}</span>
                {pinned && <span className="bdg b-fail">중요</span>}
              </span>
              <strong className="t-h2">{title.trim() || "제목"}</strong>
              <p className="t-b2" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                {body.trim() || "내용"}
              </p>
            </div>
          </section>
        </div>
      </div>
      {error && (
        <p className="err" role="alert" style={{ textAlign: "center" }}>
          {error}
        </p>
      )}
      <FormFoot>
        <button className="btn btn-lg" type="submit" disabled={busy || targetInvalid || targetEmpty}>
          {busy ? "저장 중" : "지금 게시하기"}
        </button>
        <button className="btn btn-lg btn-out" type="button" onClick={() => void save(false)} disabled={busy}>
          임시 저장하기
        </button>
        <Link className="btn btn-lg btn-out" href="/admin/support/notices">
          취소
        </Link>
      </FormFoot>
    </form>
  );
}
