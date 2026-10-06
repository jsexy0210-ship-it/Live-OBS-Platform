ALTER TABLE "ShopNotice" DROP CONSTRAINT "ShopNotice_category_faq_check";

ALTER TABLE "ShopNotice"
ADD CONSTRAINT "ShopNotice_category_notice_faq_check"
CHECK ("category" IS NULL OR "kind" IN ('NOTICE', 'FAQ'));
