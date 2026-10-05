-- 전환 단계 통계(상품 상세 → 장바구니 → 주문 → 결제, 대표님 결정 2026-10-05 A안): 로그인 회원의 조회·담기만 일(KST) 단위로 센다.
CREATE TABLE "ProductFunnelDaily" (
    "sellerId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "cartAdds" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductFunnelDaily_pkey" PRIMARY KEY ("sellerId","productId","day")
);

CREATE TABLE "ProductFunnelSeen" (
    "sellerId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "kind" CHAR(1) NOT NULL,
    "viewerHash" TEXT NOT NULL,

    CONSTRAINT "ProductFunnelSeen_pkey" PRIMARY KEY ("sellerId","productId","day","kind","viewerHash")
);

CREATE INDEX "ProductFunnelDaily_sellerId_day_idx" ON "ProductFunnelDaily"("sellerId", "day");
CREATE INDEX "ProductFunnelSeen_day_idx" ON "ProductFunnelSeen"("day");

ALTER TABLE "ProductFunnelDaily" ADD CONSTRAINT "ProductFunnelDaily_counts_check" CHECK ("views" >= 0 AND "cartAdds" >= 0);
ALTER TABLE "ProductFunnelSeen" ADD CONSTRAINT "ProductFunnelSeen_kind_check" CHECK ("kind" IN ('V', 'C'));
