"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { FormFoot, FormRow, FormSection, PageHead, useConfirm } from "../../../../../../components/admin-ui";
import { InquiryAttach, type Attached, type AttachedFile } from "../../../../../../components/seller/InquiryAttach";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { Toast } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import { INQUIRY_BODY_MAX, INQUIRY_CATEGORY, INQUIRY_TITLE_MAX, INQUIRY_WRITE_CATEGORIES, type InquiryCategory } from "../../../../../../components/seller/platformInquiry";
import { formatDate, formatDateTime } from "../../../../../../lib/client/format";
import { useUnsavedGuard } from "../../../../../../lib/client/navigation";
import "./new.css";

// SA-114 문의하기(파트너스 관리자, 공지 · 문의 › 내 문의 › 문의하기, 정본 v319). 문의 종류(8종 버튼)·제목·내용·관련 주문 · 방송·첨부(사진 · .txt · .log · .zip)·진단 정보 동의.
// 공지 상세 「이 공지에 대해 문의」로 들어오면 그 공지가 함께 붙는다. 「임시 저장」은 계정당 하나(GET·PUT·DELETE /api/seller/platform-inquiries/draft)이고 다시 오면 이어서 쓴다.
// 「방송 화면」 종류 + 제목의 「[긴급]」은 긴급(urgent)으로 보낸다(정본 안내). API: POST /api/seller/platform-inquiries → 201 { inquiry } · 400 invalid_* · 429 too_many_inquiries(24시간 20건).
const URGENT = /^\s*\[긴급\]\s*/;
// 종류별 먼저 확인 안내(정본에 있는 것만)
const HINTS: Partial<Record<InquiryCategory, { title: string; body: string }>> = {
  BROADCAST: { title: "방송 화면이 멈출 때", body: "먼저 확인: OBS 브라우저 소스 새로고침 → 방송 화면 연결 상태 확인 → 그래도 안 되면 아래에 방송 시각을 적어 주십시오" },
};
type Related = { broadcasts: { id: string; title: string | null; startedAt: string }[]; orders: { id: string; orderNoLabel: string; nickname: string | null; createdAt: string }[] };
type Draft = { category: InquiryCategory | null; title: string; body: string; urgent: boolean; relatedOrderId: string | null; relatedBroadcastId: string | null; includeDiagnostics: boolean };

function Form() {
  const router = useRouter();
  const { confirm } = useConfirm();
  const noticeId = useSearchParams().get("noticeId");
  const [category, setCategory] = useState<InquiryCategory | "">("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [related, setRelated] = useState("");
  const [images, setImages] = useState<Attached[]>([]);
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [diag, setDiag] = useState(true);
  const [options, setOptions] = useState<Related | null>(null);
  const [noticeTitle, setNoticeTitle] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [sent, setSent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // 마지막으로 임시 저장했거나 불러온 상태(이 값과 같으면 나가도 잃는 것이 없다)
  const [savedKey, setSavedKey] = useState("");
  const restored = useRef(false);

  useEffect(() => {
    if (!noticeId) return;
    void api<{ notice: { title: string } }>(`/api/seller/platform-notices/${noticeId}`).then((r) => setNoticeTitle(r.ok ? r.data.notice.title : null));
  }, [noticeId]);
  useEffect(() => {
    void api<Related>("/api/seller/platform-inquiries/related-options").then((r) => r.ok && setOptions(r.data));
  }, []);
  // 임시 저장한 내용이 있으면 이어서 쓴다
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    void api<{ draft: Draft | null }>("/api/seller/platform-inquiries/draft").then((r) => {
      const d = r.ok ? r.data.draft : null;
      if (!d) return;
      const t = d.urgent ? `[긴급] ${d.title}` : d.title;
      setCategory(d.category ?? "");
      setTitle(t);
      setBody(d.body);
      setRelated(d.relatedBroadcastId ? `b:${d.relatedBroadcastId}` : d.relatedOrderId ? `o:${d.relatedOrderId}` : "");
      setDiag(d.includeDiagnostics);
      setSavedKey(JSON.stringify([d.category ?? "", t, d.body, d.relatedBroadcastId ? `b:${d.relatedBroadcastId}` : d.relatedOrderId ? `o:${d.relatedOrderId}` : "", d.includeDiagnostics]));
    });
  }, []);

  const key = useMemo(() => JSON.stringify([category, title, body, related, diag]), [category, title, body, related, diag]);
  const empty = category === "" && title === "" && body === "" && related === "" && images.length === 0 && files.length === 0;
  const dirty = !empty && (key !== savedKey || images.length > 0 || files.length > 0);
  useUnsavedGuard(dirty && !sent, "작성 중인 내용이 사라집니다. 나가시겠습니까?");

  const errors = {
    category: category === "" ? "문의 종류를 선택해 주십시오" : null,
    title: title.trim() === "" ? "제목을 입력해 주십시오" : null,
    body: body.trim() === "" ? "내용을 입력해 주십시오" : null,
  };
  const fields = () => {
    const urgent = category === "BROADCAST" && URGENT.test(title);
    return {
      urgent,
      title: (urgent ? title.replace(URGENT, "") : title).trim(),
      relatedBroadcastId: related.startsWith("b:") ? related.slice(2) : null,
      relatedOrderId: related.startsWith("o:") ? related.slice(2) : null,
    };
  };

  const saveDraft = async () => {
    if (saving || empty) return;
    setSaving(true);
    const f = fields();
    const r = await api<{ draft: unknown }>("/api/seller/platform-inquiries/draft", {
      method: "PUT",
      body: { category: category || null, title: f.title, body, urgent: f.urgent, relatedOrderId: f.relatedOrderId, relatedBroadcastId: f.relatedBroadcastId, includeDiagnostics: diag },
    });
    setSaving(false);
    if (!r.ok) return setToast(r.message ?? "임시 저장하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오");
    setSavedKey(key);
    setToast("작성 중인 내용을 임시 저장했습니다");
  };

  const send = async () => {
    setShowErrors(true);
    if (errors.category || errors.title || errors.body) return;
    let id = "";
    const f = fields();
    const ok = await confirm({
      title: "문의를 보내시겠습니까?",
      body: "보낸 뒤에는 수정하거나 지울 수 없습니다. 답변은 「내 문의」에서 확인합니다.",
      confirmLabel: "문의 보내기",
      run: async () => {
        const r = await api<{ inquiry: { id: string } }>("/api/seller/platform-inquiries", {
          method: "POST",
          body: {
            category,
            title: f.title,
            body: body.trim(),
            urgent: f.urgent,
            imageIds: images.map((i) => i.id),
            fileIds: files.map((x) => x.id),
            relatedOrderId: f.relatedOrderId,
            relatedBroadcastId: f.relatedBroadcastId,
            includeDiagnostics: diag,
            noticeId: noticeTitle ? noticeId : undefined,
          },
        });
        if (!r.ok) return r.message ?? "문의를 보내지 못했습니다. 쓴 내용은 그대로 남아 있으니 인터넷 연결을 확인한 뒤 다시 눌러 주십시오";
        id = r.data.inquiry.id;
      },
    });
    if (!ok) return;
    setSent(true);
    void api("/api/seller/platform-inquiries/draft", { method: "DELETE" });
    router.replace(`/seller/inquiries/${id}`);
  };

  const hint = category ? HINTS[category] : undefined;
  const err = (e: string | null) => (showErrors ? e : null);

  return (
    <>
      <Topbar crumb="공지 · 문의 › 내 문의 › 문의하기" />
      <main className="main">
        <PageHead back="/seller/inquiries" title="문의하기" />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className="iq-two">
            <div>
              <FormSection title="ONQ 운영팀에 문의하기">
                {noticeTitle && (
                  <FormRow label="관련 공지">
                    <span>관련 공지: {noticeTitle}</span>
                  </FormRow>
                )}
                <FormRow label="문의 종류" required>
                  <div className="col" style={{ gap: 8, width: "100%" }}>
                    <div className="iq-kinds" role="radiogroup" aria-label="문의 종류">
                      {INQUIRY_WRITE_CATEGORIES.map((k) => (
                        <button key={k} type="button" role="radio" aria-checked={category === k} className={`btn btn-sm${category === k ? "" : " btn-out"}`} onClick={() => setCategory(k)}>
                          {INQUIRY_CATEGORY[k]}
                        </button>
                      ))}
                    </div>
                    {err(errors.category) && <span className="err" role="alert">{errors.category}</span>}
                    {hint && (
                      <div className="msg msg-info" role="status">
                        <span>
                          <b>{hint.title}</b> · {hint.body}
                        </span>
                      </div>
                    )}
                  </div>
                </FormRow>
                <FormRow label="제목" required htmlFor="iq-title">
                  <div className="col" style={{ gap: 4, width: "100%" }}>
                    <input id="iq-title" className={`inp${err(errors.title) ? " is-error" : ""}`} style={{ width: "100%" }} maxLength={INQUIRY_TITLE_MAX + 5} aria-invalid={!!err(errors.title)} value={title} onChange={(e) => setTitle(e.target.value)} />
                    {err(errors.title) ? <span className="err" role="alert">{errors.title}</span> : <span className="t-c1 c-alt num">{[...title].length} / {INQUIRY_TITLE_MAX}</span>}
                  </div>
                </FormRow>
                <FormRow label="문의 내용" required htmlFor="iq-body">
                  <div className="col" style={{ gap: 4, width: "100%" }}>
                    <textarea id="iq-body" className={`inp${err(errors.body) ? " is-error" : ""}`} style={{ width: "100%", height: 200, padding: "10px 12px" }} maxLength={INQUIRY_BODY_MAX} aria-invalid={!!err(errors.body)} value={body} onChange={(e) => setBody(e.target.value)} />
                    {err(errors.body) ? <span className="err" role="alert">{errors.body}</span> : <span className="t-c1 c-alt num">{[...body].length} / {INQUIRY_BODY_MAX.toLocaleString("ko-KR")}</span>}
                  </div>
                </FormRow>
                <FormRow label="관련 주문 · 방송 (선택)" htmlFor="iq-related">
                  <select id="iq-related" className="inp" style={{ width: 360, maxWidth: "100%" }} value={related} onChange={(e) => setRelated(e.target.value)}>
                    <option value="">선택 안 함</option>
                    {options?.broadcasts.map((b) => (
                      <option key={b.id} value={`b:${b.id}`}>
                        {formatDate(b.startedAt)} 방송{b.title ? ` 「${b.title}」` : ""}
                      </option>
                    ))}
                    {options?.orders.map((o) => (
                      <option key={o.id} value={`o:${o.id}`}>
                        {formatDateTime(o.createdAt)} 주문{o.nickname ? ` · ${o.nickname}` : ""} ({o.orderNoLabel})
                      </option>
                    ))}
                  </select>
                </FormRow>
                <FormRow label="첨부 사진 (선택)">
                  <InquiryAttach images={images} onChange={setImages} files={files} onFilesChange={setFiles} />
                </FormRow>
                <FormRow label="함께 보낼 진단 정보" help="보낼 때 한 번 모읍니다 · 브라우저 · OS · OBS 버전 · 최근 방송 · 방송 화면 마지막 접속 · 앱 버전 · 확인할 수 없는 항목은 「확인 안 됨」으로 갑니다">
                  <label className="chk">
                    <input type="checkbox" checked={diag} onChange={(e) => setDiag(e.target.checked)} />
                    진단 정보를 함께 보냅니다
                  </label>
                </FormRow>
              </FormSection>
              <p className="help" style={{ marginTop: 8 }}>
                평일에는 4시간 안에 첫 답변을 드립니다
              </p>
            </div>
            <div>
              <section className="au-fs">
                <div className="au-fs-h">
                  <h2 className="au-fs-t">긴급 (방송 중 장애)</h2>
                </div>
                <div className="msg msg-cau" role="note">
                  <span>
                    방송 중 결제 · 방송 화면 장애는 「방송 화면」 종류 + 제목에 <b>[긴급]</b>을 붙여 주십시오 · 운영팀 알림이 바로 울립니다
                  </span>
                </div>
              </section>
            </div>
          </div>
          <FormFoot>
            <button className="btn btn-lg" type="submit">
              문의 보내기
            </button>
            <button className="btn btn-lg btn-out" type="button" disabled={saving || empty} onClick={() => void saveDraft()}>
              {saving ? "저장 중" : "임시 저장"}
            </button>
            <button className="btn btn-lg btn-out" type="button" onClick={() => router.push("/seller/inquiries")}>
              취소
            </button>
          </FormFoot>
        </form>
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}

export default function NewInquiryPage() {
  return (
    <Suspense>
      <Form />
    </Suspense>
  );
}
