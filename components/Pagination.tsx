import Link from "next/link";
import "../styles/pagination.css";

type Navigation = { onChange: (page: number) => void; href?: never } | { href: (page: number) => string; onChange?: never };
type Props = Navigation & { page: number; pageCount: number; label?: string };

// Counts come from a total/offset API, or from cursors the caller already visited.
const countOf = (value: number) => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
export function pageNumbers(page: number, pages: number): number[] {
  const count = countOf(pages);
  const current = Math.min(count || 1, Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1));
  const start = Math.floor((current - 1) / 10) * 10 + 1;
  return Array.from({ length: Math.max(0, Math.min(10, count - start + 1)) }, (_, i) => start + i);
}

function PageNavigation(props: Props & { cursor?: boolean; hasNext?: boolean; onNext?: () => void }) {
  const count = countOf(props.pageCount);
  if (!count) return null;
  const current = Math.min(count, Math.max(1, Number.isFinite(props.page) ? Math.floor(props.page) : 1));
  const mobileStart = Math.floor((current - 1) / 5) * 5 + 1;
  const control = (target: number, text: string | number, label: string, disabled = false, extra = "", next = false) => {
    const active = typeof text === "number" && target === current;
    const className = `btn btn-out onq-page-control${active ? " on" : ""}${extra}`;
    const common = { className, "aria-label": label, "aria-current": active ? "page" as const : undefined };
    if (!disabled && props.href) return <Link key={label} {...common} href={props.href(target)}>{text}</Link>;
    return <button key={label} {...common} type="button" disabled={disabled} onClick={disabled ? undefined : next ? props.onNext : () => props.onChange?.(target)}>{text}</button>;
  };
  return <nav className="onq-pagination" aria-label={props.label ?? "페이지 이동"}>
    <span className="onq-page-arrows">
      {control(1, "«", "처음", current === 1)}
      {control(current - 1, "‹", "이전", current === 1)}
    </span>
    <span className="onq-page-numbers">
      {pageNumbers(current, count).map(n => control(n, n, `${n}페이지`, false, n < mobileStart || n >= mobileStart + 5 ? " onq-page-desktop" : ""))}
    </span>
    <span className="onq-page-arrows">
      {control(current + 1, "›", "다음", props.cursor ? !props.hasNext : current === count, "", !!props.cursor)}
      {!props.cursor && control(count, "»", "마지막", current === count)}
    </span>
  </nav>;
}

export function Pagination(props: Props) { return <PageNavigation {...props} />; }

// Never invent a last page for a cursor API. Numbers represent the caller's saved history only.
export function CursorPagination({ page, visited, hasNext, onChange, onNext }: { page: number; visited: number; hasNext: boolean; onChange: (page: number) => void; onNext: () => void }) {
  return <PageNavigation page={page} pageCount={visited} onChange={onChange} cursor hasNext={page < visited || hasNext} onNext={() => page < visited ? onChange(page + 1) : onNext()} />;
}
