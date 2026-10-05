// 목록 표 부품: 위쪽 「총 n건」+ 일괄 처리 버튼 영역, 표는 기존 .tbl, 아래 번호형 페이지 이동.
// 사용법:
//   <div className="card">
//     <ListHead total={total} actions={<button className="btn btn-sm btn-out" …>선택 삭제</button>} />
//     <div className="au-lt-wrap"><table className="tbl">…</table></div>
//     <Pagination page={page} pageCount={pageCount} onChange={setPage} />
//   </div>
// 스타일: styles/seller.css (.au-lh · .au-lt-wrap · .pg)
// loaded: 전체 수를 주는 API가 없어 지금 불러온 행 수만 아는 경우. 「총」 대신 「불러온」으로 보여 전체 건수처럼 읽히지 않게 한다.
export function ListHead({ total, unit = "건", loaded = false, actions }: { total: number; unit?: string; loaded?: boolean; actions?: React.ReactNode }) {
  return (
    <div className="au-lh">
      <span className="au-lh-total">
        {loaded ? "불러온" : "총"} <b className="num">{total.toLocaleString("ko-KR")}</b>
        {unit}
      </span>
      {actions && <div className="au-lh-act">{actions}</div>}
    </div>
  );
}

// page는 1부터. 한 번에 10개 번호를 보이고, 처음·이전·다음·마지막 버튼을 둔다.
export function Pagination({ page, pageCount, onChange }: { page: number; pageCount: number; onChange: (page: number) => void }) {
  if (pageCount <= 1) return null;
  const start = Math.floor((page - 1) / 10) * 10 + 1;
  const end = Math.min(pageCount, start + 9);
  const nums: number[] = [];
  for (let n = start; n <= end; n++) nums.push(n);
  const go = (n: number) => () => onChange(Math.min(pageCount, Math.max(1, n)));
  return (
    <nav className="pg au-pg" aria-label="페이지 이동">
      <button type="button" onClick={go(1)} disabled={page === 1} aria-label="처음">
        «
      </button>
      <button type="button" onClick={go(page - 1)} disabled={page === 1} aria-label="이전">
        ‹
      </button>
      {nums.map((n) => (
        <button key={n} type="button" className={n === page ? "on" : undefined} aria-current={n === page ? "page" : undefined} onClick={go(n)}>
          {n}
        </button>
      ))}
      <button type="button" onClick={go(page + 1)} disabled={page === pageCount} aria-label="다음">
        ›
      </button>
      <button type="button" onClick={go(pageCount)} disabled={page === pageCount} aria-label="마지막">
        »
      </button>
    </nav>
  );
}
