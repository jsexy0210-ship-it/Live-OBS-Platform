import { notFound, redirect } from "next/navigation";
import { prisma } from "../../../../../../lib/server/db";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }>; searchParams: Promise<{ item?: string; review?: string }> };

// SH-029는 리뷰 쓰기·고치기가 「내 리뷰」 한 화면이라, 예전 주소(?item · ?review)는 그리로 보낸다.
export default async function ShopReviewWritePage({ params, searchParams }: Params) {
  const slug = (await params).slug;
  const shop = await prisma.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { slug: true, status: true } });
  if (!shop || shop.status !== "ACTIVE") notFound();
  const q = await searchParams;
  const qs = typeof q.item === "string" ? `?item=${encodeURIComponent(q.item)}` : typeof q.review === "string" ? `?review=${encodeURIComponent(q.review)}` : "";
  redirect(`/shop/${encodeURIComponent(shop.slug)}/reviews${qs}`);
}
