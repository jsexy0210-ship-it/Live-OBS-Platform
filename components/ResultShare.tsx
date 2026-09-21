"use client";

import { useState } from "react";
import type { BadgeTone } from "@/lib/badges";
import { renderShareCard } from "@/lib/shareCard";

type Props = {
  title: string;
  value: string;
  factBadge: string;
  impactBadge: string;
  tone: BadgeTone;
};

export function ResultShare({ title, value, factBadge, impactBadge, tone }: Props) {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function shareResult() {
    const text = [title, value, factBadge, impactBadge, "LifeLeft"].join("\n");
    const url = window.location.href;

    try {
      if (navigator.share) {
        await navigator.share({ title: `${title} | LifeLeft`, text, url });
        setStatus("공유 완료");
        return;
      }

      await navigator.clipboard.writeText(`${text}\n${url}`);
      setStatus("링크 복사 완료");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;

      try {
        await navigator.clipboard.writeText(`${text}\n${url}`);
        setStatus("링크 복사 완료");
      } catch {
        setStatus("공유 실패");
      }
    }
  }

  async function shareImage() {
    setBusy(true);
    try {
      const blob = await renderShareCard({ title, value, factBadge, impactBadge, tone });
      const file = new File([blob], `lifeleft-${Date.now()}.png`, { type: "image/png" });

      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: `${title} | LifeLeft` });
        setStatus("이미지 공유 완료");
        return;
      }

      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
      setStatus("이미지 저장 완료");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setStatus("이미지 생성 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="resultActions">
      <button className="primaryButton" type="button" onClick={shareResult}>
        결과 공유
      </button>
      <button className="ghostButton" type="button" onClick={shareImage} disabled={busy}>
        {busy ? "이미지 생성 중" : "이미지 카드"}
      </button>
      <span className="actionStatus" aria-live="polite">
        {status}
      </span>
    </div>
  );
}
