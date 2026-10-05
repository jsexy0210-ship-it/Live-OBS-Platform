"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHead } from "../../../../../../components/admin-ui";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";
import { textLength } from "../../../../../../components/seller/format";
import "./search-synonyms.css";
import { confirmLeave, useUnsavedGuard } from "../../../../../../lib/client/navigation";

// 쇼핑몰 검색 유사어(파트너스 관리자, 상품 › 검색 유사어). 같은 뜻으로 묶어 둔 말은 어느 것으로 찾아도 서로의 상품이 검색됩니다.
// API: GET·PUT /api/seller/shop-search/synonyms(통째로 바꿈). 조회는 같은 쇼핑몰 파트너스 계정 누구나, 저장은 canEdit(대표자·상품 관리 직원)만.
// 서버 규칙: 최대 50묶음, 묶음당 2~10단어, 단어 20자, 같은 단어는 한 묶음에만. 화면에서도 같은 규칙으로 먼저 안내한다.
const MAX_GROUPS = 50;
const WORDS_MIN = 2;
const WORDS_MAX = 10;
const WORD_LEN = 20;
type Row = { key: number; text: string };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok" };

let seq = 0;
// 쉼표로 나눠 앞뒤 공백을 지우고, 빈 것과 같은 묶음 안의 중복(대소문자 무시)을 뺀다
const parseWords = (text: string): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of text.split(/[,，]/).map((x) => x.trim())) {
    if (w === "" || seen.has(w.toLowerCase())) continue;
    seen.add(w.toLowerCase());
    out.push(w);
  }
  return out;
};

export default function SearchSynonymsPage() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [canEdit, setCanEdit] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [saved, setSaved] = useState("[]");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  const apply = (groups: { words: string[] }[]) => {
    setRows(groups.map((g) => ({ key: ++seq, text: g.words.join(", ") })));
    setSaved(JSON.stringify(groups.map((g) => g.words)));
  };

  const load = useCallback(async () => {
    const r = await api<{ groups: { words: string[] }[]; canEdit: boolean }>("/api/seller/shop-search/synonyms");
    if (!r.ok) return setState({ kind: "error", status: r.status });
    apply(r.data.groups);
    setCanEdit(r.data.canEdit);
    setState({ kind: "ok" });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 칸마다 안내: 묶음 하나가 2~10단어, 단어 20자, 다른 묶음과 같은 단어 금지
  const parsed = rows.map((r) => parseWords(r.text));
  const owner = new Map<string, number>();
  const errorOf = parsed.map((words, i) => {
    if (words.length === 0) return null;
    if (words.length < WORDS_MIN) return `같은 뜻의 말을 ${WORDS_MIN}개 이상 쉼표로 적어 주십시오`;
    if (words.length > WORDS_MAX) return `한 묶음에는 ${WORDS_MAX}개까지 넣을 수 있습니다`;
    const long = words.find((w) => textLength(w) > WORD_LEN);
    if (long) return `「${long}」은 ${WORD_LEN}자를 넘습니다`;
    for (const w of words) {
      const at = owner.get(w.toLowerCase());
      if (at !== undefined && at !== i) return `「${w}」은 다른 묶음에도 있습니다. 한 단어는 한 묶음에만 넣을 수 있습니다`;
    }
    for (const w of words) owner.set(w.toLowerCase(), i);
    return null;
  });
  const groups = parsed.filter((w) => w.length > 0);
  const dirty = canEdit && JSON.stringify(groups) !== saved;
  useUnsavedGuard(dirty);

  const save = async () => {
    if (errorOf.some((e) => e !== null)) {
      setShowErrors(true);
      return setFailed("표시된 묶음을 확인해 주십시오");
    }
    setBusy(true);
    setFailed(null);
    const r = await api<{ groups: { words: string[] }[] }>("/api/seller/shop-search/synonyms", { method: "PUT", body: { groups: groups.map((words) => ({ words })) } });
    setBusy(false);
    if (!r.ok) return setFailed(failMessage(r, "admin", "저장하지 못했습니다. 입력한 내용은 그대로 있습니다"));
    apply(r.data.groups);
    setShowErrors(false);
    setToast({ text: "검색 유사어를 저장했습니다" });
  };

  return (
    <>
      <Topbar crumb="상품 › 검색 유사어" />
      <main className="main">
        <PageHead
          title="검색 유사어"
          actions={
            <>
              {canEdit && (
              <button className={`btn${busy ? " is-loading" : ""}`} type="button" disabled={busy || !dirty} onClick={() => void save()}>
                {busy ? "저장 중" : "저장"}
              </button>
              )}
            </>
          }
        />
        {state.kind === "ok" && !canEdit && (
          <div className="msg msg-info" role="status">
            <span>검색 유사어를 볼 수만 있습니다. 바꾸려면 대표자나 상품 관리 권한이 있는 직원에게 요청해 주십시오.</span>
          </div>
        )}
        {failed && (
          <div className="msg msg-neg" role="alert">
            <span>{failed}</span>
          </div>
        )}
        <div className="card">
          {state.kind === "loading" && <LoadingRows rows={4} />}
          {state.kind === "error" &&
            (state.status === 403 ? <NoPermission need="상품 관리" /> : state.status === 402 ? <Locked /> : <ErrorState title="검색 유사어를 불러오지 못했습니다" onRetry={() => void load()} />)}
          {state.kind === "ok" && (
            <div className="pad col ss-body">
              <p className="t-l2 c-alt">
                같은 뜻의 말을 쉼표로 묶어 두면 어느 말로 검색해도 서로의 상품이 나옵니다. 예: 노트북, 랩탑
              </p>
              {rows.length === 0 && <p className="t-l2">아직 묶음이 없습니다.</p>}
              {rows.map((r, i) => (
                <div key={r.key} className="fld" data-testid="synonym-row">
                  <label htmlFor={`syn-${r.key}`}>묶음 {i + 1}</label>
                  <div className="row ss-line">
                    <input
                      id={`syn-${r.key}`}
                      className={`inp grow${showErrors && errorOf[i] ? " is-error" : ""}`}
                      value={r.text}
                      disabled={!canEdit || busy}
                      placeholder="예: 노트북, 랩탑"
                      onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, text: e.target.value } : x)))}
                    />
                    {canEdit && (
                      <button className="btn btn-sm btn-out" type="button" disabled={busy} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                        삭제
                      </button>
                    )}
                  </div>
                  {errorOf[i] && (showErrors || parsed[i].length > WORDS_MAX) && <span className="err">{errorOf[i]}</span>}
                </div>
              ))}
              {canEdit && (
                <div className="row ss-foot">
                  <button className="btn btn-sm btn-out" type="button" disabled={busy || rows.length >= MAX_GROUPS} onClick={() => setRows((rs) => [...rs, { key: ++seq, text: "" }])}>
                    묶음 추가
                  </button>
                  <span className="t-c1 c-alt num">
                    {rows.length} / {MAX_GROUPS}묶음 · 한 묶음에 {WORDS_MIN}~{WORDS_MAX}개 · 단어마다 {WORD_LEN}자까지
                  </span>
                </div>
              )}
              {canEdit && (
                <div className="row">
                  <button
                    className="btn btn-sm btn-text"
                    type="button"
                    disabled={busy || !dirty}
                    onClick={() => {
                      if (confirmLeave(dirty, "저장하지 않은 변경이 사라집니다. 되돌리시겠습니까?")) void load();
                    }}
                  >
                    되돌리기
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
