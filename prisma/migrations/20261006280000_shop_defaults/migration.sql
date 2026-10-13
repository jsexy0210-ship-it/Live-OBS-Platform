-- 쇼핑몰 설정 기본값(대표님 지시 2026-10-06 「파트너스 쇼핑몰 가입 시 디폴트 값 지정」, docs/SHOP_DEFAULTS.md).
-- 쇼핑몰이 만들어질 때 설정 행을 기본값으로 만들고(lib/server/sellers/shopDefaults.ts), 기존 쇼핑몰은 행이 없는 곳에만 채운다.
-- 추가형: 이미 있는 행은 건드리지 않고(ON CONFLICT DO NOTHING / NOT EXISTS) 값은 칼럼 기본값(= 읽기 폴백과 같은 값)만 쓴다.

-- 주문 정책: 「실제로 저장한 시각」. 지금 있는 행은 온보딩 판정이 바뀌지 않게 갱신 시각을 그대로 옮긴다.
ALTER TABLE "SellerOrderPolicy" ADD COLUMN "savedAt" TIMESTAMPTZ(3);
UPDATE "SellerOrderPolicy" SET "savedAt" = "updatedAt";

-- 진열 영역: 진열 설정을 저장한 적 없는 쇼핑몰(설정 행이 없는 곳)에만 기본 영역 2개(추천 상품·신상품, 보임, 8개)를 만든다. 반드시 설정 행보다 먼저.
INSERT INTO "ShopDisplaySection" ("sellerId", "kind", "title", "visible", "itemCount", "sortOrder")
SELECT s."id", v."kind"::"ShopDisplayKind", v."title", true, 8, v."ord"
FROM "Seller" s
CROSS JOIN (VALUES ('RECOMMENDED', '추천 상품', 0), ('NEW', '신상품', 1)) AS v("kind", "title", "ord")
WHERE NOT EXISTS (SELECT 1 FROM "ShopDisplaySetting" d WHERE d."sellerId" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "ShopDisplaySection" x WHERE x."sellerId" = s."id");

INSERT INTO "ShopDisplaySetting" ("sellerId") SELECT "id" FROM "Seller" ON CONFLICT ("sellerId") DO NOTHING;
INSERT INTO "SellerShippingPolicy" ("sellerId") SELECT "id" FROM "Seller" ON CONFLICT ("sellerId") DO NOTHING;
INSERT INTO "SellerOrderPolicy" ("sellerId") SELECT "id" FROM "Seller" ON CONFLICT ("sellerId") DO NOTHING;
INSERT INTO "SellerMemberPolicy" ("sellerId") SELECT "id" FROM "Seller" ON CONFLICT ("sellerId") DO NOTHING;
INSERT INTO "SellerOrderNotificationPolicy" ("sellerId") SELECT "id" FROM "Seller" ON CONFLICT ("sellerId") DO NOTHING;
INSERT INTO "ProductReviewPolicy" ("sellerId") SELECT "id" FROM "Seller" ON CONFLICT ("sellerId") DO NOTHING;
INSERT INTO "ShopSeo" ("sellerId") SELECT "id" FROM "Seller" ON CONFLICT ("sellerId") DO NOTHING;
INSERT INTO "MemberGradePolicy" ("sellerId") SELECT "id" FROM "Seller" ON CONFLICT ("sellerId") DO NOTHING;
INSERT INTO "YoutubeSellerSetting" ("sellerId", "updatedAt") SELECT "id", now() FROM "Seller" ON CONFLICT ("sellerId") DO NOTHING;
