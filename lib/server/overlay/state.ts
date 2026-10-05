import type { PrismaClient } from "@prisma/client";

// 오버레이(방송 화면)에 내보내는 최소 필드. 회원 id·휴대폰·주문 금액·주문 id는 보내지 않는다.
const PUBLIC_FIELDS = {
  id: true,
  status: true,
  position: true,
  nicknameSnapshot: true,
  gradeSnapshot: true,
  productLabel: true,
  quantity: true,
  timerSeconds: true,
  openingStartedAt: true,
} as const;

const MAX_NICKNAME = 20;

// 방송 화면 노출용 닉네임 정리: 제어 문자·양방향 제어 문자(Bidi_Control 전체)·폭 없는 문자 제거, 공백 정리, 길이 제한.
export function overlayNickname(raw: string): string {
  const clean = raw
    .replace(/[\t\n\r]/g, " ")
    .replace(/[\p{Cc}\p{Bidi_Control}\u200b-\u200d\ufeff]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(clean);
  return chars.length > MAX_NICKNAME ? chars.slice(0, MAX_NICKNAME).join("") + "…" : clean;
}

type Row = { [K in keyof typeof PUBLIC_FIELDS]: unknown } & { nicknameSnapshot: string };

function toPublic(row: Row) {
  const { nicknameSnapshot, ...rest } = row;
  return { ...rest, nickname: overlayNickname(nicknameSnapshot) };
}

// 신규 주문 알림: 방송 중 최근 30초에 들어온 주문(주문대기 항목 기준, 취소 제외)을 최근 순 10건.
// 방송 시작 전에 들어와 방송에 붙은 주문은 새 주문이 아니므로 빼고, 방송 시작 뒤에 들어온 것만 센다.
// 한 주문에 품목이 여럿이면 한 건으로 묶는다(첫 품목 이름, 수량 합, 나머지 품목 수). 주문 id는 내보내지 않고 첫 주문대기 항목 id를 쓴다.
// kind: 구매자 등급이 기본 VIP 등급이면 VIP, 아니면 이 쇼핑몰에 이 주문보다 먼저 결제한 주문이 있으면 REPEAT, 없으면 FIRST.
export const ORDER_EVENT_WINDOW_MS = 30_000;
export const ORDER_EVENT_MAX = 10;
// 명예의 전당: 지금 방송의 HIT 카드 최근 등록 순 10건(화면은 위젯 rows만큼 자른다)
export const HALL_MAX = 10;

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

async function recentOrderEvents(tx: Tx, sellerId: string, live: { id: string; startedAt: Date }) {
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  const items = await tx.queueItem.findMany({
    where: {
      sellerId,
      broadcastSessionId: live.id,
      status: { not: "CANCELLED" },
      receivedAt: { gte: new Date(Math.max(now.getTime() - ORDER_EVENT_WINDOW_MS, live.startedAt.getTime())) },
    },
    orderBy: [{ receivedAt: "desc" }, { position: "asc" }],
    take: 100,
    select: { id: true, orderId: true, externalOrderId: true, nicknameSnapshot: true, productLabel: true, quantity: true, receivedAt: true, position: true },
  });
  // 같은 주문의 줄은 한 이벤트로 묶는다. 외부 쇼핑몰 주문(orderId 없음)은 외부 주문 id로 묶고 「처음」 표시로 보낸다(회원 등급·재구매 정보 없음)
  const byOrder = new Map<string, typeof items>();
  for (const it of items) {
    const key = it.orderId ?? `ext:${it.externalOrderId}`;
    const list = byOrder.get(key);
    if (list) list.push(it);
    else if (byOrder.size < ORDER_EVENT_MAX) byOrder.set(key, [it]);
  }
  const orders = await tx.order.findMany({
    where: { sellerId, id: { in: [...byOrder.keys()].filter((k) => !k.startsWith("ext:")) } },
    select: { id: true, buyerMemberId: true, paidAt: true, buyerMember: { select: { grade: { select: { systemKey: true } } } } },
  });
  const info = new Map(orders.map((o) => [o.id, o]));
  const events = [];
  for (const [orderId, list] of byOrder) {
    const o = info.get(orderId);
    if (!o && !orderId.startsWith("ext:")) continue;
    list.sort((a, b) => a.position - b.position);
    let kind: "FIRST" | "REPEAT" | "VIP" = "FIRST";
    if (!o) {
      // 외부 쇼핑몰 주문: 등급·재구매를 알 수 없어 「처음」으로 둔다
    } else if (o.buyerMember.grade.systemKey === "VIP") kind = "VIP";
    else if (o.paidAt) {
      const earlier = await tx.order.findFirst({ where: { sellerId, buyerMemberId: o.buyerMemberId, id: { not: o.id }, paidAt: { lt: o.paidAt } }, select: { id: true } });
      if (earlier) kind = "REPEAT";
    }
    events.push({
      id: list[0].id,
      kind,
      nickname: overlayNickname(list[0].nicknameSnapshot),
      productLabel: list[0].productLabel,
      quantity: list.reduce((n, i) => n + i.quantity, 0),
      moreItems: list.length - 1,
      occurredAt: list[0].receivedAt,
    });
  }
  return events;
}

export async function getOverlayState(db: PrismaClient, sellerId: string, opts: { origin?: URL | null } = {}) {
  return db.$transaction(
    async (tx) => {
      const seller = await tx.seller.findUniqueOrThrow({ where: { id: sellerId }, select: { liveVersion: true, shopName: true, slug: true } });
      const live = await tx.broadcastSession.findFirst({ where: { sellerId, status: "LIVE" }, select: { id: true, startedAt: true } });
      const opening = await tx.queueItem.findFirst({ where: { sellerId, status: "OPENING" }, select: PUBLIC_FIELDS });
      const waiting = live
        ? await tx.queueItem.findMany({
            where: { sellerId, broadcastSessionId: live.id, status: "WAITING" },
            orderBy: [{ position: "asc" }, { receivedAt: "asc" }],
            take: 50,
            select: PUBLIC_FIELDS,
          })
        : [];
      const hits = live
        ? await tx.hitCard.findMany({
            where: { sellerId, broadcastSessionId: live.id },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: HALL_MAX,
            select: { id: true, cardName: true, nicknameSnapshot: true, createdAt: true },
          })
        : [];
      const path = `/shop/${encodeURIComponent(seller.slug)}`;
      return {
        version: seller.liveVersion,
        live: !!live,
        // 공개 쇼핑몰 주소. 요청 주소를 알 수 없으면(이상한 Host) url은 null
        shop: { name: seller.shopName, url: opts.origin ? new URL(path, opts.origin).toString() : null },
        opening: opening ? toPublic(opening) : null,
        waiting: waiting.map(toPublic),
        hits: hits.map(({ nicknameSnapshot, ...h }) => ({ ...h, nickname: overlayNickname(nicknameSnapshot) })),
        orderEvents: live ? await recentOrderEvents(tx, sellerId, live) : [],
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}
