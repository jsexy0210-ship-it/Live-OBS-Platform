import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { listSynonyms, replaceSynonyms, SYNONYM_MESSAGES } from "../../../../../lib/server/shop-search/service";

// 쇼핑몰 검색 유사어 묶음. 조회는 같은 쇼핑몰 파트너스 계정 누구나 { groups: [{ words }], canEdit }.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return noStore(NextResponse.json(await listSynonyms(prisma, ctx)));
  } catch (e) {
    return errorResponse(e);
  }
}

// 통째로 바꾸기. 본문 { groups: [{ words: [단어, …] }] }(최대 50묶음, 묶음당 2~10단어, 단어 20자). 대표자·상품 관리(PRODUCT_MANAGE) 직원만.
export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await replaceSynonyms(prisma, ctx, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: SYNONYM_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ groups: r.groups });
});
