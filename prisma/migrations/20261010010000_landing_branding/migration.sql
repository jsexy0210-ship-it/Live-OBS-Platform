-- 기존 관리자 브랜딩과 분리된 소개 랜딩을 같은 무료 DB 저장소로 관리한다.
ALTER TABLE "SiteBranding" DROP CONSTRAINT "SiteBranding_target_check";
ALTER TABLE "SiteBranding" ADD CONSTRAINT "SiteBranding_target_check" CHECK ("target" IN ('admin', 'seller', 'landing'));
