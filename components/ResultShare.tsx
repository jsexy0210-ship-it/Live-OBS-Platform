"use client";

import { useState } from "react";

type Props = {
  title: string;
  value: string;
  factBadge: string;
  impactBadge: string;
};

export function ResultShare({ title, value, factBadge, impactBadge }: Props) {
  const [status, setStatus] = useState("");

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

  return (
    <div className="resultActions">
      <button className="primaryButton" type="button" onClick={shareResult}>
        결과 공유
      </button>
      {status ? <span className="actionStatus">{status}</span> : null}
    </div>
  );
}
