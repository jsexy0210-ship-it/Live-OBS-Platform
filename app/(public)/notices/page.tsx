import type { Metadata } from "next";
import { Notices } from "../../../components/public/Notices";
import { prisma } from "../../../lib/server/db";
import { listNotices, listPublicNoticesPage, parsePublicNoticePagination } from "../../../lib/server/platform-notices/service";

export const metadata: Metadata = { title: "공지 · 스트림샵", description: "스트림샵 서비스 소식과 점검·정책 안내예요" };
export const dynamic = "force-dynamic";

// PF-005 공지 목록(로그인 없음). 공개·전체 대상의 게시 공지만 서버에서 읽는다.
type Search = { page?: string | string[]; pageSize?: string | string[]; cursor?: string | string[]; category?: string | string[] };
const first = (v: string | string[] | undefined) => Array.isArray(v) ? v[0] ?? null : v ?? null;

export default async function NoticesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const cursor = first(params.cursor);
  const category = first(params.category);
  const pageParam = first(params.page);
  const pageSizeParam = first(params.pageSize);

  // 기존 cursor 링크도 계속 연다. 신규 화면 분류·페이지 이동은 번호 페이지 계약을 쓴다.
  if (cursor && !pageParam && !pageSizeParam) {
    const r = await listNotices(prisma, "public", { cursor, category }).catch(() => null);
    if (!r || !r.ok) return <Notices pinned={[]} items={[]} nextCursor={null} category={category} failed />;
    return <Notices pinned={r.pinned} items={r.items} nextCursor={r.nextCursor} category={category} cursor={cursor} />;
  }
  if (cursor) return <Notices pinned={[]} items={[]} nextCursor={null} category={category} failed />;

  const pagination = parsePublicNoticePagination(pageParam, pageSizeParam);
  if (!pagination.ok) return <Notices pinned={[]} items={[]} nextCursor={null} category={category} failed />;
  const r = await listPublicNoticesPage(prisma, pagination.page, pagination.pageSize, category).catch(() => null);
  if (!r) return <Notices pinned={[]} items={[]} nextCursor={null} category={category} page={pagination.page} pageSize={pagination.pageSize} failed />;
  return <Notices {...r} category={category} nextCursor={null} />;
}
