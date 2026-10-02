import type { PrismaClient } from "@prisma/client";

// 커밋 뒤 「바뀌었다 + version」만 알린다. NOTIFY는 빠른 알림일 뿐 정본이 아니므로 실패해도 변경은 유지된다
// (화면은 재연결·15초 주기 version 확인으로 맞춘다, docs/ARCHITECTURE.md 6절).
export const LIVE_CHANNEL = "live_obs";

export async function notifySellerChanged(db: PrismaClient, sellerId: string, version: number): Promise<void> {
  try {
    await db.$executeRaw`SELECT pg_notify(${LIVE_CHANNEL}, ${JSON.stringify({ sellerId, version })})`;
  } catch (e) {
    console.error("pg_notify 실패", e);
  }
}
