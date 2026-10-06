ALTER TABLE "AudienceEvent" ALTER COLUMN "keyword" DROP NOT NULL;
ALTER TABLE "AudienceEvent" ALTER COLUMN "liveChatId" DROP NOT NULL;
ALTER TABLE "AudienceEvent" ADD COLUMN "rules" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "AudienceEvent" DROP CONSTRAINT "AudienceEvent_rules_check";
ALTER TABLE "AudienceEvent" ADD CONSTRAINT "AudienceEvent_rules_check" CHECK (
  (("kind" = 'ROULETTE_ITEM' AND "keyword" IS NULL) OR
   ("kind" <> 'ROULETTE_ITEM' AND "keyword" IS NOT NULL AND char_length("keyword") BETWEEN 1 AND 100 AND "keyword" = btrim("keyword")))
  AND "winnerCount" BETWEEN 1 AND 100 AND "closesAt" > "openedAt" AND "rejectedIdentityCount" >= 0);

ALTER TABLE "AudienceEventRound" ADD COLUMN "roundNumber" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "AudienceEventRound" ADD COLUMN "requestKey" UUID DEFAULT gen_random_uuid();
ALTER TABLE "AudienceEventRound" ADD COLUMN "requestHash" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AudienceEventRound" ADD COLUMN "sourceRoundId" UUID;
ALTER TABLE "AudienceEventRound" ADD COLUMN "reason" TEXT;
ALTER TABLE "AudienceEventRound" ADD COLUMN "actorType" "ActorType" NOT NULL DEFAULT 'SYSTEM';
ALTER TABLE "AudienceEventRound" ADD COLUMN "actorId" TEXT;
-- 기존 회차의 원본 snapshot/result는 수정하지 않는다. 신규 metadata만 이 migration에서 보충한다.
ALTER TABLE "AudienceEventRound" DISABLE TRIGGER audience_round_immutable;
UPDATE "AudienceEventRound" r SET "requestKey" = e."requestKey", "requestHash" = e."requestHash" FROM "AudienceEvent" e WHERE r."eventId" = e.id AND r."sellerId" = e."sellerId";
ALTER TABLE "AudienceEventRound" ENABLE TRIGGER audience_round_immutable;
ALTER TABLE "AudienceEventRound" ALTER COLUMN "requestKey" SET NOT NULL;
DROP INDEX "AudienceEventRound_sellerId_eventId_key";
CREATE UNIQUE INDEX "AudienceEventRound_sellerId_eventId_roundNumber_key" ON "AudienceEventRound"("sellerId", "eventId", "roundNumber");
CREATE UNIQUE INDEX "AudienceEventRound_sellerId_eventId_requestKey_key" ON "AudienceEventRound"("sellerId", "eventId", "requestKey");
CREATE UNIQUE INDEX "AudienceEventRound_sellerId_eventId_id_key" ON "AudienceEventRound"("sellerId", "eventId", "id");
ALTER TABLE "AudienceEventRound" ADD CONSTRAINT "AudienceEventRound_source_fkey" FOREIGN KEY ("sellerId", "eventId", "sourceRoundId") REFERENCES "AudienceEventRound"("sellerId", "eventId", id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AudienceEventRound" ADD CONSTRAINT "AudienceEventRound_number_reason_check" CHECK ("roundNumber" >= 1 AND (("roundNumber" = 1 AND "sourceRoundId" IS NULL) OR ("roundNumber" > 1 AND "sourceRoundId" IS NOT NULL AND "reason" IS NOT NULL AND char_length(btrim("reason")) BETWEEN 1 AND 500)));
ALTER TABLE "AudienceEventResult" ADD COLUMN "execution" JSONB NOT NULL DEFAULT '{}';

CREATE TYPE "AudienceEventPublicationScope" AS ENUM ('ALL', 'PARTICIPANT');
CREATE TABLE "AudienceEventPublication" (
  id UUID NOT NULL DEFAULT gen_random_uuid(), "sellerId" UUID NOT NULL, "roundId" UUID NOT NULL, "requestKey" UUID NOT NULL,
  scope "AudienceEventPublicationScope" NOT NULL, "participantId" UUID, "actorType" "ActorType" NOT NULL, "actorId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AudienceEventPublication_pkey" PRIMARY KEY (id),
  CONSTRAINT "AudienceEventPublication_round_fkey" FOREIGN KEY ("sellerId", "roundId") REFERENCES "AudienceEventRound"("sellerId", id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AudienceEventPublication_scope_check" CHECK ((scope = 'ALL' AND "participantId" IS NULL) OR (scope = 'PARTICIPANT' AND "participantId" IS NOT NULL))
);
CREATE UNIQUE INDEX "AudienceEventPublication_sellerId_requestKey_key" ON "AudienceEventPublication"("sellerId", "requestKey");
CREATE INDEX "AudienceEventPublication_sellerId_roundId_idx" ON "AudienceEventPublication"("sellerId", "roundId");
CREATE TRIGGER audience_publication_immutable BEFORE UPDATE OR DELETE ON "AudienceEventPublication" FOR EACH ROW EXECUTE FUNCTION audience_event_immutable();

CREATE OR REPLACE FUNCTION audience_event_config_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."sellerId", NEW."broadcastSessionId", NEW."liveLinkId", NEW."liveChatId", NEW.kind, NEW.title, NEW.keyword, NEW.rules, NEW."winnerCount", NEW."testMode", NEW."requestKey", NEW."requestHash", NEW."openedAt", NEW."closesAt", NEW."noticeAcknowledgedAt") IS DISTINCT FROM
     ROW(OLD."sellerId", OLD."broadcastSessionId", OLD."liveLinkId", OLD."liveChatId", OLD.kind, OLD.title, OLD.keyword, OLD.rules, OLD."winnerCount", OLD."testMode", OLD."requestKey", OLD."requestHash", OLD."openedAt", OLD."closesAt", OLD."noticeAcknowledgedAt") THEN
    RAISE EXCEPTION 'audience event settings are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'OPEN' AND NEW.status IN ('FROZEN', 'CANCELED')) OR (OLD.status = 'FROZEN' AND NEW.status = 'COMPLETED')) THEN
    RAISE EXCEPTION 'invalid audience event transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION audience_event_round_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e "AudienceEvent"; source "AudienceEventRound"; entries jsonb; prior jsonb;
BEGIN
  SELECT * INTO e FROM "AudienceEvent" WHERE "sellerId" = NEW."sellerId" AND id = NEW."eventId" FOR UPDATE;
  SELECT COALESCE(jsonb_agg(id::text ORDER BY "publishedAt", id), '[]'::jsonb) INTO entries FROM "AudienceEventEntrant" WHERE "sellerId" = NEW."sellerId" AND "eventId" = NEW."eventId";
  IF e.status NOT IN ('FROZEN', 'COMPLETED') OR NEW."entrantIds" IS DISTINCT FROM entries OR
     (NEW."rulesSnapshot"->>'kind') IS DISTINCT FROM e.kind::text OR
     (NEW."rulesSnapshot"->>'keyword') IS DISTINCT FROM e.keyword OR
     (NEW."rulesSnapshot"->>'winnerCount')::integer IS DISTINCT FROM e."winnerCount" OR
     (NEW."rulesSnapshot"->>'testMode')::boolean IS DISTINCT FROM e."testMode" THEN
    RAISE EXCEPTION 'round must snapshot frozen entrants and rules' USING ERRCODE = '23514';
  END IF;
  IF (NEW."rulesSnapshot"->>'version')::integer = 2 AND
     ((NEW."rulesSnapshot"->'settings') - 'allowDuplicateWinners') IS DISTINCT FROM (e.rules - 'allowDuplicateWinners') THEN
    RAISE EXCEPTION 'round item/slot settings differ from event' USING ERRCODE = '23514';
  END IF;
  IF (NEW."rulesSnapshot"->>'version')::integer = 2 AND
     (jsonb_typeof(NEW."rulesSnapshot"->'settings'->'allowDuplicateWinners') IS DISTINCT FROM 'boolean' OR
      NEW."rulesSnapshot"->>'rewardsEnabled' IS DISTINCT FROM 'false' OR
      jsonb_typeof(NEW."rulesSnapshot"->'previousWinnerIds') IS DISTINCT FROM 'array' OR
      (e.kind = 'LADDER' AND NEW."rulesSnapshot"->'settings'->>'allowDuplicateWinners' IS DISTINCT FROM 'false')) THEN
    RAISE EXCEPTION 'round requires explicit duplicate and no-reward rules' USING ERRCODE = '23514';
  END IF;
  IF NEW."roundNumber" > 1 THEN
    SELECT * INTO source FROM "AudienceEventRound" WHERE "sellerId" = NEW."sellerId" AND "eventId" = NEW."eventId" AND id = NEW."sourceRoundId";
    IF NOT FOUND OR source."roundNumber" <> NEW."roundNumber" - 1 OR
       NOT EXISTS(SELECT 1 FROM "AudienceEventResult" WHERE "sellerId" = NEW."sellerId" AND "roundId" = source.id) THEN
      RAISE EXCEPTION 'new round requires completed preceding round' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF (NEW."rulesSnapshot"->>'version')::integer = 2 THEN
    SELECT COALESCE(jsonb_agg(DISTINCT selected.value ORDER BY selected.value), '[]'::jsonb) INTO prior
    FROM "AudienceEventRound" earlier JOIN "AudienceEventResult" result ON result."sellerId" = earlier."sellerId" AND result."roundId" = earlier.id
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN e.kind = 'LADDER' THEN '[]'::jsonb WHEN e.kind = 'ROULETTE_ITEM' THEN result.execution->'draw'->'selectedIds' ELSE result."winnerEntrantIds" END) selected
    WHERE earlier."sellerId" = NEW."sellerId" AND earlier."eventId" = NEW."eventId";
    IF NOT ((NEW."rulesSnapshot"->'previousWinnerIds') @> prior AND prior @> (NEW."rulesSnapshot"->'previousWinnerIds')) THEN
      RAISE EXCEPTION 'round must preserve previous selections' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION audience_event_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r "AudienceEventRound"; kind text; selected jsonb; pool jsonb; duplicates boolean; amount integer;
BEGIN
  SELECT * INTO r FROM "AudienceEventRound" WHERE "sellerId" = NEW."sellerId" AND id = NEW."roundId";
  IF NOT FOUND OR NEW."testMode" IS DISTINCT FROM (r."rulesSnapshot"->>'testMode')::boolean OR jsonb_typeof(NEW."winnerEntrantIds") <> 'array' THEN
    RAISE EXCEPTION 'invalid audience result' USING ERRCODE = '23514';
  END IF;
  kind := r."rulesSnapshot"->>'kind';
  IF (r."rulesSnapshot"->>'version')::integer = 2 THEN
    IF NEW.execution->>'kind' IS DISTINCT FROM kind OR NEW.execution->>'version' IS DISTINCT FROM '2' THEN
      RAISE EXCEPTION 'result must use frozen kind' USING ERRCODE = '23514';
    END IF;
    IF kind = 'LADDER' THEN
      SELECT COALESCE(jsonb_agg(value->'id'), '[]'::jsonb) INTO pool FROM jsonb_array_elements(r."rulesSnapshot"->'settings'->'outcomeSlots');
      IF NEW."winnerEntrantIds" <> '[]'::jsonb OR NEW.execution->'ladder'->'structure'->'participantIds' IS DISTINCT FROM r."entrantIds" OR
         NEW.execution->'ladder'->'structure'->'outcomeSlotIds' IS DISTINCT FROM pool OR
         jsonb_array_length(NEW.execution->'ladder'->'routes') IS DISTINCT FROM jsonb_array_length(r."entrantIds") OR
         jsonb_array_length(pool) <> jsonb_array_length(r."entrantIds") OR
         EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.execution->'ladder'->'routes') route WHERE NOT r."entrantIds" @> jsonb_build_array(route.value->'participantId') OR NOT pool @> jsonb_build_array(route.value->'outcomeSlotId')) OR
         (SELECT count(DISTINCT value->>'participantId') FROM jsonb_array_elements(NEW.execution->'ladder'->'routes')) <> jsonb_array_length(r."entrantIds") OR
         (SELECT count(DISTINCT value->>'outcomeSlotId') FROM jsonb_array_elements(NEW.execution->'ladder'->'routes')) <> jsonb_array_length(pool) THEN
        RAISE EXCEPTION 'ladder result must preserve frozen participants and slots' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    selected := NEW.execution->'draw'->'selectedIds';
    duplicates := (r."rulesSnapshot"->'settings'->>'allowDuplicateWinners')::boolean;
    IF kind = 'ROULETTE_ITEM' THEN
      SELECT COALESCE(jsonb_agg(value->'id'), '[]'::jsonb) INTO pool FROM jsonb_array_elements(r."rulesSnapshot"->'settings'->'items');
      IF NEW."winnerEntrantIds" <> '[]'::jsonb THEN RAISE EXCEPTION 'item selection is not an entrant prize' USING ERRCODE = '23514'; END IF;
    ELSE
      pool := r."entrantIds";
      IF selected IS DISTINCT FROM NEW."winnerEntrantIds" THEN RAISE EXCEPTION 'entrant winners mismatch' USING ERRCODE = '23514'; END IF;
    END IF;
  ELSE
    selected := NEW."winnerEntrantIds"; pool := r."entrantIds"; duplicates := false;
  END IF;
  IF jsonb_typeof(selected) IS DISTINCT FROM 'array' OR duplicates IS NULL THEN
    RAISE EXCEPTION 'selection rules must be explicit' USING ERRCODE = '23514';
  END IF;
  SELECT count(DISTINCT value) INTO amount FROM jsonb_array_elements_text(selected);
  IF jsonb_typeof(selected) IS DISTINCT FROM 'array' OR jsonb_array_length(selected) IS DISTINCT FROM (r."rulesSnapshot"->>'winnerCount')::integer OR
     (NOT duplicates AND amount <> jsonb_array_length(selected)) OR
     EXISTS(SELECT 1 FROM jsonb_array_elements(selected) w WHERE NOT pool @> jsonb_build_array(w.value)) OR
     (NOT duplicates AND EXISTS(SELECT 1 FROM jsonb_array_elements(selected) w WHERE COALESCE(r."rulesSnapshot"->'previousWinnerIds', '[]'::jsonb) @> jsonb_build_array(w.value))) THEN
    RAISE EXCEPTION 'selection must match frozen pool and duplicate rules' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION audience_event_publication_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r "AudienceEventRound";
BEGIN
  SELECT * INTO r FROM "AudienceEventRound" WHERE "sellerId" = NEW."sellerId" AND id = NEW."roundId";
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM "AudienceEventResult" WHERE "sellerId" = NEW."sellerId" AND "roundId" = NEW."roundId") OR
     (NEW.scope = 'PARTICIPANT' AND (r."rulesSnapshot"->>'kind' <> 'LADDER' OR NOT r."entrantIds" @> jsonb_build_array(NEW."participantId"::text))) THEN
    RAISE EXCEPTION 'publication requires confirmed result and frozen participant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audience_publication_valid BEFORE INSERT ON "AudienceEventPublication" FOR EACH ROW EXECUTE FUNCTION audience_event_publication_guard();
