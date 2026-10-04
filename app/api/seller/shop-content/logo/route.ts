import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { readBodyLimited } from "../../../../../lib/server/branding/image";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, noStore, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { LOGO_MAX_BYTES, LOGO_MESSAGES, deleteLogo, putLogo, readLogo } from "../../../../../lib/server/shop-content/logo";

// 쇼핑몰 로고(SA-060 쇼핑몰 정보). GET은 같은 쇼핑몰 계정 누구나, PUT(파일 바이트 그대로)·DELETE는 대표자·「쇼핑몰 설정」 직원만(그 밖 403).
// PNG만, 2MB 이하(넘으면 끝까지 받지 않고 413), 정사각형 512~1440px. 플랜 기능 STORE_OPERATIONS.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return noStore(NextResponse.json({ logo: await readLogo(prisma, ctx) }));
  } catch (e) {
    return errorResponse(e);
  }
}

export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const bytes = await readBodyLimited(req, LOGO_MAX_BYTES);
  if (!bytes) return NextResponse.json({ error: "file_too_large", message: LOGO_MESSAGES.file_too_large }, { status: 413 });
  const r = await putLogo(prisma, ctx, bytes, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: LOGO_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ logo: r.logo });
});

export const DELETE = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  await deleteLogo(prisma, ctx, requestMeta(req));
  return NextResponse.json({ logo: null });
});
