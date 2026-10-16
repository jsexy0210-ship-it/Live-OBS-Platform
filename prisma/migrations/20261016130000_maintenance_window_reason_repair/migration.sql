-- 점검 창 도입 마이그레이션(20261013100000)이 사유가 있던 켜진 점검도 자리표시 사유로 옮겼던 것을 바로잡는다.
-- 대상은 아직 열려 있는 창 중 자리표시 사유인 것뿐이다(이미 닫힌 창·직접 만든 창은 건드리지 않는다).
-- ① 변하지 않는 로그 추적(platform.maintenance.update)에서 같은 안내 문구로 켠 가장 최근 기록의 사유를 우선 쓴다.
UPDATE "PlatformMaintenanceWindow" w
SET "reason" = a."reason"
FROM (
  SELECT DISTINCT ON ("after"->>'message') "after"->>'message' AS "message", "after"->>'reason' AS "reason"
  FROM "AuditLog"
  WHERE "action" = 'platform.maintenance.update' AND "targetType" = 'PlatformMaintenance' AND "targetId" = '1'
    AND ("after"->>'enabled')::boolean = true AND COALESCE("after"->>'reason', '') <> ''
  ORDER BY "after"->>'message', "createdAt" DESC, "id" DESC
) a
WHERE w."status" = 'SCHEDULED' AND w."reason" = '이전 설정에서 가져옴' AND w."message" = a."message";
-- ② 기록에서 찾지 못한 창은, 지금 상태 사본이 같은 안내 문구의 사유를 아직 갖고 있을 때만 사본에서 되돌린다.
UPDATE "PlatformMaintenanceWindow" w
SET "reason" = m."reason"
FROM "PlatformMaintenance" m
WHERE m."id" = 1 AND m."enabled" = true AND m."reason" <> '' AND m."reason" <> '이전 설정에서 가져옴'
  AND w."status" = 'SCHEDULED' AND w."reason" = '이전 설정에서 가져옴' AND w."message" = m."message";
