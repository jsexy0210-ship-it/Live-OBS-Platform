import { PrismaClient } from "@prisma/client";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";

// SA-057 유튜브 연결 e2e 준비(폐기용 테스트 DB). 실제 유튜브 호출 없이 채널·예정 방송 연결을 직접 만든다.
// 서버는 YOUTUBE_API_KEY(아무 값)와 SCHEDULER_DISABLED=1로 띄운다(키가 있어야 화면이 열리고, 타이머가 가짜 키로 유튜브를 부르지 않게).
const open = () => new PrismaClient({ datasources: { db: { url: assertTestDatabaseUrl(process.env.DATABASE_URL) } } });

export async function resetYoutube(slug = "demo-shop") {
  const db = open();
  try {
    const { id: sellerId } = await db.seller.findUniqueOrThrow({ where: { slug }, select: { id: true } });
    await db.youtubeChatMessage.deleteMany({ where: { sellerId } });
    await db.youtubeLiveLink.deleteMany({ where: { sellerId } });
    await db.youtubeChannelLink.deleteMany({ where: { sellerId } });
    return sellerId;
  } finally {
    await db.$disconnect();
  }
}

export async function seedYoutube(slug = "demo-shop") {
  const sellerId = await resetYoutube(slug);
  const db = open();
  try {
    await db.youtubeChannelLink.create({ data: { sellerId, channelId: "UCe2eChannel00000000000", title: "e2e 채널", uploadsPlaylistId: "UUe2eChannel00000000000" } });
    await db.youtubeLiveLink.create({ data: { sellerId, videoId: "e2eVideo001", title: "e2e 라이브", status: "UPCOMING" } });
    return sellerId;
  } finally {
    await db.$disconnect();
  }
}

// 연결 중(예정·진행 중)인 방송의 채팅 수집 값. 해제된 연결은 보지 않는다(null)
export async function chatEnabledInDb(slug = "demo-shop") {
  const db = open();
  try {
    const { id: sellerId } = await db.seller.findUniqueOrThrow({ where: { slug }, select: { id: true } });
    return (await db.youtubeLiveLink.findFirst({ where: { sellerId, status: { in: ["UPCOMING", "LIVE"] } }, select: { chatEnabled: true } }))?.chatEnabled ?? null;
  } finally {
    await db.$disconnect();
  }
}

// 지금 진행 중인 방송에 연결된 유튜브 방송을 붙이고, 그 방송 채팅에 닉네임이 한 번 나온 것으로 만든다(채팅 확인 표시 시험용)
export async function attachLiveAndChat(nickname: string, alsoInWindow: string[] = [], slug = "demo-shop") {
  const db = open();
  try {
    const { id: sellerId } = await db.seller.findUniqueOrThrow({ where: { slug }, select: { id: true } });
    const session = await db.broadcastSession.findFirstOrThrow({ where: { sellerId, status: "LIVE" }, select: { id: true } });
    const link = await db.youtubeLiveLink.findFirstOrThrow({ where: { sellerId, status: { in: ["UPCOMING", "LIVE"] } }, select: { id: true } });
    await db.youtubeLiveLink.update({ where: { id: link.id }, data: { broadcastSessionId: session.id } });
    // 채팅 확인은 방송 시간 안에 들어온 주문 닉네임만 본다(서버 규칙). 시험 주문은 방송 전에 만든 것이라 이 방송 안에 들어온 주문으로 맞춘다
    const item = await db.queueItem.findFirstOrThrow({ where: { sellerId, nicknameSnapshot: nickname }, select: { orderId: true } });
    await db.order.update({ where: { id: item.orderId }, data: { createdAt: new Date(), broadcastNicknameSnapshot: nickname } });
    // 이 방송 안에 들어온 주문이지만 채팅은 없는 경우(「채팅 없음」)
    for (const n of alsoInWindow) {
      const other = await db.queueItem.findFirstOrThrow({ where: { sellerId, nicknameSnapshot: n }, select: { orderId: true } });
      await db.order.update({ where: { id: other.orderId }, data: { createdAt: new Date(), broadcastNicknameSnapshot: n } });
    }
    await db.youtubeChatMessage.create({
      data: { sellerId, liveLinkId: link.id, messageId: `e2e-msg-${Date.now()}`, authorChannelId: "UCe2eAuthor", authorName: nickname, text: "안녕하세요", publishedAt: new Date() },
    });
  } finally {
    await db.$disconnect();
  }
}
