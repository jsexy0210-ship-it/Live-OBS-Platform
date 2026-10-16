import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ProfileView from "../../../../../../components/shop/ProfileView";
import { prisma } from "../../../../../../lib/server/db";
import { findActiveShop } from "../../_lib/shop";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "회원정보 수정" };

// SH-024 회원정보 수정. 본인 정보 조회·닉네임·비밀번호·탈퇴는 잠긴 쇼핑몰에서도 열린다(API me/profile·nickname·password·withdraw와 같은 기준).
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const shop = await findActiveShop((await params).slug);
  if (!shop) notFound();
  const s = await prisma.seller.findUnique({ where: { id: shop.id }, select: { shopName: true } });
  return <ProfileView slug={shop.slug} shopName={s?.shopName ?? ""} />;
}
