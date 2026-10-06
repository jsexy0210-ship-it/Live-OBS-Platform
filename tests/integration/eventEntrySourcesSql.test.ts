// 실제 PostgreSQL 제약 시험. Prisma 서비스/API 통합 시험을 대신하지 않는다.
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
const client = new Client({ connectionString: assertTestDatabaseUrl(process.env.DATABASE_URL) });
let sellerId: string, eventId: string, batchId: string;
beforeAll(() => client.connect()); afterAll(() => client.end());
beforeEach(async () => {
  await client.query("BEGIN"); sellerId=randomUUID();eventId=randomUUID();batchId=randomUUID();const broadcastId=randomUUID();
  await client.query('INSERT INTO "Seller" (id,slug,"shopName") VALUES ($1,$2,$2)',[sellerId,sellerId]);
  await client.query('INSERT INTO "BroadcastSession" (id,"sellerId") VALUES ($1,$2)',[broadcastId,sellerId]);
  await client.query('INSERT INTO "AudienceEvent" (id,"sellerId","broadcastSessionId",kind,title,"entryMethods","winnerCount","testMode","requestKey","requestHash","noticeAcknowledgedAt","closesAt") VALUES ($1,$2,$3,\'RANDOM_DRAW\',\'참가 시험\',ARRAY[\'DIRECT_INPUT\',\'PASTE\',\'MOBILE\']::"AudienceEventEntrySource"[],1,true,$4,\'hash\',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+interval \'1 hour\')',[eventId,sellerId,broadcastId,randomUUID()]);
  await client.query('INSERT INTO "AudienceEventEntryBatch" (id,"sellerId","eventId","requestKey","requestHash",method,"inputCount","acceptedCount") VALUES ($1,$2,$3,$4,\'hash\',\'DIRECT_INPUT\',100,0)',[batchId,sellerId,eventId,randomUUID()]);
});
afterEach(() => client.query("ROLLBACK").then(()=>undefined));
async function member() {
  const grade=randomUUID(),id=randomUUID();
  await client.query('INSERT INTO "MemberGrade" (id,"sellerId","displayName","sortOrder") VALUES ($1::uuid,$2,$1::text,0)',[grade,sellerId]);
  await client.query('INSERT INTO "BuyerMember" (id,"sellerId","loginId","passwordHash",name,phone,"ciHash","identityVerifiedAt","broadcastNickname","gradeId") VALUES ($1::uuid,$2,$1::text,\'test-only\',\'시험\',$1::text,$1::text,CURRENT_TIMESTAMP,$1::text,$3)',[id,sellerId,grade]);
  return id;
}
async function direct(row=1,buyerMemberId: string|null=null,source="DIRECT_INPUT",selectedBatch=batchId) {
  return client.query('INSERT INTO "AudienceEventEntrant" ("sellerId","eventId",source,"batchId","rowNumber","buyerMemberId","displayName","publishedAt") VALUES ($1,$2,$3,$4,$5,$6,\'동일 이름\',CURRENT_TIMESTAMP) RETURNING *',[sellerId,eventId,source,selectedBatch,row,buyerMemberId]);
}
async function guest(expired=false) {
  const id=randomUUID();
  await client.query('INSERT INTO "AudienceEventGuestSession" (id,"sellerId","eventId","tokenHash","createdAt","expiresAt") VALUES ($1::uuid,$2,$3,$1::text,CURRENT_TIMESTAMP-interval \'2 hours\',CURRENT_TIMESTAMP+($4::int * interval \'1 hour\'))',[id,sellerId,eventId,expired?-1:1]);return id;
}
async function mobile(id: string,buyer=false,key=randomUUID()) {
  return client.query('INSERT INTO "AudienceEventEntrant" ("sellerId","eventId",source,"buyerMemberId","guestSessionId","requestKey","requestHash","displayName","entryRulesVersion","rulesAcknowledgedAt","publishedAt") VALUES ($1,$2,\'MOBILE\',$3,$4,$5,\'hash\',\'동일 이름\',\'audience-entry-v1\',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING *',[sellerId,eventId,buyer?id:null,buyer?null:id,key]);
}
describe("공통 참가 출처 실제 PostgreSQL 제약",()=>{
  it("YouTube 연결 없이 직접·붙여넣기 이벤트를 열고 동일 표시명을 별도 UUID로 저장한다",async()=>{
    const first=(await direct()).rows[0],second=(await direct(2,null,"PASTE")).rows[0];
    expect(first.id).not.toBe(second.id);expect(first.displayName).toBe(second.displayName);
    expect((await client.query('SELECT "liveLinkId",keyword FROM "AudienceEvent" WHERE id=$1',[eventId])).rows[0]).toEqual({liveLinkId:null,keyword:null});
  });
  it("batch row 재입력은 DB unique 제약으로 막는다",async()=>{await direct();await expect(direct()).rejects.toMatchObject({code:"23505"});});
  it("기존 회원 ID는 직접·모바일 출처 사이에서도 한 번만 등록된다",async()=>{const id=await member();await direct(1,id);await expect(mobile(id,true)).rejects.toMatchObject({code:"23505"});});
  it("다른 게스트 세션은 같은 표시명이더라도 별도 참가자다",async()=>{const a=(await mobile(await guest())).rows[0],b=(await mobile(await guest())).rows[0];expect(a.id).not.toBe(b.id);expect(a.displayName).toBe(b.displayName);});
  it("같은 게스트 세션의 재등록은 막는다",async()=>{const id=await guest();await mobile(id);await expect(mobile(id)).rejects.toMatchObject({code:"23505"});});
  it("모바일 request key는 다른 게스트도 재사용할 수 없다",async()=>{const key=randomUUID();await mobile(await guest(),false,key);await expect(mobile(await guest(),false,key)).rejects.toMatchObject({code:"23505"});});
  it("만료된 게스트 세션은 참가할 수 없다",async()=>{await expect(mobile(await guest(true))).rejects.toMatchObject({code:"23514"});});
  it("활성 회원의 표시 정보 변경은 비식별 예외로 우회할 수 없다",async()=>{const id=await member();await direct(1,id);await expect(client.query('UPDATE "AudienceEventEntrant" SET "buyerMemberId"=NULL,"displayName"=\'탈퇴한 회원\',"anonymizedAt"=CURRENT_TIMESTAMP')).rejects.toMatchObject({code:"23514"});});
  it("동결 뒤 탈퇴 비식별은 참가 UUID와 불변 회차 명단을 보존한다",async()=>{
    const id=await member(),entrant=(await direct(1,id)).rows[0],roundId=randomUUID();
    await client.query('UPDATE "AudienceEvent" SET status=\'FROZEN\' WHERE id=$1',[eventId]);
    await client.query('INSERT INTO "AudienceEventRound" (id,"sellerId","eventId","rulesSnapshot","entrantIds") VALUES ($1,$2,$3,$4,$5)',[roundId,sellerId,eventId,JSON.stringify({kind:"RANDOM_DRAW",keyword:null,entryMethods:["DIRECT_INPUT","PASTE","MOBILE"],winnerCount:1,testMode:true}),JSON.stringify([entrant.id])]);
    const before=(await client.query('SELECT * FROM "AudienceEventRound" WHERE id=$1',[roundId])).rows[0];
    await client.query('UPDATE "BuyerMember" SET status=\'WITHDRAWN\',"deletedAt"=CURRENT_TIMESTAMP WHERE id=$1',[id]);
    await client.query('UPDATE "AudienceEventEntrant" SET "buyerMemberId"=NULL,"displayName"=\'탈퇴한 회원\',"anonymizedAt"=CURRENT_TIMESTAMP,"requestKey"=NULL,"requestHash"=NULL WHERE id=$1',[entrant.id]);
    expect((await client.query('SELECT id,"buyerMemberId","displayName","batchId","rowNumber" FROM "AudienceEventEntrant" WHERE id=$1',[entrant.id])).rows[0]).toEqual({id:entrant.id,buyerMemberId:null,displayName:"탈퇴한 회원",batchId,rowNumber:1});
    expect((await client.query('SELECT * FROM "AudienceEventRound" WHERE id=$1',[roundId])).rows[0]).toEqual(before);
  });
  it("비식별 예외에서도 entrant UUID 교체는 거부한다",async()=>{const id=await member();await direct(1,id);await client.query('UPDATE "BuyerMember" SET status=\'WITHDRAWN\',"deletedAt"=CURRENT_TIMESTAMP WHERE id=$1',[id]);await expect(client.query('UPDATE "AudienceEventEntrant" SET id=$1,"buyerMemberId"=NULL,"displayName"=\'탈퇴한 회원\',"anonymizedAt"=CURRENT_TIMESTAMP',[randomUUID()])).rejects.toMatchObject({code:"23514"});});
  it("동결 뒤 모든 신규 직접 참가를 차단한다",async()=>{await client.query('UPDATE "AudienceEvent" SET status=\'FROZEN\' WHERE id=$1',[eventId]);await expect(direct()).rejects.toMatchObject({code:"23514"});});
  it("허용하지 않은 YouTube 출처는 채널 ID가 있어도 거부한다",async()=>{await expect(client.query('INSERT INTO "AudienceEventEntrant" ("sellerId","eventId","authorChannelId","messageId","displayName","publishedAt") VALUES ($1,$2,$3,\'message\',\'이름\',CURRENT_TIMESTAMP)',[sellerId,eventId,"UC"+"1".repeat(22)])).rejects.toMatchObject({code:"23514"});});
  it("이벤트 참가 출처는 설정 뒤 바꿀 수 없다",async()=>{await expect(client.query('UPDATE "AudienceEvent" SET "entryMethods"=ARRAY[\'MOBILE\']::"AudienceEventEntrySource"[] WHERE id=$1',[eventId])).rejects.toMatchObject({code:"23514"});});
  it("확정 회차 snapshot에서 실제 출처를 누락할 수 없다",async()=>{await direct();await client.query('UPDATE "AudienceEvent" SET status=\'FROZEN\' WHERE id=$1',[eventId]);await expect(client.query('INSERT INTO "AudienceEventRound" ("sellerId","eventId","rulesSnapshot","entrantIds") VALUES ($1,$2,$3,$4)',[sellerId,eventId,JSON.stringify({kind:"RANDOM_DRAW",keyword:null,winnerCount:1,testMode:true}),JSON.stringify([])])).rejects.toMatchObject({code:"23514"});});
  it("없는 타 판매자 batch를 참조할 수 없다",async()=>{await expect(direct(1,null,"DIRECT_INPUT",randomUUID())).rejects.toMatchObject({code:"23503"});});
  it("탈퇴 잠금과 경쟁하는 참가 요청은 commit 뒤 탈퇴 회원을 받아들이지 않는다",async()=>{
    const id=await member();await client.query("COMMIT");
    const contender=new Client({connectionString:assertTestDatabaseUrl(process.env.DATABASE_URL)});await contender.connect();
    try {
      await client.query("BEGIN");await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`order_no:${sellerId}`]);
      await client.query('SELECT id FROM "BuyerMember" WHERE id=$1 FOR SHARE',[id]);await client.query('UPDATE "BuyerMember" SET status=\'WITHDRAWN\',"deletedAt"=CURRENT_TIMESTAMP WHERE id=$1',[id]);
      await contender.query("BEGIN");const waiting=contender.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`order_no:${sellerId}`]);
      await client.query("COMMIT");await waiting;
      await contender.query('SELECT id FROM "Seller" WHERE id=$1 FOR UPDATE',[sellerId]);
      await expect(contender.query('INSERT INTO "AudienceEventEntrant" ("sellerId","eventId",source,"batchId","rowNumber","buyerMemberId","displayName","publishedAt") VALUES ($1,$2,\'DIRECT_INPUT\',$3,1,$4,\'경쟁\',CURRENT_TIMESTAMP)',[sellerId,eventId,batchId,id])).rejects.toMatchObject({code:"23514"});
    } finally {await contender.query("ROLLBACK");await contender.end();}
  });
  it("참가 insert의 event 잠금은 명단 확정과 직렬화하고 commit한 UUID를 보존한다",async()=>{
    await client.query("COMMIT");const freezer=new Client({connectionString:assertTestDatabaseUrl(process.env.DATABASE_URL)});await freezer.connect();
    try {
      await client.query("BEGIN");const entrant=(await direct()).rows[0];
      await freezer.query("BEGIN");const freezing=freezer.query('UPDATE "AudienceEvent" SET status=\'FROZEN\' WHERE id=$1',[eventId]);
      await client.query("COMMIT");await freezing;
      expect((await freezer.query('SELECT id FROM "AudienceEventEntrant" WHERE "eventId"=$1',[eventId])).rows.map(row=>row.id)).toEqual([entrant.id]);await freezer.query("COMMIT");
      await client.query("BEGIN");await expect(direct(2)).rejects.toMatchObject({code:"23514"});
    } finally {await freezer.query("ROLLBACK");await freezer.end();}
  });
});
