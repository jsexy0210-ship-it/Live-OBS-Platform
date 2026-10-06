"use client";

import { useId } from "react";

import { useSmartBack } from "../../lib/client/navigation";
import { RouteTabs, useShellNav } from "./shellNav";

// 페이지 머리: [← 뒤로] 제목(20px) + 오른쪽 주요 버튼. 제목 바로 아래 목적·핵심 안내를 description으로 표시한다(2026-10-06 대표님 최신 결정).
// 경로(대분류 › 메뉴)는 셸의 상단 경로 줄(.loc-bar)에서 한 번만 보인다(2026-10-05 시각 규격 「경로는 한 곳에서만」).
// path는 예전 호출과 맞추려고 받기만 하고 화면에 그리지 않는다.
// ← 버튼(DS-NAV 「화면 ← 버튼」): 셸이 알려 주는 부모 화면(메뉴 항목에서 한 단계 아래 화면)이 있으면 자동으로 붙는다.
//   앱 안 이전 기록이 있으면 뒤로, 없으면 부모로 replace(docs/IA.md Back 1항). back="/주소"로 부모를 바꾸고, back={false}로 뺀다.
// 통합 화면 탭(.rtabs): 같은 메뉴 항목의 다른 화면이 있으면 머리 바로 아래에 붙는다. tabs={false}로 뺀다.
// 사용법:
//   <PageHead title="상품 목록" actions={<Link className="btn" href="/seller/products/new">상품 등록</Link>} />
// 스타일: styles/seller.css 「관리자 공통 컴포넌트」(.au-ph · .bk · .rtabs)
export function PageHead({ title, description, actions, back, tabs }: { title: React.ReactNode; description?: React.ReactNode; path?: string[]; actions?: React.ReactNode; back?: string | false; tabs?: false }) {
  const descriptionId = useId();
  const hasDescription = description !== undefined && description !== null && description !== false;
  const nav = useShellNav();
  const backHref = back === false ? null : (back ?? nav.backHref);
  const goBack = useSmartBack(backHref ?? "/");
  const shownTabs = tabs === false ? [] : nav.tabs;
  const head = (
    <div className={`au-ph${backHref ? " has-bk" : ""}`}>
      <div className="au-ph-l">
        {backHref && (
          <button className="bk" type="button" aria-label="뒤로" title="뒤로" onClick={goBack}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 5l-7 7 7 7" />
            </svg>
          </button>
        )}
        <h1 className="au-ph-title" aria-describedby={hasDescription ? descriptionId : undefined}>{title}</h1>
      </div>
      {hasDescription && <p className="au-ph-description" id={descriptionId}>{description}</p>}
      {actions && <div className="au-ph-act">{actions}</div>}
    </div>
  );
  if (shownTabs.length < 2) return head;
  return (
    <div className="au-ph-wrap">
      {head}
      <RouteTabs />
    </div>
  );
}
