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

export async function getOverlayState(db: PrismaClient, sellerId: string) {
  return db.$transaction(
    async (tx) => {
      const seller = await tx.seller.findUniqueOrThrow({ where: { id: sellerId }, select: { liveVersion: true } });
      const live = await tx.broadcastSession.findFirst({ where: { sellerId, status: "LIVE" }, select: { id: true } });
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
            orderBy: { createdAt: "desc" },
            take: 10,
            select: { id: true, cardName: true, nicknameSnapshot: true, createdAt: true },
          })
        : [];
      return {
        version: seller.liveVersion,
        live: !!live,
        opening: opening ? toPublic(opening) : null,
        waiting: waiting.map(toPublic),
        hits: hits.map(({ nicknameSnapshot, ...h }) => ({ ...h, nickname: overlayNickname(nicknameSnapshot) })),
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}
