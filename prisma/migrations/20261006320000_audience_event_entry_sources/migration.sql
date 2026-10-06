CREATE TYPE "AudienceEventEntrySource" AS ENUM ('YOUTUBE_CHAT','DIRECT_INPUT','PASTE','MOBILE');
ALTER TABLE "AudienceEvent" ADD COLUMN "entryMethods" "AudienceEventEntrySource"[] NOT NULL DEFAULT ARRAY['YOUTUBE_CHAT']::"AudienceEventEntrySource"[];
ALTER TABLE "AudienceEvent" ALTER COLUMN "liveLinkId" DROP NOT NULL;
-- 기존 항목 룰렛은 명단을 쓰지 않는다. 신규 메타데이터만 이 migration에서 보충한다.
ALTER TABLE "AudienceEvent" DISABLE TRIGGER audience_event_config;
UPDATE "AudienceEvent" SET "entryMethods"='{}' WHERE kind='ROULETTE_ITEM';
ALTER TABLE "AudienceEvent" ENABLE TRIGGER audience_event_config;
ALTER TABLE "AudienceEvent" DROP CONSTRAINT "AudienceEvent_rules_check";
ALTER TABLE "AudienceEvent" ADD CONSTRAINT "AudienceEvent_rules_check" CHECK (
  ((kind='ROULETTE_ITEM' AND keyword IS NULL AND cardinality("entryMethods")=0) OR
   (kind<>'ROULETTE_ITEM' AND cardinality("entryMethods") BETWEEN 1 AND 4 AND
    ((ARRAY['YOUTUBE_CHAT']::"AudienceEventEntrySource"[] <@ "entryMethods" AND keyword IS NOT NULL AND char_length(keyword) BETWEEN 1 AND 100 AND keyword=btrim(keyword) AND "liveLinkId" IS NOT NULL AND "liveChatId" IS NOT NULL) OR
     (NOT ARRAY['YOUTUBE_CHAT']::"AudienceEventEntrySource"[] <@ "entryMethods" AND keyword IS NULL))))
  AND "winnerCount" BETWEEN 1 AND 100 AND "closesAt">"openedAt" AND "rejectedIdentityCount">=0);


CREATE TABLE "AudienceEventEntryBatch" (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),"sellerId" UUID NOT NULL,"eventId" UUID NOT NULL,"requestKey" UUID NOT NULL,"requestHash" TEXT,
 method "AudienceEventEntrySource" NOT NULL,"inputCount" INTEGER NOT NULL,"acceptedCount" INTEGER NOT NULL DEFAULT 0,"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "AudienceEventEntryBatch_counts_check" CHECK(method IN ('DIRECT_INPUT','PASTE') AND "inputCount" BETWEEN 1 AND 100 AND "acceptedCount" BETWEEN 0 AND "inputCount"),
 CONSTRAINT "AudienceEventEntryBatch_event_fkey" FOREIGN KEY("sellerId","eventId") REFERENCES "AudienceEvent"("sellerId",id) ON DELETE RESTRICT ON UPDATE CASCADE);
CREATE UNIQUE INDEX "AudienceEventEntryBatch_sellerId_eventId_requestKey_key" ON "AudienceEventEntryBatch"("sellerId","eventId","requestKey");
CREATE UNIQUE INDEX "AudienceEventEntryBatch_sellerId_eventId_id_key" ON "AudienceEventEntryBatch"("sellerId","eventId",id);
CREATE TABLE "AudienceEventGuestSession" (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),"sellerId" UUID NOT NULL,"eventId" UUID NOT NULL,"tokenHash" TEXT,"expiresAt" TIMESTAMPTZ(3) NOT NULL,"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "AudienceEventGuestSession_event_fkey" FOREIGN KEY("sellerId","eventId") REFERENCES "AudienceEvent"("sellerId",id) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "AudienceEventGuestSession_expiry_check" CHECK("expiresAt">"createdAt"));
CREATE UNIQUE INDEX "AudienceEventGuestSession_tokenHash_key" ON "AudienceEventGuestSession"("tokenHash");
CREATE UNIQUE INDEX "AudienceEventGuestSession_sellerId_eventId_id_key" ON "AudienceEventGuestSession"("sellerId","eventId",id);
CREATE INDEX "AudienceEventGuestSession_sellerId_eventId_createdAt_idx" ON "AudienceEventGuestSession"("sellerId","eventId","createdAt");
ALTER TABLE "AudienceEventEntrant" ALTER COLUMN "authorChannelId" DROP NOT NULL;
ALTER TABLE "AudienceEventEntrant" ALTER COLUMN "messageId" DROP NOT NULL;
ALTER TABLE "AudienceEventEntrant" ADD COLUMN source "AudienceEventEntrySource" NOT NULL DEFAULT 'YOUTUBE_CHAT';
ALTER TABLE "AudienceEventEntrant" ADD COLUMN "buyerMemberId" UUID;
ALTER TABLE "AudienceEventEntrant" ADD COLUMN "guestSessionId" UUID;
ALTER TABLE "AudienceEventEntrant" ADD COLUMN "batchId" UUID;
ALTER TABLE "AudienceEventEntrant" ADD COLUMN "rowNumber" INTEGER;
ALTER TABLE "AudienceEventEntrant" ADD COLUMN "requestKey" UUID;
ALTER TABLE "AudienceEventEntrant" ADD COLUMN "requestHash" TEXT;
ALTER TABLE "AudienceEventEntrant" ADD COLUMN "entryRulesVersion" TEXT;
ALTER TABLE "AudienceEventEntrant" ADD COLUMN "rulesAcknowledgedAt" TIMESTAMPTZ(3);
ALTER TABLE "AudienceEventEntrant" ADD COLUMN "anonymizedAt" TIMESTAMPTZ(3);
ALTER TABLE "AudienceEventEntrant" DROP CONSTRAINT "AudienceEventEntrant_identity_check";
ALTER TABLE "AudienceEventEntrant" ADD CONSTRAINT "AudienceEventEntrant_identity_check" CHECK (
  ("anonymizedAt" IS NOT NULL AND "buyerMemberId" IS NULL AND "guestSessionId" IS NULL AND "authorChannelId" IS NULL AND "messageId" IS NULL AND "requestKey" IS NULL AND "requestHash" IS NULL AND "displayName"='탈퇴한 회원') OR
  ("anonymizedAt" IS NULL AND (
   (source='YOUTUBE_CHAT' AND "authorChannelId" IS NOT NULL AND "authorChannelId"~'^UC[A-Za-z0-9_-]{22}$' AND "messageId" IS NOT NULL AND char_length("messageId") BETWEEN 1 AND 512 AND "buyerMemberId" IS NULL AND "guestSessionId" IS NULL AND "batchId" IS NULL AND "rowNumber" IS NULL) OR
   (source IN ('DIRECT_INPUT','PASTE') AND "authorChannelId" IS NULL AND "messageId" IS NULL AND "guestSessionId" IS NULL AND "batchId" IS NOT NULL AND "rowNumber" IS NOT NULL AND "rowNumber" BETWEEN 1 AND 100) OR
   (source='MOBILE' AND "authorChannelId" IS NULL AND "messageId" IS NULL AND (("buyerMemberId" IS NOT NULL)::int+("guestSessionId" IS NOT NULL)::int)=1 AND "batchId" IS NULL AND "rowNumber" IS NULL AND "requestKey" IS NOT NULL AND "requestHash" IS NOT NULL AND "entryRulesVersion" IS NOT NULL AND "entryRulesVersion"='audience-entry-v1' AND "rulesAcknowledgedAt" IS NOT NULL AND "rulesAcknowledgedAt"<= "acceptedAt"))));
ALTER TABLE "AudienceEventEntrant" ADD CONSTRAINT "AudienceEventEntrant_member_fkey" FOREIGN KEY("sellerId","buyerMemberId") REFERENCES "BuyerMember"("sellerId",id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AudienceEventEntrant" ADD CONSTRAINT "AudienceEventEntrant_guest_fkey" FOREIGN KEY("sellerId","eventId","guestSessionId") REFERENCES "AudienceEventGuestSession"("sellerId","eventId",id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AudienceEventEntrant" ADD CONSTRAINT "AudienceEventEntrant_batch_fkey" FOREIGN KEY("sellerId","eventId","batchId") REFERENCES "AudienceEventEntryBatch"("sellerId","eventId",id) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "AudienceEventEntrant_sellerId_eventId_buyerMemberId_key" ON "AudienceEventEntrant"("sellerId","eventId","buyerMemberId");
CREATE UNIQUE INDEX "AudienceEventEntrant_sellerId_eventId_guestSessionId_key" ON "AudienceEventEntrant"("sellerId","eventId","guestSessionId");
CREATE UNIQUE INDEX "AudienceEventEntrant_sellerId_eventId_requestKey_key" ON "AudienceEventEntrant"("sellerId","eventId","requestKey");
CREATE UNIQUE INDEX "AudienceEventEntrant_batchId_rowNumber_key" ON "AudienceEventEntrant"("batchId","rowNumber");

CREATE OR REPLACE FUNCTION audience_event_entrant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e "AudienceEvent";
BEGIN
 SELECT * INTO e FROM "AudienceEvent" WHERE "sellerId"=NEW."sellerId" AND id=NEW."eventId" FOR UPDATE;
 IF NOT FOUND OR e.status<>'OPEN' OR NEW."publishedAt"<e."openedAt" OR NEW."publishedAt">=e."closesAt" OR NEW."acceptedAt">=e."closesAt" OR NEW."anonymizedAt" IS NOT NULL OR NOT NEW.source=ANY(e."entryMethods") OR NOT EXISTS(SELECT 1 FROM "BroadcastSession" WHERE "sellerId"=NEW."sellerId" AND id=e."broadcastSessionId" AND status='LIVE') THEN
  RAISE EXCEPTION 'event closed or source not enabled' USING ERRCODE='23514';
 END IF;
 IF (SELECT count(*) FROM "AudienceEventEntrant" WHERE "sellerId"=NEW."sellerId" AND "eventId"=NEW."eventId")>=5000 THEN RAISE EXCEPTION 'entrant resource guard' USING ERRCODE='23514'; END IF;
 IF NEW."buyerMemberId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "BuyerMember" WHERE "sellerId"=NEW."sellerId" AND id=NEW."buyerMemberId" AND status='ACTIVE' AND "deletedAt" IS NULL) THEN RAISE EXCEPTION 'member unavailable' USING ERRCODE='23514'; END IF;
 IF NEW."guestSessionId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "AudienceEventGuestSession" WHERE "sellerId"=NEW."sellerId" AND "eventId"=NEW."eventId" AND id=NEW."guestSessionId" AND "tokenHash" IS NOT NULL AND "expiresAt">NEW."acceptedAt") THEN RAISE EXCEPTION 'guest session expired' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER audience_entrant_immutable ON "AudienceEventEntrant";
CREATE FUNCTION audience_entrant_privacy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD."buyerMemberId" IS NOT NULL AND NEW."buyerMemberId" IS NULL AND NEW."anonymizedAt" IS NOT NULL AND NEW."displayName"='탈퇴한 회원' AND NEW."requestKey" IS NULL AND NEW."requestHash" IS NULL AND
   (to_jsonb(NEW)-ARRAY['buyerMemberId','displayName','anonymizedAt','requestKey','requestHash']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['buyerMemberId','displayName','anonymizedAt','requestKey','requestHash']) AND
   EXISTS(SELECT 1 FROM "BuyerMember" WHERE "sellerId"=OLD."sellerId" AND id=OLD."buyerMemberId" AND status='WITHDRAWN' AND "deletedAt" IS NOT NULL) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'entrant is immutable except withdrawn member anonymization' USING ERRCODE='23514';
END $$;
CREATE TRIGGER audience_entrant_immutable BEFORE UPDATE OR DELETE ON "AudienceEventEntrant" FOR EACH ROW EXECUTE FUNCTION audience_entrant_privacy_guard();
CREATE FUNCTION audience_event_entry_methods_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."entryMethods" IS DISTINCT FROM OLD."entryMethods" THEN RAISE EXCEPTION 'entry methods immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER audience_entry_methods_immutable BEFORE UPDATE ON "AudienceEvent" FOR EACH ROW EXECUTE FUNCTION audience_event_entry_methods_guard();
CREATE FUNCTION audience_round_entry_methods_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE configured "AudienceEventEntrySource"[];
BEGIN
 SELECT "entryMethods" INTO configured FROM "AudienceEvent" WHERE "sellerId"=NEW."sellerId" AND id=NEW."eventId";
 IF COALESCE(NEW."rulesSnapshot"->'entryMethods','["YOUTUBE_CHAT"]'::jsonb) IS DISTINCT FROM to_jsonb(configured) THEN RAISE EXCEPTION 'entry methods must be frozen' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER audience_round_entry_methods_valid BEFORE INSERT ON "AudienceEventRound" FOR EACH ROW EXECUTE FUNCTION audience_round_entry_methods_guard();
