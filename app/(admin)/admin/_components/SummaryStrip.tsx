// 요약 띠(정본 `.sum`): 칸 사이 가는 선이 있는 한 줄 묶음. 칸마다 위에 작은 이름, 아래에 큰 숫자(필요하면 보조 한 줄).
// 칸이 많아 좁은 폭에서는 줄이 바뀐다(min = 칸 최소 폭). onClick을 주면 칸이 눌리는 버튼이 된다(on = 지금 걸린 조건).
export type SummaryCell = { label: string; value: React.ReactNode; sub?: string; tone?: "neg"; testId?: string; on?: boolean; onClick?: () => void };

const LINE = "var(--wds-line-normal, #e5e5e5)";

export function SummaryStrip({ cells, min = 128, label, testId }: { cells: SummaryCell[]; min?: number; label?: string; testId?: string }) {
  return (
    <div className="card" style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: 1, background: LINE, overflow: "hidden", padding: 0 }} role="group" aria-label={label} data-testid={testId}>
      {cells.map((c) => {
        const inner = (
          <>
            <span className="t-c1 c-alt">{c.label}</span>
            <span className={`t-h2 fw6 num${c.tone === "neg" ? " c-neg" : ""}`} data-testid={c.testId}>
              {c.value}
            </span>
            {c.sub && <span className="t-c1 c-alt">{c.sub}</span>}
          </>
        );
        const style: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, padding: "12px 16px", minWidth: 0, textAlign: "left", background: c.on ? "var(--wds-fill-alternative, #f4f5f7)" : "var(--wds-background-normal, #fff)" };
        return c.onClick ? (
          <button key={c.label} type="button" style={{ ...style, border: 0, cursor: "pointer", font: "inherit", color: "inherit" }} aria-pressed={c.on} onClick={c.onClick}>
            {inner}
          </button>
        ) : (
          <div key={c.label} style={style}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}
