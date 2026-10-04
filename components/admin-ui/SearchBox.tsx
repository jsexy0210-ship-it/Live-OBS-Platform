// 표형 검색 상자: 왼쪽 회색 항목명 칸 + 입력 칸을 한 줄씩 쌓고, 아래 가운데 「검색」「초기화」 버튼.
// 사용법:
//   <SearchBox onSearch={() => load()} onReset={() => setQ(initial)}>
//     <SearchRow label="기간"><input className="inp" type="date" … /> ~ <input className="inp" type="date" … /></SearchRow>
//     <SearchRow label="검색어"><input className="inp" value={q} onChange={…} /></SearchRow>
//   </SearchBox>
// Enter로도 검색된다(form 제출). 스타일: styles/seller.css (.au-sb)
export function SearchBox({
  onSearch,
  onReset,
  busy,
  label = "검색 조건",
  children,
}: {
  onSearch: () => void;
  onReset?: () => void;
  busy?: boolean;
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <form
      className="au-sb"
      role="search"
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        onSearch();
      }}
    >
      <table className="au-ft">
        <tbody>{children}</tbody>
      </table>
      <div className="au-sb-f">
        <button className="btn" type="submit" disabled={busy}>
          검색
        </button>
        {onReset && (
          <button className="btn btn-out" type="button" onClick={onReset} disabled={busy}>
            초기화
          </button>
        )}
      </div>
    </form>
  );
}

export function SearchRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>
        <div className="au-ft-v">{children}</div>
      </td>
    </tr>
  );
}
