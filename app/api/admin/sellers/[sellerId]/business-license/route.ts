import { NextResponse } from "next/server";
import { writeAudit } from "../../../../../../lib/server/audit/log";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 가입 신청 사업자등록증 보기·내려받기(MA-013 「등록증」 행). 최고관리자·운영만(seller.moderate, 그 밖의 역할 403).
// 파일 바이트를 그대로 준다. 기본은 화면에서 보기(inline), ?download=1이면 내려받기(attachment). 열람은 로그 추적(seller.business_license.view)에 남는다.
// 응답은 항상 nosniff·캐시 안 함·sandbox CSP로 보내 브라우저가 파일 안의 내용을 실행하지 못하게 한다. 404 not_found(신청·파일 없음).
export async function GET(req: Request, { params }: { params: Promise<{ sellerId: string }> }) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "seller.moderate");
    const { sellerId } = await params;
    if (!UUID.test(sellerId)) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
    const row = await prisma.sellerBusinessLicense.findUnique({ where: { sellerId } });
    if (!row) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
    const download = new URL(req.url).searchParams.get("download") === "1";
    await writeAudit(prisma, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.admin.id,
      sellerId,
      action: "seller.business_license.view",
      targetType: "SellerBusinessLicense",
      targetId: row.id,
      after: { fileName: row.fileName, download },
      ...requestMeta(req),
    });
    const disposition = `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(row.fileName)}`;
    return new Response(new Uint8Array(row.data), {
      headers: {
        "content-type": row.mimeType,
        "content-length": String(row.byteSize),
        "content-disposition": disposition,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
