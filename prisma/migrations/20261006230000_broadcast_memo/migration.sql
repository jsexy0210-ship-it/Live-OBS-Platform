ALTER TABLE "BroadcastSession" ADD COLUMN "memo" TEXT;
ALTER TABLE "BroadcastSession" ADD CONSTRAINT "BroadcastSession_memo_len" CHECK ("memo" IS NULL OR char_length("memo") <= 1000);
