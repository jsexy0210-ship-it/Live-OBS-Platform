// 외부 쇼핑몰에서 들어온 주문 표시(대기열·HIT 카드·방송 상세 공용). 서버의 source가 "EXTERNAL"일 때만 보이고, 플랫폼 이름은 밝히지 않는다.
// 쇼핑몰 이름(externalShopName)은 지금 몰 ID라 화면에 보이지 않는다(별칭이 생기면 title로 붙인다).
export type OrderSource = "INTERNAL" | "EXTERNAL";

export function SourceBadge({ source }: { source?: OrderSource | null }) {
  if (source !== "EXTERNAL") return null;
  return (
    <span className="bdg b-info" data-testid="source-badge">
      다른 쇼핑몰 주문
    </span>
  );
}
