import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { XLSX_MAX_BYTES } from "../../../../../../lib/server/shop-bulk-io/xlsx";
import { MAX_IMPORT_CHARS, bulkErrorBody, bulkFailureStatus, previewProductImport, previewProductImportXlsx } from "../../../../../../lib/server/shop-bulk-io/service";

// 상품 일괄 등록 미리보기(PRODUCT_MANAGE). 본문: { csv(파일 내용, 1MB까지), fileName? } 또는 Content-Type text/csv 본문,
// 또는 엑셀(.xlsx, 5MB까지): multipart/form-data의 file 칸, 또는 Content-Type application/vnd.openxmlformats-officedocument.spreadsheetml.sheet 본문(파일 이름은 X-File-Name 머리글).
// 엑셀은 첫 시트의 첫 줄이 열 이름이다(양식 열은 CSV와 같음). 형식이 틀리면 400 invalid_xlsx, 5MB를 넘으면 413 xlsx_too_large.
// 상품은 만들지 않고 검증만 해 작업(jobId)을 남긴다(1시간 안에 확정). 응답 { jobId, totalRows, productCount, skippedProductCount, errorTotal, errors: [{ row, column, message }], products }.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const type = req.headers.get("content-type") ?? "";
  const isXlsx = type.includes("spreadsheetml.sheet") || type.includes("multipart/form-data");
  const length = Number(req.headers.get("content-length") ?? 0);
  if (isXlsx && length > XLSX_MAX_BYTES + 64 * 1024) return noStore(NextResponse.json(bulkErrorBody("xlsx_too_large"), { status: 413 }));
  if (!isXlsx && length > MAX_IMPORT_CHARS * 4) return noStore(NextResponse.json(bulkErrorBody("file_too_large"), { status: 413 }));
  if (isXlsx) {
    let bytes: Buffer;
    let fileName: string | undefined;
    if (type.includes("multipart/form-data")) {
      const file = (await req.formData().catch(() => null))?.get("file");
      if (!file || typeof file === "string") return noStore(NextResponse.json(bulkErrorBody("invalid_xlsx"), { status: 400 }));
      if (file.size > XLSX_MAX_BYTES) return noStore(NextResponse.json(bulkErrorBody("xlsx_too_large"), { status: 413 }));
      bytes = Buffer.from(await file.arrayBuffer());
      fileName = file.name;
    } else {
      bytes = Buffer.from(await req.arrayBuffer());
      fileName = req.headers.get("x-file-name") ? decodeURIComponent(req.headers.get("x-file-name")!) : undefined;
    }
    const x = await previewProductImportXlsx(prisma, ctx, { bytes, fileName });
    if (!x.ok) return noStore(NextResponse.json(bulkErrorBody(x.reason), { status: bulkFailureStatus(x.reason) }));
    return noStore(NextResponse.json(x.value, { status: 201 }));
  }
  const body = type.includes("text/csv")
    ? { csv: await req.text(), fileName: req.headers.get("x-file-name") ?? undefined }
    : await readJson<{ csv: unknown; fileName: unknown }>(req);
  const r = await previewProductImport(prisma, ctx, { csv: body.csv, fileName: body.fileName });
  if (!r.ok) return noStore(NextResponse.json(bulkErrorBody(r.reason), { status: bulkFailureStatus(r.reason) }));
  return noStore(NextResponse.json(r.value, { status: 201 }));
});
