import type { PrismaClient } from "@prisma/client";
import { collectChats, purgeOldChats, type ChatReport } from "./chat";
import { defaultYoutubeClient, type YoutubeClient } from "./client";
import { purgeOldQuotaUsage } from "./quota";
import { SYNC_INTERVAL_MS, reportQuota, syncYoutube, type SyncReport } from "./sync";

// 유튜브 타이머(MASTER 결정 2026-10-05: 서버 프로세스 안 타이머). instrumentation.ts가 startYoutubeWorker를 부른다.
// - TICK_MS(10초)마다 돈다. 방송 상태 확인·새 방송 찾기·기록 정리는 SYNC_INTERVAL_MS(60초)마다, 채팅 수집은 방송별 다음 조회 시각이 된 것만(chat.ts).
// - SCHEDULER_DISABLED=1이거나 YOUTUBE_API_KEY가 없으면 시작하지 않는다(기능 꺼짐).
// - 배포 중 앱이 둘 떠도 한 인스턴스만 돌도록 매번 pg advisory xact lock을 잡는다(못 잡으면 이번 주기는 건너뜀).
// - 앞 주기가 끝나지 않았으면 겹쳐 돌지 않는다. 실패해도 앱은 계속 동작한다(로그만).
export const TICK_MS = 10_000;
const LOCK_KEY = "youtube_sync";
let running = false;

export type TickReport = { status: SyncReport | null; chat: ChatReport };

export async function runYoutubeSyncOnce(db: PrismaClient, client: YoutubeClient, now = new Date(), opts: { status?: boolean } = {}): Promise<TickReport | null> {
  if (running) return null;
  running = true;
  try {
    return await db.$transaction(
      async (tx) => {
        const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${LOCK_KEY})) AS "locked"`;
        if (!locked) return null;
        // 잠금은 이 트랜잭션이 끝날 때까지 유지된다. 작업 자체는 db로(각자 트랜잭션) 한다.
        let status: SyncReport | null = null;
        if (opts.status !== false) {
          status = await syncYoutube(db, client, now);
          await purgeOldQuotaUsage(db, now);
          await purgeOldChats(db, now);
        }
        return { status, chat: await collectChats(db, client, now) };
      },
      { timeout: SYNC_INTERVAL_MS - 5_000, maxWait: 10_000 },
    );
  } finally {
    running = false;
  }
}

export function startYoutubeWorker(db: PrismaClient, env: Record<string, string | undefined> = process.env): (() => void) | null {
  if (env.SCHEDULER_DISABLED === "1") return null;
  const client = defaultYoutubeClient();
  if (!client) return null;
  let lastStatusAt = 0;
  const tick = async () => {
    const now = new Date();
    const status = now.getTime() - lastStatusAt >= SYNC_INTERVAL_MS;
    try {
      const report = await runYoutubeSyncOnce(db, client, now, { status });
      if (report?.status) {
        lastStatusAt = now.getTime();
        await reportQuota(db, report.status.quotaRatio, now);
      }
    } catch (e) {
      console.error(`[youtube] sync failed: ${e instanceof Error ? e.message : e}`);
    }
  };
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}
