export type OgSlug =
  | "home"
  | "commute"
  | "salary"
  | "weekends"
  | "work-time"
  | "ranking"
  | "subscriptions"
  | "survival";

/** public/og/<slug>.png · 1200×630 */
export function ogImages(slug: OgSlug, alt = "인생잔량 LifeLeft") {
  return [{ url: `/og/${slug}.png`, width: 1200, height: 630, alt }];
}
