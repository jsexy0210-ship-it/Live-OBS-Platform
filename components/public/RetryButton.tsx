"use client";

export function RetryButton() {
  return (
    <button type="button" className="btn btn-lg btn-block" onClick={() => window.location.reload()}>
      다시 시도
    </button>
  );
}
