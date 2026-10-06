import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { COOKIE_NAMES } from "../../../../../lib/server/auth/policy";
import { resolveBuyerSession } from "../../../../../lib/server/auth/session";
import { prisma } from "../../../../../lib/server/db";
import LoginForm from "../../../../../components/shop/LoginForm";
import { findActiveShop } from "../_lib/shop";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ next?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const shop = await findActiveShop((await params).slug);
  return { title: shop ? `로그인 · ${shop.shopName}` : "로그인" };
}

// SH-010 구매자 로그인. 로그인 뒤 돌아갈 곳(next)은 같은 쇼핑몰 안 경로만 받는다(다른 사이트로 보내지 않음).
export default async function ShopLoginPage({ params, searchParams }: Props) {
  const shop = await findActiveShop((await params).slug);
  if (!shop) notFound();
  const raw = (await searchParams).next;
  const base = `/shop/${encodeURIComponent(shop.slug)}`;
  const next = typeof raw === "string" && (raw === base || raw.startsWith(`${base}/`)) && !raw.includes("//", 1) && !raw.includes("\\") ? raw : null;
  // 이미 로그인했으면 로그인 화면을 건너뛴다(뒤로 가기로 다시 열려도 머무르지 않음)
  const session = await resolveBuyerSession(prisma, (await cookies()).get(COOKIE_NAMES.buyer)?.value, shop.id);
  if (session) redirect(next ?? base);
  return (
    <>
      <LoginForm slug={shop.slug} shopName={shop.shopName} next={next} />
    </>
  );
}
