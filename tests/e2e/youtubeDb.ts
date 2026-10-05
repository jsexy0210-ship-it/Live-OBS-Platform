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
