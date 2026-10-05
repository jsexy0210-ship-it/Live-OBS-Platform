import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { MAX_IMPORT_CHARS, bulkErrorBody, bulkFailureStatus, previewProductImport } from "../../../../../../lib/server/shop-bulk-io/service";

// 상품 일괄 등록 미리보기(PRODUCT_MANAGE). 본문: { csv(파일 내용, 1MB까지), fileName? } 또는 Content-Type text/csv 본문.
// 상품은 만들지 않고 검증만 해 작업(jobId)을 남긴다(1시간 안에 확정). 응답 { jobId, totalRows, productCount, skippedProductCount, errorTotal, errors: [{ row, column, message }], products }.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_IMPORT_CHARS * 4) return noStore(NextResponse.json(bulkErrorBody("file_too_large"), { status: 413 }));
  const body = (req.headers.get("content-type") ?? "").includes("text/csv")
    ? { csv: await req.text(), fileName: req.headers.get("x-file-name") ?? undefined }
    : await readJson<{ csv: unknown; fileName: unknown }>(req);
  const r = await previewProductImport(prisma, ctx, { csv: body.csv, fileName: body.fileName });
  if (!r.ok) return noStore(NextResponse.json(bulkErrorBody(r.reason), { status: bulkFailureStatus(r.reason) }));
  return noStore(NextResponse.json(r.value, { status: 201 }));
});
