import type { StatSource } from "@/lib/stats";

export function SourceNote({ sources }: { sources: StatSource[] }) {
  return (
    <div className="sourceNote">
      <span className="sourceLabel">데이터 출처</span>
      {sources.map((source) => (
        <p key={source.sourceName}>
          <a href={source.sourceUrl} target="_blank" rel="noopener noreferrer">
            {source.publisher} · {source.sourceName}
          </a>{" "}
          · 기준 {source.referenceDate} · 공표 {source.releasedAt}
        </p>
      ))}
    </div>
  );
}
