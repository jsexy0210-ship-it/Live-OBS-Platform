export type OgSlug =
  | "home"
  | "commute"
  | "salary"
  | "weekends"
  | "work-time"
  | "ranking"
  | "career"
  | "subscriptions"
  | "survival";

// 이미지 교체 시 값 변경 → 카카오톡 등 미리보기 캐시 무효화
const OG_VERSION = "20260922";

/** public/og/<slug>.png · 1200×630 */
export function ogImages(slug: OgSlug, alt = "인생잔량 LifeLeft") {
  return [{ url: `/og/${slug}.png?v=${OG_VERSION}`, width: 1200, height: 630, alt }];
}
