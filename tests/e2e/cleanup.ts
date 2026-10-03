import { request } from "@playwright/test";

// e2e가 만든 상품을 테스트가 끝날 때 지운다. 같은 폐기용 DB에서 여러 번 돌려도 상품이 쌓이지 않게 한다
// (쌓이면 데모 상품이 상품 목록 첫 쪽 밖으로 밀려 목록 테스트가 깨진다).
// RUN: 실행마다 다른 표식. 만드는 상품 이름에 넣고, 이름을 track()으로 남겨 두면 cleanupProducts()가 지운다.
export const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const created = new Set<string>();
export const track = (name: string) => {
  created.add(name);
  return name;
};

type Page = { products: { id: string; name: string }[]; nextCursor: string | null };

export async function cleanupProducts(password: string, email = "demo-owner@example.com") {
  if (created.size === 0) return;
  const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3100";
  // 상태를 바꾸는 요청은 서버가 Origin을 확인한다
  const ctx = await request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
  try {
    const login = await ctx.post("/api/seller/auth/login", { data: { email, password } });
    if (!login.ok()) throw new Error(`e2e 상품 정리: 로그인 실패(${login.status()})`);
    let cursor: string | null = null;
    const ids: string[] = [];
    do {
      const res = await ctx.get(`/api/seller/products?limit=200${cursor ? `&cursor=${cursor}` : ""}`);
      if (!res.ok()) throw new Error(`e2e 상품 정리: 목록 실패(${res.status()})`);
      const page = (await res.json()) as Page;
      ids.push(...page.products.filter((p) => created.has(p.name)).map((p) => p.id));
      cursor = page.nextCursor;
    } while (cursor);
    for (const id of ids) {
      const del = await ctx.delete(`/api/seller/products/${id}`);
      if (!del.ok()) throw new Error(`e2e 상품 정리: 삭제 실패(${del.status()})`);
    }
    created.clear();
  } finally {
    await ctx.dispose();
  }
}
