import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NoticeDetail } from "../../../../components/public/NoticeDetail";
import { prisma } from "../../../../lib/server/db";
import { getNotice } from "../../../../lib/server/platform-notices/service";
import { noticeListHref } from "../../../../components/public/noticeView";

export const metadata: Metadata = { title: "공지 · 스트림샵" };
export const dynamic = "force-dynamic";

// PF-006 공지 상세. 없는·임시 저장·삭제·파트너스 전용 공지는 공통 404.
type Search = { page?: string | string[]; pageSize?: string | string[]; cursor?: string | string[]; category?: string | string[] };
const first = (v: string | string[] | undefined) => Array.isArray(v) ? v[0] ?? null : v ?? null;

export default async function NoticePage({ params, searchParams }: { params: Promise<{ noticeId: string }>; searchParams: Promise<Search> }) {
  const n = await getNotice(prisma, "public", (await params).noticeId).catch(() => null);
  if (!n || !("author" in n)) notFound();
  const q = await searchParams;
  const pageRaw = first(q.page);
  const pageSizeRaw = first(q.pageSize);
  const page = pageRaw && /^\d+$/.test(pageRaw) ? Number(pageRaw) : 1;
  const size = pageSizeRaw && /^\d+$/.test(pageSizeRaw) ? Number(pageSizeRaw) : 5;
  const state = {
    category: first(q.category),
    cursor: !pageRaw && !pageSizeRaw ? first(q.cursor) : null,
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize: Number.isSafeInteger(size) && size >= 1 && size <= 20 ? size : 5,
  };
  return <NoticeDetail notice={n} listHref={noticeListHref(state)} listState={state} />;
}
