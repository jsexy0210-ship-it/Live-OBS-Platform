-- 관리자 화면 브랜딩(마스터 관리자·파트너스 관리자 파비콘·공유 카드). 이미지는 DB에 바이트로 둔다(저장소 결정 전, 크기 제한).
CREATE TABLE "SiteBranding" (
    "target" TEXT NOT NULL,
    "faviconData" BYTEA,
    "faviconType" TEXT,
    "faviconHash" TEXT,
    "ogTitle" TEXT,
    "ogDescription" TEXT,
    "ogImageData" BYTEA,
    "ogImageType" TEXT,
    "ogImageHash" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteBranding_pkey" PRIMARY KEY ("target"),
    CONSTRAINT "SiteBranding_target_check" CHECK ("target" IN ('admin', 'seller')),
    -- 파비콘: PNG·ICO, 256KB까지. 공유 카드 이미지: PNG·JPEG, 2MB까지(lib/server/branding/image.ts와 같은 값)
    CONSTRAINT "SiteBranding_favicon_check" CHECK (
        ("faviconData" IS NULL AND "faviconType" IS NULL AND "faviconHash" IS NULL)
        OR ("faviconData" IS NOT NULL AND "faviconHash" IS NOT NULL AND "faviconType" IN ('image/png', 'image/x-icon') AND octet_length("faviconData") <= 262144)
    ),
    CONSTRAINT "SiteBranding_og_image_check" CHECK (
        ("ogImageData" IS NULL AND "ogImageType" IS NULL AND "ogImageHash" IS NULL)
        OR ("ogImageData" IS NOT NULL AND "ogImageHash" IS NOT NULL AND "ogImageType" IN ('image/png', 'image/jpeg') AND octet_length("ogImageData") <= 2097152)
    )
);
