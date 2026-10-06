// 실제 service를 DB mock으로 호출한다. native Prisma/API DB 통합 성공을 뜻하지 않는다.
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { anonymizeMemberEventEntries, EVENT_ENTRY_RULES_VERSION, issueEventGuestSession, joinMobileEvent, registerManualEventEntries } from "../../lib/server/events/entries";
import { hashToken } from "../../lib/server/auth/token";
import { sellerHasFeature } from "../../lib/server/billing/features";
vi.mock("../../lib/server/billing/features",()=>({sellerHasFeature:vi.fn(async()=>true)}));
vi.mock("../../lib/server/billing/subscription",()=>({sellerAccessFor:vi.fn(async()=>"active")}));
vi.mock("../../lib/server/auth/session",()=>({resolveBuyerSession:vi.fn(async()=>null)}));
beforeEach(()=>vi.mocked(sellerHasFeature).mockResolvedValue(true));
function fixture() {
  const sellerId=randomUUID(),eventId=randomUUID(),at=new Date(),token=Buffer.alloc(32,1).toString("base64url"),session={id:randomUUID(),sellerId,eventId,tokenHash:hashToken(token),expiresAt:new Date(at.getTime()+3600000)};
  const event={id:eventId,sellerId,broadcastSessionId:randomUUID(),entryMethods:["DIRECT_INPUT","PASTE","MOBILE"],kind:"RANDOM_DRAW",status:"OPEN",closesAt:new Date(at.getTime()+3600000)};
  const entrants: Record<string,unknown>[]=[],batches: Record<string,unknown>[]=[];
  const tx={
    $queryRaw:vi.fn(async(strings:TemplateStringsArray,...values:unknown[])=>strings.join("").includes('SELECT id, "broadcastNickname"')?[{id:values[1],broadcastNickname:"회원 닉네임"}]:[{at}]),$executeRaw:vi.fn(),
    seller:{findUnique:vi.fn(async()=>({status:"ACTIVE"}))},broadcastSession:{findFirst:vi.fn(async()=>({id:event.broadcastSessionId}))},
    audienceEvent:{findFirst:vi.fn(async({where}:{where:{sellerId:string}})=>where.sellerId===sellerId?event:null),findUnique:vi.fn(async()=>event)},
    audienceEventEntryBatch:{findUnique:vi.fn(async({where}:{where:{sellerId_eventId_requestKey:{requestKey:string}}})=>batches.find(b=>b.requestKey===where.sellerId_eventId_requestKey.requestKey)??null),create:vi.fn(async({data}:{data:Record<string,unknown>})=>{const row={id:randomUUID(),...data};batches.push(row);return row;}),updateMany:vi.fn()},
    audienceEventGuestSession:{findUnique:vi.fn(async({where}:{where:{tokenHash:string}})=>where.tokenHash===session.tokenHash?session:null),updateMany:vi.fn(),count:vi.fn(async()=>0),create:vi.fn()},
    audienceEventEntrant:{findMany:vi.fn(async()=>entrants),count:vi.fn(async()=>entrants.length),findUnique:vi.fn(async({where}:{where:{sellerId_eventId_requestKey:{requestKey:string}}})=>entrants.find(e=>e.requestKey===where.sellerId_eventId_requestKey.requestKey)??null),findFirst:vi.fn(async({where}:{where:{guestSessionId?:string;buyerMemberId?:string}})=>entrants.find(e=>where.guestSessionId?e.guestSessionId===where.guestSessionId:e.buyerMemberId===where.buyerMemberId)??null),createMany:vi.fn(async({data}:{data:Record<string,unknown>[]})=>data.forEach(row=>entrants.push({id:randomUUID(),...row}))),create:vi.fn(async({data}:{data:Record<string,unknown>})=>{const row={id:randomUUID(),...data,buyerMemberId:data.buyerMemberId??null,guestSessionId:data.guestSessionId??null};entrants.push(row);return row;})},
    auditLog:{count:vi.fn(async()=>0),create:vi.fn(async()=>({id:randomUUID()}))},rewardLedger:{create:vi.fn()},coupon:{create:vi.fn()},shipment:{create:vi.fn()},audienceEventRound:{create:vi.fn()},audienceEventResult:{create:vi.fn()},
  };
  const db={...tx,$transaction:async(callback:(value:typeof tx)=>Promise<unknown>)=>callback(tx)} as unknown as PrismaClient;
  const ctx={sellerId,actorType:"SELLER_USER" as const,actorId:randomUUID(),isOwner:true,permissions:[],readOnly:false};
  return{db,tx,ctx,eventId,event,session,token,entrants,batches,at};
}
const mobileInput=()=>({requestKey:randomUUID(),displayName:"같은 이름",entryRulesVersion:EVENT_ENTRY_RULES_VERSION,rulesAcknowledged:true});
describe("직접·붙여넣기 참가 service",()=>{
  it("동일 표시명 여러 줄은 별도 UUID이며 동일 요청 재시도는 추가 명단을 만들지 않는다",async()=>{
    const f=fixture(),input={requestKey:randomUUID(),text:"같은 이름\n같은 이름"};
    const first=await registerManualEventEntries(f.db,f.ctx,f.eventId,"PASTE",input);
    const second=await registerManualEventEntries(f.db,f.ctx,f.eventId,"PASTE",input);
    expect(first.acceptedCount).toBe(2);expect(second).toEqual(first);expect(new Set(f.entrants.map(e=>e.id)).size).toBe(2);expect(f.tx.audienceEventEntryBatch.create).toHaveBeenCalledTimes(1);
  });
  it("기존 회원은 표시명이 달라도 회원 ID로 중복을 막는다",async()=>{
    const f=fixture(),buyerMemberId=randomUUID();
    await registerManualEventEntries(f.db,f.ctx,f.eventId,"DIRECT_INPUT",{requestKey:randomUUID(),entries:[{buyerMemberId}]});
    const receipt=await registerManualEventEntries(f.db,f.ctx,f.eventId,"DIRECT_INPUT",{requestKey:randomUUID(),entries:[{buyerMemberId,displayName:"변경 이름"}]});
    expect(receipt.acceptedCount).toBe(0);expect(receipt.alreadyRegisteredCount).toBe(1);expect(f.entrants).toHaveLength(1);
  });
  it("마감/동결 뒤에는 기존 영수증만 복원하며 신규 요청은 차단한다",async()=>{
    const f=fixture(),input={requestKey:randomUUID(),entries:[{displayName:"참가"}]};
    const first=await registerManualEventEntries(f.db,f.ctx,f.eventId,"DIRECT_INPUT",input);f.event.status="FROZEN";f.event.closesAt=new Date(0);
    expect(await registerManualEventEntries(f.db,f.ctx,f.eventId,"DIRECT_INPUT",input)).toEqual(first);
    await expect(registerManualEventEntries(f.db,f.ctx,f.eventId,"DIRECT_INPUT",{...input,requestKey:randomUUID()})).rejects.toMatchObject({code:"entry_closed"});
  });
  it("타 판매자/미허용 출처/플랜 제한은 명단 생성 전에 차단한다",async()=>{
    const f=fixture(),input={requestKey:randomUUID(),text:"이름"};
    await expect(registerManualEventEntries(f.db,{...f.ctx,sellerId:randomUUID()},f.eventId,"PASTE",input)).rejects.toMatchObject({code:"not_found"});
    f.event.entryMethods=["MOBILE"];await expect(registerManualEventEntries(f.db,f.ctx,f.eventId,"PASTE",input)).rejects.toMatchObject({code:"entry_method_not_enabled"});
    f.event.entryMethods=["PASTE"];vi.mocked(sellerHasFeature).mockResolvedValue(false);await expect(registerManualEventEntries(f.db,f.ctx,f.eventId,"PASTE",input)).rejects.toMatchObject({code:"event_unavailable"});expect(f.entrants).toHaveLength(0);
  });
  it("동일 요청키의 다른 내용 및 비식별된 batch 재시도는 충돌로 처리한다",async()=>{
    const f=fixture(),input={requestKey:randomUUID(),text:"이름"};await registerManualEventEntries(f.db,f.ctx,f.eventId,"PASTE",input);
    await expect(registerManualEventEntries(f.db,f.ctx,f.eventId,"PASTE",{...input,text:"다른 이름"})).rejects.toMatchObject({code:"idempotency_conflict"});
    f.batches[0].requestHash=null;await expect(registerManualEventEntries(f.db,f.ctx,f.eventId,"PASTE",input)).rejects.toMatchObject({code:"entry_batch_anonymized"});
  });
});
describe("모바일 opaque session 참가 service",()=>{
  it("유효한 쿠키는 같은 session으로 복원되고 새 토큰은 hash만 저장한다",async()=>{
    const f=fixture();expect((await issueEventGuestSession(f.db,f.eventId,f.token)).token).toBe(f.token);expect(f.tx.audienceEventGuestSession.create).not.toHaveBeenCalled();
    const issued=await issueEventGuestSession(f.db,f.eventId);expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(f.tx.audienceEventGuestSession.create).toHaveBeenCalledWith({data:expect.objectContaining({tokenHash:hashToken(issued.token)})});expect(f.tx.audienceEventGuestSession.create.mock.calls[0][0].data).not.toHaveProperty("token");
  });
  it("게스트 참가·마감 뒤 재시도는 같은 UUID이며 무회차·무실지급이다",async()=>{
    const f=fixture(),input=mobileInput(),credentials={guestToken:f.token};const first=await joinMobileEvent(f.db,f.eventId,input,credentials);f.event.status="FROZEN";
    const retry=await joinMobileEvent(f.db,f.eventId,input,credentials);expect(retry.entrant.id).toBe(first.entrant.id);expect(retry.alreadyRegistered).toBe(true);expect(f.entrants).toHaveLength(1);
    for(const fn of [f.tx.rewardLedger.create,f.tx.coupon.create,f.tx.shipment.create,f.tx.audienceEventRound.create,f.tx.audienceEventResult.create])expect(fn).not.toHaveBeenCalled();
  });
  it("같은 guest identity는 다른 요청키에도 한 명이며 다른 이름 재시도는 충돌한다",async()=>{
    const f=fixture(),input=mobileInput();await joinMobileEvent(f.db,f.eventId,input,{guestToken:f.token});
    expect((await joinMobileEvent(f.db,f.eventId,{...input,requestKey:randomUUID()},{guestToken:f.token})).alreadyRegistered).toBe(true);
    await expect(joinMobileEvent(f.db,f.eventId,{...input,displayName:"변경"},{guestToken:f.token})).rejects.toMatchObject({code:"idempotency_conflict"});expect(f.entrants).toHaveLength(1);
  });
  it("동결/미고지/타 이벤트 또는 만료된 guest credential은 차단한다",async()=>{
    const f=fixture(),input=mobileInput();await expect(joinMobileEvent(f.db,f.eventId,{...input,rulesAcknowledged:false},{guestToken:f.token})).rejects.toMatchObject({code:"entry_rules_required"});
    f.session.eventId=randomUUID();await expect(joinMobileEvent(f.db,f.eventId,input,{guestToken:f.token})).rejects.toMatchObject({status:401});f.session.eventId=f.eventId;f.session.expiresAt=new Date(0);await expect(joinMobileEvent(f.db,f.eventId,input,{guestToken:f.token})).rejects.toMatchObject({status:401});
    f.session.expiresAt=new Date(f.at.getTime()+3600000);f.event.status="FROZEN";await expect(joinMobileEvent(f.db,f.eventId,input,{guestToken:f.token})).rejects.toMatchObject({code:"entry_closed"});expect(f.entrants).toHaveLength(0);
  });
  it("세션 발급 및 참가 속도 제한은 새 저장 이전에 적용한다",async()=>{
    const f=fixture();f.tx.audienceEventGuestSession.count.mockResolvedValue(300);await expect(issueEventGuestSession(f.db,f.eventId)).rejects.toMatchObject({code:"rate_limited"});
    f.tx.auditLog.count.mockResolvedValue(20);await expect(joinMobileEvent(f.db,f.eventId,mobileInput(),{guestToken:f.token})).rejects.toMatchObject({code:"rate_limited"});expect(f.entrants).toHaveLength(0);
  });
  it("탈퇴 hook은 개인칸과 관련 hash만 지우고 회차·결과를 쓰지 않는다",async()=>{
    const f=fixture(),batchId=randomUUID();f.tx.$queryRaw.mockResolvedValueOnce([{at:f.at}]).mockResolvedValueOnce([{at:f.at}]).mockResolvedValueOnce([{batchId}] as unknown as {at:Date}[]);
    expect(await anonymizeMemberEventEntries(f.tx as unknown as Parameters<typeof anonymizeMemberEventEntries>[0],{sellerId:f.ctx.sellerId,buyerMemberId:randomUUID()},f.at)).toEqual({anonymizedEventEntries:1});expect(f.tx.audienceEventEntryBatch.updateMany).toHaveBeenCalledWith({where:{sellerId:f.ctx.sellerId,id:{in:[batchId]}},data:{requestHash:null}});
    expect(f.tx.audienceEventRound.create).not.toHaveBeenCalled();expect(f.tx.audienceEventResult.create).not.toHaveBeenCalled();
  });
});
