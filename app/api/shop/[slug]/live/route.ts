import { NextResponse } from "next/server";
import { prisma } from "../../../../../lib/server/db";
import { shopLiveStatus } from "../../../../../lib/server/shop/live";

// 지금 방송 중인지(홈 상단 띠·LIVE 배지용, 로그인 없이): { live, title, startedAt, watchUrl }.
// watchUrl은 유튜브 방송 연결이 진행 중일 때만(아니면 null), 방송 중이 아니면 live=false에 나머지는 null. 운영 중이 아닌 쇼핑몰은 404. 15초 캐시.
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const r = await shopLiveStatus(prisma, (await params).slug);
  if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(r, { headers: { "cache-control": "public, max-age=15" } });
}
