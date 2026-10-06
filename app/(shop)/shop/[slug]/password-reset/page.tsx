import type { Metadata } from "next";
import { notFound } from "next/navigation";
import PasswordResetForm from "../../../../../components/shop/PasswordResetForm";
import { findActiveShop } from "../_lib/shop";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ token?: string }> };

// 메일 링크의 토큰이 다른 사이트로 새지 않게 리퍼러를 보내지 않는다.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const shop = await findActiveShop((await params).slug);
  return { title: shop ? `비밀번호 찾기 · ${shop.shopName}` : "비밀번호 찾기", referrer: "no-referrer" };
}

// SH-012 비밀번호 찾기. 토큰 없이 열면 재설정 메일 요청, 메일 링크(?token=)로 열면 새 비밀번호 설정.
export default async function ShopPasswordResetPage({ params, searchParams }: Props) {
  const shop = await findActiveShop((await params).slug);
  if (!shop) notFound();
  const token = (await searchParams).token;
  return <PasswordResetForm slug={shop.slug} token={typeof token === "string" && token ? token : null} />;
}
