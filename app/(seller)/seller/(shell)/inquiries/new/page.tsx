"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { PageHead, useConfirm } from "../../../../../../components/admin-ui";
import { InquiryAttach, type Attached } from "../../../../../../components/seller/InquiryAttach";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { useUnsavedGuard } from "../../../../../../lib/client/navigation";
import { api } from "../../../../../../components/seller/api";
import { INQUIRY_BODY_MAX, INQUIRY_CATEGORY, INQUIRY_TITLE_MAX, type InquiryCategory } from "../../../../../../components/seller/platformInquiry";

// SA-114 문의 작성(파트너스 관리자, 공지 · 문의 › 문의하기). 유형·제목·내용·사진. 공지 상세 「관련 문의하기」로 들어오면 그 공지가 함께 붙는다.
// API: POST /api/seller/platform-inquiries { category, title, body, imageIds?, noticeId? } → 201 { inquiry } · 400 invalid_* · 429 too_many_inquiries(24시간 20건).
function Form() {
  const router = useRouter();
  const { confirm } = useConfirm();
  const noticeId = useSearchParams().get("noticeId");
  const [category, setCategory] = useState<InquiryCategory | "">("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [images, setImages] = useState<Attached[]>([]);
  const [noticeTitle, setNoticeTitle] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!noticeId) return;
    void api<{ notice: { title: string } }>(`/api/seller/platform-notices/${noticeId}`).then((r) => setNoticeTitle(r.ok ? r.data.notice.title : null));
  }, [noticeId]);

  const ready = category !== "" && title.trim() !== "" && body.trim() !== "";
  const dirty = title !== "" || body !== "" || images.length > 0;
  useUnsavedGuard(dirty && !sent, "작성 중인 내용이 사라집니다. 나가시겠습니까?");

  const send = async () => {
    if (!ready) return;
    let id = "";
    const ok = await confirm({
      title: "문의를 보내시겠습니까?",
      body: "보낸 뒤에는 수정하거나 지울 수 없습니다. 답변은 「내 문의」에서 확인합니다.",
      confirmLabel: "문의 보내기",
      run: async () => {
        const r = await api<{ inquiry: { id: string } }>("/api/seller/platform-inquiries", {
          method: "POST",
          body: { category, title: title.trim(), body: body.trim(), imageIds: images.map((i) => i.id), noticeId: noticeTitle ? noticeId : undefined },
        });
        if (!r.ok) return r.message ?? "문의를 보내지 못했습니다. 쓴 내용은 그대로 남아 있으니 인터넷 연결을 확인한 뒤 다시 눌러 주십시오";
        id = r.data.inquiry.id;
      },
    });
    if (!ok) return;
    setSent(true);
    router.replace(`/seller/inquiries/${id}`);
  };

  return (
    <>
      <Topbar crumb="공지 · 문의" />
      <main className="main">
        <PageHead
          back="/seller/inquiries"
          title="문의하기"
        />
        <div className="card" style={{ padding: 24 }}>
          <form
            className="col"
            style={{ gap: 16, maxWidth: 720 }}
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            {noticeTitle && (
              <div className="msg msg-info" role="status">
                <span>관련 공지: {noticeTitle}</span>
              </div>
            )}
            <div className="fld">
              <label htmlFor="iq-cat" className="req">
                유형
              </label>
              <select id="iq-cat" className="inp" value={category} onChange={(e) => setCategory(e.target.value as InquiryCategory | "")}>
                <option value="">선택</option>
                {Object.entries(INQUIRY_CATEGORY).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="iq-title" className="req">
                제목
              </label>
              <input id="iq-title" className="inp" maxLength={INQUIRY_TITLE_MAX} value={title} onChange={(e) => setTitle(e.target.value)} />
              <span className="help num">
                {title.length}/{INQUIRY_TITLE_MAX}자
              </span>
            </div>
            <div className="fld">
              <label htmlFor="iq-body" className="req">
                내용
              </label>
              <textarea id="iq-body" className="inp" style={{ height: 200, padding: "10px 12px" }} maxLength={INQUIRY_BODY_MAX} value={body} onChange={(e) => setBody(e.target.value)} />
              <span className="help num">
                {body.length}/{INQUIRY_BODY_MAX}자
              </span>
            </div>
            <div className="fld">
              <span className="lbl">사진</span>
              <InquiryAttach images={images} onChange={setImages} />
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" type="submit" disabled={!ready}>
                문의 보내기
              </button>
            </div>
          </form>
        </div>
      </main>
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
