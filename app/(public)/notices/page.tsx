import type { Metadata } from "next";
import { Notices } from "../../../components/public/Notices";
import { prisma } from "../../../lib/server/db";
import { listNotices } from "../../../lib/server/platform-notices/service";

export const metadata: Metadata = { title: "공지 · ONQ", description: "ONQ 서비스 소식과 점검·정책 안내예요." };
export const dynamic = "force-dynamic";

// PF-005 공지 목록(로그인 없음). 공개·전체 대상의 게시 공지만 서버에서 읽는다.
export default async function NoticesPage({ searchParams }: { searchParams: Promise<{ cursor?: string | string[] }> }) {
  const cursor = (await searchParams).cursor;
  const r = await listNotices(prisma, "public", { cursor: typeof cursor === "string" ? cursor : null }).catch(() => null);
  if (!r || !r.ok) return <Notices pinned={[]} items={[]} nextCursor={null} failed />;
  return <Notices pinned={r.pinned} items={r.items} nextCursor={r.nextCursor} />;
}
