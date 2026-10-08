"use client";

import Link from "next/link";
import { useState } from "react";
import { textLength } from "../../../../lib/server/text/clean";
import { FormFoot, FormRow, FormSection } from "../../../../components/admin-ui";
import { adminApi, failMessage } from "./api";
import { NOTICE_AUDIENCE, NOTICE_BODY_MAX, NOTICE_CATEGORY, NOTICE_TITLE_MAX, type Notice, type NoticeAudience, type NoticeCategory } from "./notices";

// MA-054 공지 작성·수정 폼. 게시(publish: true)와 임시 저장을 나눠 보낸다. 수정은 expectedVersion을 같이 보내고, 다른 곳에서 먼저 고쳤으면(409) 알린다.
// 서버가 받는 값만 둔다: 분류·제목·본문·대상·중요 고정. 예약·이메일·알림톡·읽음 확인은 서버 지원 뒤에 붙인다.
export function NoticeForm({ notice, onSaved, onStale }: { notice?: Notice; onSaved: (n: Notice, published: boolean) => void; onStale: () => void }) {
  const [category, setCategory] = useState<NoticeCategory>(notice?.category ?? "GENERAL");
  const [title, setTitle] = useState(notice?.title ?? "");
  const [body, setBody] = useState(notice?.body ?? "");
  const [audience, setAudience] = useState<NoticeAudience>(notice?.audience ?? "PARTNERS");
  const [pinned, setPinned] = useState(notice?.isPinned ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  const tl = textLength(title);
  const bl = textLength(body);
  const titleErr = tl === 0 ? "제목을 입력해 주십시오." : tl > NOTICE_TITLE_MAX ? `제목은 ${NOTICE_TITLE_MAX}자 이하로 입력해 주십시오.` : null;
  const bodyErr = bl === 0 ? "내용을 입력해 주십시오." : bl > NOTICE_BODY_MAX ? `내용은 ${NOTICE_BODY_MAX.toLocaleString("ko-KR")}자 이하로 입력해 주십시오.` : null;

  const save = async (publish: boolean) => {
    if (busy) return;
    if (titleErr || bodyErr) return setShowErrors(true);
    setBusy(true);
    setError(null);
    const values = { title: title.trim(), body, category, audience, isPinned: pinned, publish };
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
        <button className="btn btn-lg" type="submit" disabled={busy}>
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
