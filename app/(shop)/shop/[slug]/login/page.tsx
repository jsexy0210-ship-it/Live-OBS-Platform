import type { Metadata } from "next";
import { notFound } from "next/navigation";
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
  return (
    <>
      <LoginForm slug={shop.slug} next={next} />
    </>
  );
}
