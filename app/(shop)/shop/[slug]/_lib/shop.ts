import { prisma } from "../../../../../lib/server/db";

// 쇼핑몰 주소(slug)로 운영 중인 쇼핑몰을 찾는다. 없거나 운영 중이 아니면 null(화면은 404).
export async function findActiveShop(slug: string) {
  const shop = await prisma.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true, slug: true, shopName: true, status: true, operatingState: true } });
  return shop && shop.status === "ACTIVE" ? shop : null;
}
