import Link from "next/link";
import { CALCULATORS } from "@/lib/calculators";

export function RelatedCalculators({ current }: { current: string }) {
  const items = CALCULATORS.filter((item) => item.href !== current);

  return (
    <section className="relatedSection" aria-labelledby="related-title">
      <div className="sectionHeading">
        <p className="sectionKicker">NEXT</p>
        <h2 id="related-title">다른 잔량</h2>
      </div>
      <div className="relatedGrid">
        {items.map((item) => (
          <Link className="relatedCard" href={item.href} key={item.href}>
            <span className="cardCategory">{item.category}</span>
            <strong>{item.title}</strong>
            <small>{item.summary}</small>
            <span className="cardArrow" aria-hidden="true">→</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
