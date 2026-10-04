-- 리뷰 사진을 상품 사진과 같은 기준으로: JPG·PNG·WEBP, 장당 5MB, 가로·세로 4000px까지(기존 행은 모두 이 범위 안)
ALTER TABLE "ProductReviewImage" DROP CONSTRAINT "ProductReviewImage_type_check";
ALTER TABLE "ProductReviewImage" ADD CONSTRAINT "ProductReviewImage_type_check" CHECK ("contentType" IN ('image/jpeg', 'image/png', 'image/webp'));
ALTER TABLE "ProductReviewImage" DROP CONSTRAINT "ProductReviewImage_size_check";
ALTER TABLE "ProductReviewImage" ADD CONSTRAINT "ProductReviewImage_size_check" CHECK ("byteSize" > 0 AND "byteSize" <= 5242880 AND octet_length("data") = "byteSize");
ALTER TABLE "ProductReviewImage" DROP CONSTRAINT "ProductReviewImage_dimension_check";
ALTER TABLE "ProductReviewImage" ADD CONSTRAINT "ProductReviewImage_dimension_check" CHECK ("width" BETWEEN 1 AND 4000 AND "height" BETWEEN 1 AND 4000);
