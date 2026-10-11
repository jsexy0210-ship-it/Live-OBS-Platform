import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_NAMES } from "../../../../../lib/server/auth/policy";
import { resolveBuyerSession } from "../../../../../lib/server/auth/session";
import { prisma } from "../../../../../lib/server/db";

export default async function SignupTermsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const seller = await prisma.seller.findUnique({ where: { slug }, select: { id: true } });
  if (seller && await resolveBuyerSession(prisma, (await cookies()).get(COOKIE_NAMES.buyer)?.value, seller.id)) {
    redirect(`/shop/${encodeURIComponent(slug)}`);
  }
  return null;
}
