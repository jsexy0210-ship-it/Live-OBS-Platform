import { FitText } from "@/components/FitText";
import type { BadgeTone } from "@/lib/badges";

type Props = {
  value: string;
  label: string;
  factBadge: string;
  impactBadge: string;
  tone: BadgeTone;
  eyebrow?: string;
};

export function ResultHero({
  value,
  label,
  factBadge,
  impactBadge,
  tone,
  eyebrow = "현재 결과"
}: Props) {
  return (
    <section className="resultHero" data-tone={tone}>
      <p className="eyebrow">{eyebrow}</p>
      <strong className="resultValue"><FitText>{value}</FitText></strong>
      <h2 className="resultLabel">{label}</h2>
      <div className="badgeRow">
        <span className="badge badgeFact">{factBadge}</span>
        <span className={`badge badgeImpact badge-${tone}`}>{impactBadge}</span>
      </div>
    </section>
  );
}
