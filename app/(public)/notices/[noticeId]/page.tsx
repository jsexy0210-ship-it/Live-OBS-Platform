import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NoticeDetail } from "../../../../components/public/NoticeDetail";
import { prisma } from "../../../../lib/server/db";
import { getNotice } from "../../../../lib/server/platform-notices/service";

export const metadata: Metadata = { title: "공지 · ONQ" };
export const dynamic = "force-dynamic";

// PF-006 공지 상세. 없는·임시 저장·삭제·파트너스 전용 공지는 공통 404.
export default async function NoticePage({ params }: { params: Promise<{ noticeId: string }> }) {
  const n = await getNotice(prisma, "public", (await params).noticeId).catch(() => null);
  if (!n) notFound();
  return <NoticeDetail notice={n} />;
}
