CREATE TYPE "AudienceEventKind" AS ENUM ('ROULETTE_ITEM', 'ROULETTE_PARTICIPANT', 'LADDER', 'RANDOM_DRAW');
CREATE TYPE "AudienceEventStatus" AS ENUM ('OPEN', 'FROZEN', 'COMPLETED', 'CANCELED');

CREATE TABLE "AudienceEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "sellerId" UUID NOT NULL,
  "broadcastSessionId" UUID NOT NULL, "liveLinkId" UUID NOT NULL, "liveChatId" TEXT NOT NULL,
  "kind" "AudienceEventKind" NOT NULL, "status" "AudienceEventStatus" NOT NULL DEFAULT 'OPEN',
  "title" TEXT NOT NULL, "keyword" TEXT NOT NULL, "winnerCount" INTEGER NOT NULL, "testMode" BOOLEAN NOT NULL,
  "requestKey" UUID NOT NULL, "requestHash" TEXT NOT NULL, "noticeAcknowledgedAt" TIMESTAMPTZ(3) NOT NULL,
  "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "closesAt" TIMESTAMPTZ(3) NOT NULL,
  "frozenAt" TIMESTAMPTZ(3), "completedAt" TIMESTAMPTZ(3), "rejectedIdentityCount" INTEGER NOT NULL DEFAULT 0,
  "lastEntryRejection" TEXT,
  CONSTRAINT "AudienceEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AudienceEvent_rules_check" CHECK (char_length("keyword") BETWEEN 1 AND 100 AND "keyword" = btrim("keyword") AND "winnerCount" BETWEEN 1 AND 100 AND "closesAt" > "openedAt" AND "rejectedIdentityCount" >= 0),
  CONSTRAINT "AudienceEvent_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AudienceEvent_sellerId_broadcastSessionId_fkey" FOREIGN KEY ("sellerId", "broadcastSessionId") REFERENCES "BroadcastSession"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AudienceEvent_sellerId_liveLinkId_fkey" FOREIGN KEY ("sellerId", "liveLinkId") REFERENCES "YoutubeLiveLink"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AudienceEvent_sellerId_id_key" ON "AudienceEvent"("sellerId", "id");
CREATE UNIQUE INDEX "AudienceEvent_sellerId_requestKey_key" ON "AudienceEvent"("sellerId", "requestKey");
CREATE UNIQUE INDEX "AudienceEvent_one_open_per_seller" ON "AudienceEvent"("sellerId") WHERE "status" = 'OPEN';
CREATE INDEX "AudienceEvent_sellerId_broadcastSessionId_openedAt_idx" ON "AudienceEvent"("sellerId", "broadcastSessionId", "openedAt");
CREATE INDEX "AudienceEvent_sellerId_liveLinkId_status_idx" ON "AudienceEvent"("sellerId", "liveLinkId", "status");

CREATE TABLE "AudienceEventEntrant" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "sellerId" UUID NOT NULL, "eventId" UUID NOT NULL,
  "authorChannelId" TEXT NOT NULL, "messageId" TEXT NOT NULL, "displayName" TEXT NOT NULL,
  "publishedAt" TIMESTAMPTZ(3) NOT NULL, "acceptedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AudienceEventEntrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AudienceEventEntrant_identity_check" CHECK ("authorChannelId" ~ '^UC[A-Za-z0-9_-]{22}$' AND char_length("messageId") BETWEEN 1 AND 512),
  CONSTRAINT "AudienceEventEntrant_sellerId_eventId_fkey" FOREIGN KEY ("sellerId", "eventId") REFERENCES "AudienceEvent"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AudienceEventEntrant_sellerId_eventId_authorChannelId_key" ON "AudienceEventEntrant"("sellerId", "eventId", "authorChannelId");
CREATE UNIQUE INDEX "AudienceEventEntrant_sellerId_eventId_messageId_key" ON "AudienceEventEntrant"("sellerId", "eventId", "messageId");
CREATE INDEX "AudienceEventEntrant_sellerId_eventId_publishedAt_id_idx" ON "AudienceEventEntrant"("sellerId", "eventId", "publishedAt", "id");

CREATE TABLE "AudienceEventEntryRejection" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "sellerId" UUID NOT NULL, "eventId" UUID NOT NULL, "messageId" TEXT NOT NULL, "reason" TEXT NOT NULL,
  CONSTRAINT "AudienceEventEntryRejection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AudienceEventEntryRejection_sellerId_eventId_fkey" FOREIGN KEY ("sellerId", "eventId") REFERENCES "AudienceEvent"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AudienceEventEntryRejection_sellerId_eventId_messageId_key" ON "AudienceEventEntryRejection"("sellerId", "eventId", "messageId");

CREATE TABLE "AudienceEventRound" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "sellerId" UUID NOT NULL, "eventId" UUID NOT NULL,
  "rulesSnapshot" JSONB NOT NULL, "entrantIds" JSONB NOT NULL, "frozenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AudienceEventRound_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AudienceEventRound_sellerId_eventId_fkey" FOREIGN KEY ("sellerId", "eventId") REFERENCES "AudienceEvent"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AudienceEventRound_entries_check" CHECK (jsonb_typeof("entrantIds") = 'array' AND jsonb_array_length("entrantIds") <= 5000)
);
CREATE UNIQUE INDEX "AudienceEventRound_sellerId_eventId_key" ON "AudienceEventRound"("sellerId", "eventId");
CREATE UNIQUE INDEX "AudienceEventRound_sellerId_id_key" ON "AudienceEventRound"("sellerId", "id");

CREATE TABLE "AudienceEventResult" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "sellerId" UUID NOT NULL, "roundId" UUID NOT NULL,
  "algorithmVersion" TEXT NOT NULL, "winnerEntrantIds" JSONB NOT NULL, "testMode" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AudienceEventResult_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AudienceEventResult_sellerId_roundId_fkey" FOREIGN KEY ("sellerId", "roundId") REFERENCES "AudienceEventRound"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AudienceEventResult_sellerId_roundId_key" ON "AudienceEventResult"("sellerId", "roundId");

-- 원문 채팅을 저장하지 않는다. 회차/결과/참가자는 append-only이며 이벤트 설정은 시작 뒤 바뀌지 않는다.
CREATE FUNCTION audience_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audience event record is immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER audience_round_immutable BEFORE UPDATE OR DELETE ON "AudienceEventRound" FOR EACH ROW EXECUTE FUNCTION audience_event_immutable();
CREATE TRIGGER audience_result_immutable BEFORE UPDATE OR DELETE ON "AudienceEventResult" FOR EACH ROW EXECUTE FUNCTION audience_event_immutable();
CREATE TRIGGER audience_entrant_immutable BEFORE UPDATE OR DELETE ON "AudienceEventEntrant" FOR EACH ROW EXECUTE FUNCTION audience_event_immutable();

CREATE FUNCTION audience_event_entrant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e "AudienceEvent";
BEGIN
  SELECT * INTO e FROM "AudienceEvent" WHERE "sellerId" = NEW."sellerId" AND "id" = NEW."eventId" FOR UPDATE;
  IF NOT FOUND OR e."status" <> 'OPEN' OR NEW."publishedAt" < e."openedAt" OR NEW."publishedAt" >= e."closesAt" OR NEW."acceptedAt" >= e."closesAt" THEN
    RAISE EXCEPTION 'audience event is closed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audience_entrant_open BEFORE INSERT ON "AudienceEventEntrant" FOR EACH ROW EXECUTE FUNCTION audience_event_entrant_guard();

CREATE FUNCTION audience_event_config_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."sellerId", NEW."broadcastSessionId", NEW."liveLinkId", NEW."liveChatId", NEW."kind", NEW."title", NEW."keyword", NEW."winnerCount", NEW."testMode", NEW."requestKey", NEW."requestHash", NEW."openedAt", NEW."closesAt", NEW."noticeAcknowledgedAt") IS DISTINCT FROM
     ROW(OLD."sellerId", OLD."broadcastSessionId", OLD."liveLinkId", OLD."liveChatId", OLD."kind", OLD."title", OLD."keyword", OLD."winnerCount", OLD."testMode", OLD."requestKey", OLD."requestHash", OLD."openedAt", OLD."closesAt", OLD."noticeAcknowledgedAt") THEN
    RAISE EXCEPTION 'audience event settings are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT ((OLD."status" = 'OPEN' AND NEW."status" IN ('FROZEN', 'CANCELED')) OR (OLD."status" = 'FROZEN' AND NEW."status" = 'COMPLETED')) THEN
    RAISE EXCEPTION 'invalid audience event transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audience_event_config BEFORE UPDATE ON "AudienceEvent" FOR EACH ROW EXECUTE FUNCTION audience_event_config_guard();

CREATE FUNCTION audience_event_round_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e "AudienceEvent"; entries jsonb;
BEGIN
  SELECT * INTO e FROM "AudienceEvent" WHERE "sellerId" = NEW."sellerId" AND "id" = NEW."eventId" FOR UPDATE;
  SELECT COALESCE(jsonb_agg("id"::text ORDER BY "publishedAt", "id"), '[]'::jsonb) INTO entries FROM "AudienceEventEntrant" WHERE "sellerId" = NEW."sellerId" AND "eventId" = NEW."eventId";
  IF e."status" IS DISTINCT FROM 'FROZEN' OR NEW."entrantIds" IS DISTINCT FROM entries OR
     (NEW."rulesSnapshot"->>'kind') IS DISTINCT FROM e."kind"::text OR
     (NEW."rulesSnapshot"->>'keyword') IS DISTINCT FROM e."keyword" OR
     (NEW."rulesSnapshot"->>'winnerCount')::integer IS DISTINCT FROM e."winnerCount" OR
     (NEW."rulesSnapshot"->>'testMode')::boolean IS DISTINCT FROM e."testMode" THEN
    RAISE EXCEPTION 'round must snapshot all frozen entrants and rules' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audience_round_snapshot BEFORE INSERT ON "AudienceEventRound" FOR EACH ROW EXECUTE FUNCTION audience_event_round_guard();

CREATE FUNCTION audience_event_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r "AudienceEventRound"; amount integer;
BEGIN
  SELECT * INTO r FROM "AudienceEventRound" WHERE "sellerId" = NEW."sellerId" AND "id" = NEW."roundId";
  IF NOT FOUND OR NEW."testMode" IS DISTINCT FROM (r."rulesSnapshot"->>'testMode')::boolean OR jsonb_typeof(NEW."winnerEntrantIds") <> 'array' THEN
    RAISE EXCEPTION 'invalid audience result' USING ERRCODE = '23514';
  END IF;
  SELECT count(DISTINCT value) INTO amount FROM jsonb_array_elements_text(NEW."winnerEntrantIds");
  IF amount <> (r."rulesSnapshot"->>'winnerCount')::integer OR amount <> jsonb_array_length(NEW."winnerEntrantIds") OR
     EXISTS(SELECT 1 FROM jsonb_array_elements(NEW."winnerEntrantIds") w WHERE NOT r."entrantIds" @> jsonb_build_array(w.value)) THEN
    RAISE EXCEPTION 'winners must be unique frozen entrants' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audience_result_valid BEFORE INSERT ON "AudienceEventResult" FOR EACH ROW EXECUTE FUNCTION audience_event_result_guard();
