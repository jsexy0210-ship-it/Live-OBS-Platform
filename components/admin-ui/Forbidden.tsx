"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

// 권한 없음(403) 공통 화면(AU-008). 관리자 인증 카드(AU-001~)와 같은 틀: 로고 → 제목 → 안내 → 「권한 요청」 → 「이전 화면」.
// 「권한 요청」은 onRequest를 넘긴 화면에서만 보인다(요청을 받는 서버가 없으면 버튼을 두지 않는다).
export function Forbidden({
  scope = "마스터 관리자",
  title = "이 화면을 볼 권한이 없습니다",
  description,
  homeHref,
  onRequest,
  requested,
}: {
  scope?: "마스터 관리자" | "파트너스 관리자";
  title?: string;
  description?: string;
  /** 이전 기록이 없을 때(직접 들어온 경우) 가는 곳 */
  homeHref: string;
  onRequest?: () => void;
  requested?: boolean;
}) {
  const router = useRouter();
  return (
    <div className="forbidden">
      <div className="card col login-card" role="alert">
        <span className="logo login-logo" aria-label="ONQ">
          <span className="logo-sym" />
          <span className="logo-word" />
        </span>
        <div className="col login-head">
          <span className="t-l2 c-alt">{scope}</span>
          <h1 className="t-t3" data-testid="admin-no-access">
            {title}
          </h1>
          {description && <span className="t-l2 c-alt">{description}</span>}
        </div>
        {onRequest && (
          <button className="btn btn-lg btn-block" type="button" onClick={onRequest} disabled={requested}>
            {requested ? "요청을 보냈습니다" : "권한 요청"}
          </button>
        )}
        <div className="row login-links" style={{ justifyContent: "center" }}>
          <Link
            href={homeHref}
            onClick={(e) => {
              if (window.history.length > 1) {
                e.preventDefault();
                router.back();
              }
            }}
          >
            이전 화면
          </Link>
        </div>
      </div>
    </div>
  );
}
