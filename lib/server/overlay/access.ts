import type { PrismaClient } from "@prisma/client";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import { hashToken } from "../auth/token";
import { openStreamCount } from "../realtime/sse";
import { liveBroadcastState } from "../broadcast/stale";
import { OVERLAY_ONLINE_MS } from "./token";

// 방송 화면 주소 정보(SA-052): 발급일·마지막 접속·연결됨 상태·접속 기록·재발급 이력. 토큰 원문·해시는 돌려주지 않는다(발급 때 한 번만 보여 주는 현행 유지).
// - 접속 기록은 화면을 열 때(레이아웃 요청) 남긴다. 같은 환경·레이아웃이 10분 안에 다시 열면 새로 남기지 않고, 판매자당 최근 100건만 보관한다.
// - 환경 이름은 사용자 에이전트에서 읽기 쉽게 줄인 것(「OBS 30.1 · Windows」·「Chrome · macOS」). 원문은 저장하지 않는다.
// - 상태: 연결 중(connected) = 가장 최근 접속이고 지금 주소가 쓰이는 중 · 종료(ended) · 미확인 브라우저(unknown_browser) = OBS가 아닌 환경에서 연 접속.
export const ACCESS_KEEP = 100;
export const ACCESS_LIST = 20;
export const ACCESS_DEDUPE_MS = 10 * 60_000;

export function parseClient(ua: string | null | undefined): { client: string; isObs: boolean; short: string } {
  const u = (ua ?? "").slice(0, 400);
  const os = /Windows/.test(u) ? "Windows" : /Android/.test(u) ? "Android" : /iPhone|iPad|iOS/.test(u) ? "iOS" : /Mac OS X|Macintosh/.test(u) ? "macOS" : /Linux/.test(u) ? "Linux" : null;
  const obs = u.match(/\bOBS\/(\d+(?:\.\d+)?)/);
  if (obs) return { client: ["OBS " + obs[1], os].filter(Boolean).join(" · "), isObs: true, short: "OBS" };
  const name = /Edg\//.test(u) ? "Edge" : /Firefox\//.test(u) ? "Firefox" : /Chrome\//.test(u) ? "Chrome" : /Safari\//.test(u) ? "Safari" : null;
  const short = name ?? "알 수 없음";
  return { client: [short, os].filter(Boolean).join(" · "), isObs: false, short };
}

// 방송 화면을 열 때 호출(레이아웃 요청). 실패해도 화면 응답을 막지 않는다.
export async function recordOverlayAccess(db: PrismaClient, token: string, ua: string | null, layout: string, now = new Date()): Promise<void> {
  try {
    const row = await db.overlayToken.findUnique({ where: { tokenHash: hashToken(token) }, select: { id: true, sellerId: true, revokedAt: true } });
    if (!row || row.revokedAt) return;
    const c = parseClient(ua);
    const last = await db.overlayAccess.findFirst({ where: { tokenId: row.id }, orderBy: [{ at: "desc" }, { id: "desc" }] });
    if (last && last.client === c.client && last.layout === layout && now.getTime() - last.at.getTime() < ACCESS_DEDUPE_MS) return;
    await db.overlayAccess.create({ data: { sellerId: row.sellerId, tokenId: row.id, at: now, client: c.client, isObs: c.isObs, layout } });
    const old = await db.overlayAccess.findMany({ where: { sellerId: row.sellerId }, orderBy: [{ at: "desc" }, { id: "desc" }], skip: ACCESS_KEEP, select: { id: true } });
    if (old.length > 0) await db.overlayAccess.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  } catch {
    // 기록 실패는 무시
  }
}

export async function overlayAddressInfo(db: PrismaClient, ctx: TenantContext, now = new Date()) {
  requireSellerRead(ctx, "OVERLAY_EDIT");
  const [current, tokens, accesses, live] = await Promise.all([
    db.overlayToken.findFirst({ where: { sellerId: ctx.sellerId, revokedAt: null }, select: { id: true, tokenHash: true, createdAt: true, lastSeenAt: true } }),
    db.overlayToken.findMany({ where: { sellerId: ctx.sellerId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: ACCESS_LIST, select: { id: true, createdAt: true, issuedByName: true } }),
    db.overlayAccess.findMany({ where: { sellerId: ctx.sellerId }, orderBy: [{ at: "desc" }, { id: "desc" }], take: ACCESS_LIST, select: { id: true, tokenId: true, at: true, client: true, isObs: true, layout: true } }),
    liveBroadcastState(db, ctx.sellerId, now),
  ]);
  const earliest = await db.overlayToken.findFirst({ where: { sellerId: ctx.sellerId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } });
  const online = !!current?.lastSeenAt && now.getTime() - current.lastSeenAt.getTime() < OVERLAY_ONLINE_MS;
  const openSources = current ? openStreamCount(`overlay:${current.tokenHash}`) : 0;
  const latest = accesses[0] ?? null;
  return {
    issuedAt: current?.createdAt ?? null,
    lastAccessAt: current?.lastSeenAt ?? null,
    lastClient: latest ? (latest.isObs ? "OBS" : latest.client.split(" · ")[0]) : null,
    connected: online,
    openSources,
    // 방송 중이라 재발급할 수 없는지(SA-052 「방송 중에는 재발급할 수 없습니다」). LIVE 방송이 있어도 방송 화면 접속 신호가 5분 넘게 없으면 false(broadcast/stale.ts)
    live: live.active,
    // LIVE 상태 방송이 남아 있는지(신호 유무와 무관, 안내용)
    liveSession: live.live,
    accesses: accesses.map((a, i) => ({
      at: a.at,
      client: a.client,
      layout: a.layout === "9x16" || a.layout === "16x9" ? a.layout : null,
      state: !a.isObs ? ("unknown_browser" as const) : i === 0 && a.tokenId === current?.id && online ? ("connected" as const) : ("ended" as const),
    })),
    reissues: tokens.map((t) => ({ at: t.createdAt, by: t.issuedByName, kind: t.id === earliest?.id ? ("first" as const) : ("reissue" as const) })),
  };
}
