// 오버레이 레이아웃 화면 쪽 공용 정의(편집기 SA-051 · 오버레이 OV-001/002). 서버 계약은 lib/server/overlay/layout.ts와 같다.
export type Aspect = "9x16" | "16x9";
export type WidgetType = "HALL_OF_FAME" | "NOTICE" | "SHOP_INFO" | "CURRENT_ORDER" | "QUEUE" | "OPEN_TIMER" | "NEW_ORDER_ALERT" | "EVENT_CARD" | "PURCHASE_RANKING";
export type PropValue = string | number | boolean;
export type Widget = { id: string; type: WidgetType; visible: boolean; x: number; y: number; w: number; h: number; z: number; props: Record<string, PropValue> };

export const STAGE: Record<Aspect, { w: number; h: number }> = { "9x16": { w: 1080, h: 1920 }, "16x9": { w: 1920, h: 1080 } };
export const MAX_TEMPLATES = 20;

// 위젯 한 칸 = 종류 하나(신규 주문 알림은 첫 주문·재주문·VIP 각각)
export type Slot = { key: string; type: WidgetType; variant?: "first" | "repeat" | "vip"; label: string };
export const SLOTS: Slot[] = [
  { key: "CURRENT_ORDER", type: "CURRENT_ORDER", label: "현재 주문" },
  { key: "QUEUE", type: "QUEUE", label: "주문대기" },
  { key: "HALL_OF_FAME", type: "HALL_OF_FAME", label: "명예의 전당" },
  { key: "NOTICE", type: "NOTICE", label: "공지" },
  { key: "SHOP_INFO", type: "SHOP_INFO", label: "쇼핑몰 정보" },
  { key: "OPEN_TIMER", type: "OPEN_TIMER", label: "개봉 타이머" },
  { key: "EVENT_CARD", type: "EVENT_CARD", label: "이벤트 할인 카드" },
  { key: "PURCHASE_RANKING", type: "PURCHASE_RANKING", label: "구매 랭킹" },
  { key: "NEW_ORDER_ALERT:first", type: "NEW_ORDER_ALERT", variant: "first", label: "신규 주문 알림 · 첫 주문" },
  { key: "NEW_ORDER_ALERT:repeat", type: "NEW_ORDER_ALERT", variant: "repeat", label: "신규 주문 알림 · 재주문" },
  { key: "NEW_ORDER_ALERT:vip", type: "NEW_ORDER_ALERT", variant: "vip", label: "신규 주문 알림 · VIP" },
];
export const slotOf = (w: Widget): Slot => SLOTS.find((s) => s.type === w.type && (s.type !== "NEW_ORDER_ALERT" || s.variant === w.props.variant))!;
export const widgetLabel = (w: Widget) => slotOf(w).label;

// 새로 켤 때의 자리(화면 대비 %). 세로형은 위쪽 40% 안
const DEFAULT_BOX: Record<Aspect, Record<WidgetType, [number, number, number, number]>> = {
  "9x16": {
    CURRENT_ORDER: [3, 2, 94, 10],
    QUEUE: [3, 13, 94, 18],
    HALL_OF_FAME: [3, 13, 46, 18],
    NOTICE: [3, 32, 94, 4],
    SHOP_INFO: [3, 32, 94, 4],
    OPEN_TIMER: [70, 2, 27, 6],
    NEW_ORDER_ALERT: [3, 20, 94, 10],
    EVENT_CARD: [3, 32, 94, 18],
    PURCHASE_RANKING: [50, 13, 47, 18],
  },
  "16x9": {
    CURRENT_ORDER: [2, 4, 26, 18],
    QUEUE: [2, 24, 26, 56],
    HALL_OF_FAME: [72, 4, 26, 52],
    NOTICE: [72, 60, 26, 20],
    SHOP_INFO: [2, 88, 26, 8],
    OPEN_TIMER: [72, 84, 26, 12],
    NEW_ORDER_ALERT: [2, 30, 26, 14],
    EVENT_CARD: [72, 56, 26, 14],
    PURCHASE_RANKING: [72, 4, 26, 40],
  },
};
export function newWidget(slot: Slot, aspect: Aspect, widgets: Widget[]): Widget {
  const [x, y, w, h] = DEFAULT_BOX[aspect][slot.type];
  const used = new Set(widgets.map((o) => o.id));
  let id = slot.key.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  for (let n = 2; used.has(id); n++) id = `${id.replace(/_\d+$/, "")}_${n}`;
  const z = Math.min(
    99,
    widgets.reduce((m, o) => Math.max(m, o.z + 1), 0),
  );
  return { id, type: slot.type, visible: true, x, y, w, h, z, props: slot.variant ? { variant: slot.variant, durationSec: 6 } : {} };
}

// 편집기 미리보기용 예시 데이터(OverlayView는 실제 데이터를 넣는다)
export type OrderEvent = { id: string; kind: "FIRST" | "REPEAT" | "VIP"; nickname: string; productLabel: string; quantity: number; moreItems: number; occurredAt: string };
// 공개 state의 eventCard(지금 마감이 가장 가까운 이벤트 상품 1개)·purchaseRanking(지금 방송 구매 수량 순위)
export type EventCardData = { productName: string; price: number; discountedPrice: number; discountRate: number | null; endsAt: string; remainingSeconds: number; badge: string | null; remainingLabel: string | null; moreCount: number };
export type RankingRow = { rank: number; nickname: string; quantity: number };
export type LiveData = {
  // 이벤트 할인 카드 위젯용(없으면 위젯을 그리지 않는다)
  eventCard?: EventCardData | null;
  // 구매 랭킹 위젯용(방송 중이 아니거나 비어 있으면 위젯을 그리지 않는다)
  purchaseRanking?: RankingRow[];
  // 쇼핑몰 정보 위젯용(공개 state의 shop)
  shop?: { name: string; url: string | null } | null;
  // 신규 주문 알림 위젯이 지금 보여 줄 주문(없으면 위젯을 그리지 않는다)
  alert?: OrderEvent | null;
  opening: { nickname: string; gradeSnapshot: string | null; productLabel: string; quantity: number; timerSeconds?: number | null; openingStartedAt?: string | null } | null;
  waiting: { id: string; nickname: string; productLabel: string; quantity: number }[];
  hits: { id: string; nickname: string; cardName: string }[];
  // 방금 새로 들어온 HIT 카드 id(명예의 전당에서 잠깐 강조)
  freshHitIds?: string[];
  live: boolean;
};
export const SAMPLE_NOW = Date.parse("2026-01-01T00:00:00.000Z");
export const SAMPLE_DATA: LiveData = {
  live: true,
  eventCard: { productName: "프리미엄 박스", price: 20000, discountedPrice: 15000, discountRate: 25, endsAt: "2026-01-01T01:30:00.000Z", remainingSeconds: 5400, badge: "오늘 마감", remainingLabel: "1시간 30분 남았어요", moreCount: 2 },
  purchaseRanking: [
    { rank: 1, nickname: "별빛하늘", quantity: 5 },
    { rank: 2, nickname: "달콤곰", quantity: 3 },
    { rank: 2, nickname: "민트초코", quantity: 3 },
    { rank: 4, nickname: "하루", quantity: 1 },
  ],
  shop: { name: "카드숍 별빛", url: "https://example.com/shop/starlight" },
  alert: { id: "sample", kind: "VIP", nickname: "별빛하늘", productLabel: "프리미엄 박스", quantity: 2, moreItems: 0, occurredAt: "2026-01-01T00:00:00.000Z" },
  opening: { nickname: "별빛하늘", gradeSnapshot: "VIP", productLabel: "프리미엄 박스", quantity: 2, timerSeconds: 90, openingStartedAt: null },
  waiting: [
    { id: "s1", nickname: "달콤곰", productLabel: "스타터 팩", quantity: 1 },
    { id: "s2", nickname: "민트초코", productLabel: "프리미엄 박스", quantity: 3 },
    { id: "s3", nickname: "하루", productLabel: "스타터 팩", quantity: 2 },
    { id: "s4", nickname: "구름빵", productLabel: "스페셜 팩", quantity: 1 },
  ],
  hits: [
    { id: "h1", nickname: "별빛하늘", cardName: "리자몽 SAR" },
    { id: "h2", nickname: "달콤곰", cardName: "피카츄 UR" },
    { id: "h3", nickname: "하루", cardName: "뮤츠 SR" },
  ],
};
