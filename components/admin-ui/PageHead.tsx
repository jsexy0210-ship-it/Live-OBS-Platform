// 페이지 머리: 제목(18px) + 경로 + 오른쪽 주요 버튼. 큰 설명문은 두지 않는다.
// 사용법:
//   <PageHead title="상품 목록" path={["상품", "상품 목록"]} actions={<Link className="btn" href="/seller/products/new">상품 등록</Link>} />
// 스타일: styles/seller.css 「관리자 공통 컴포넌트」(.au-ph)
export function PageHead({ title, path, actions }: { title: React.ReactNode; path?: string[]; actions?: React.ReactNode }) {
  return (
    <div className="au-ph">
      <div className="au-ph-t">
        <h1 className="au-ph-title">{title}</h1>
        {path && path.length > 0 && (
          <span className="au-ph-path">
            {path.map((p, i) => (
              <span key={i}>
                {i > 0 && <span aria-hidden="true"> › </span>}
                {p}
              </span>
            ))}
          </span>
        )}
      </div>
      {actions && <div className="au-ph-act">{actions}</div>}
    </div>
  );
}
