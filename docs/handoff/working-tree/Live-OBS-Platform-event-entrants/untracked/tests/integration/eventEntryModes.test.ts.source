import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createAudienceEvent, freezeAudienceEvent } from "../../lib/server/events/service";
import { EVENT_ENTRY_RULES_VERSION, issueEventGuestSession, joinMobileEvent, registerManualEventEntries } from "../../lib/server/events/entries";
import { POST as publicAction } from "../../app/api/public/events/[eventId]/[action]/route";
import { withdrawBuyer } from "../../lib/server/buyers/withdraw";
import { hashPassword } from "../../lib/server/auth/password";
import { createBuyer, createSeller, createSellerUser, db, PASSWORD, resetDb } from "./helpers";
beforeEach(resetDb); afterAll(()=>db.$disconnect());
async function setup() {
  const {seller,grade}=await createSeller(),owner=await createSellerUser(seller.id,"OWNER"),broadcast=await db.broadcastSession.create({data:{sellerId:seller.id}});
  const ctx={sellerId:seller.id,actorType:"SELLER_USER" as const,actorId:owner.id,isOwner:true,permissions:[],readOnly:false};
  const event=await createAudienceEvent(db,ctx,{kind:"RANDOM_DRAW",entryMethods:["DIRECT_INPUT","PASTE","MOBILE"],broadcastSessionId:broadcast.id,title:"공통 참가",winnerCount:1,testMode:true,requestKey:randomUUID(),sellerNoticeAcknowledged:true,closesAt:new Date(Date.now()+3600000).toISOString()});
  return{ctx,event,grade};
}
const input=()=>({requestKey:randomUUID(),displayName:"같은 이름",entryRulesVersion:EVENT_ENTRY_RULES_VERSION,rulesAcknowledged:true});
describe("공통 참가 실제 Prisma/service/API DB 통합",()=>{
  it("동시 paste 재시도는 하나의 batch와 동일 표시명 두 UUID만 저장한다",async()=>{
    const s=await setup(),body={requestKey:randomUUID(),text:"이름\n이름"};const values=await Promise.all([registerManualEventEntries(db,s.ctx,s.event.id,"PASTE",body),registerManualEventEntries(db,s.ctx,s.event.id,"PASTE",body)]);
    expect(values[0]).toEqual(values[1]);expect(await db.audienceEventEntryBatch.count()).toBe(1);expect(await db.audienceEventEntrant.count()).toBe(2);
  });
  it("게스트 동시 join은 하나의 참가자이며 표시명이 같아도 다른 세션은 별도 UUID다",async()=>{
    const s=await setup(),guest=await issueEventGuestSession(db,s.event.id),body=input();const values=await Promise.all([joinMobileEvent(db,s.event.id,body,{guestToken:guest.token}),joinMobileEvent(db,s.event.id,body,{guestToken:guest.token})]);expect(values[0].entrant.id).toBe(values[1].entrant.id);
    const other=await issueEventGuestSession(db,s.event.id);expect((await joinMobileEvent(db,s.event.id,input(),{guestToken:other.token})).entrant.id).not.toBe(values[0].entrant.id);
    for(const count of [db.rewardLedger.count(),db.coupon.count(),db.shipment.count(),db.audienceEventResult.count()])expect(await count).toBe(0);
  });
  it("명단 확정 경쟁에서는 저장 참가자가 snapshot에 포함되거나 신규 요청이 차단된다",async()=>{
    const s=await setup();await registerManualEventEntries(db,s.ctx,s.event.id,"PASTE",{requestKey:randomUUID(),text:"선등록"});
    const [entry,frozen]=await Promise.allSettled([registerManualEventEntries(db,s.ctx,s.event.id,"PASTE",{requestKey:randomUUID(),text:"경쟁"}),freezeAudienceEvent(db,s.ctx,s.event.id)]);expect(frozen.status).toBe("fulfilled");
    const saved=await db.audienceEventEntrant.findMany({where:{eventId:s.event.id}}),round=await db.audienceEventRound.findFirstOrThrow({where:{eventId:s.event.id}});expect([...(round.entrantIds as string[])].sort()).toEqual(saved.map(row=>row.id).sort());if(entry.status==="rejected")expect(entry.reason).toMatchObject({code:"entry_closed"});
  });
  it("공개 join API는 Origin 불일치 및 규칙 확인 없는 참가를 차단한다",async()=>{
    const s=await setup(),guest=await issueEventGuestSession(db,s.event.id),params=Promise.resolve({eventId:s.event.id,action:"join"});
    const req=(origin:string,body:unknown)=>new Request(`http://localhost:3000/api/public/events/${s.event.id}/join`,{method:"POST",headers:{origin,host:"localhost:3000",cookie:`lo_event_guest=${guest.token}`,"content-type":"application/json"},body:JSON.stringify(body)});
    expect((await publicAction(req("https://foreign.invalid",input()),{params})).status).toBe(403);
    expect((await publicAction(req("http://localhost:3000",{...input(),rulesAcknowledged:false}),{params})).status).toBe(400);expect(await db.audienceEventEntrant.count()).toBe(0);
  });
  it("타 판매자 수동 입력과 타 이벤트 게스트 쿠키는 거부한다",async()=>{
    const a=await setup(),b=await setup(),guest=await issueEventGuestSession(db,a.event.id);
    await expect(registerManualEventEntries(db,b.ctx,a.event.id,"PASTE",{requestKey:randomUUID(),text:"이름"})).rejects.toMatchObject({code:"not_found"});await expect(joinMobileEvent(db,b.event.id,input(),{guestToken:guest.token})).rejects.toMatchObject({status:401});
  });
  it("기존 회원 탈퇴 hook은 확정 명단 UUID를 보존하고 개인칸과 batch hash를 비식별한다",async()=>{
    const s=await setup(),buyer=await createBuyer(s.ctx.sellerId,s.grade.id);await db.buyerMember.update({where:{id:buyer.id},data:{passwordHash:await hashPassword(PASSWORD)}});
    const receipt=await registerManualEventEntries(db,s.ctx,s.event.id,"DIRECT_INPUT",{requestKey:randomUUID(),entries:[{buyerMemberId:buyer.id}]});const frozen=await freezeAudienceEvent(db,s.ctx,s.event.id);
    expect(await withdrawBuyer(db,{sellerId:s.ctx.sellerId,buyerMemberId:buyer.id},{password:PASSWORD})).toEqual({ok:true});
    expect(await db.audienceEventEntrant.findUnique({where:{id:receipt.entrants[0].id}})).toMatchObject({id:receipt.entrants[0].id,buyerMemberId:null,displayName:"탈퇴한 회원",requestHash:null});
    expect((await db.audienceEventRound.findUniqueOrThrow({where:{id:frozen.id}})).entrantIds).toEqual(frozen.entrantIds);expect((await db.audienceEventEntryBatch.findUniqueOrThrow({where:{id:receipt.batchId}})).requestHash).toBeNull();
  });
  it("동시 탈퇴·회원 참가·명단 확정은 deadlock 없이 UUID 일치와 개인칸 비식별을 유지한다",async()=>{
    const s=await setup(),buyer=await createBuyer(s.ctx.sellerId,s.grade.id);await db.buyerMember.update({where:{id:buyer.id},data:{passwordHash:await hashPassword(PASSWORD)}});
    await registerManualEventEntries(db,s.ctx,s.event.id,"PASTE",{requestKey:randomUUID(),text:"선등록"});
    const values=await Promise.allSettled([withdrawBuyer(db,{sellerId:s.ctx.sellerId,buyerMemberId:buyer.id},{password:PASSWORD}),registerManualEventEntries(db,s.ctx,s.event.id,"DIRECT_INPUT",{requestKey:randomUUID(),entries:[{buyerMemberId:buyer.id}]}),freezeAudienceEvent(db,s.ctx,s.event.id)]);
    expect(values[0]).toEqual({status:"fulfilled",value:{ok:true}});expect(values[2].status).toBe("fulfilled");
    const entries=await db.audienceEventEntrant.findMany({where:{eventId:s.event.id}}),round=await db.audienceEventRound.findFirstOrThrow({where:{eventId:s.event.id}});expect([...(round.entrantIds as string[])].sort()).toEqual(entries.map(e=>e.id).sort());expect(entries.every(e=>e.buyerMemberId===null)).toBe(true);
    if(values[1].status==="rejected")expect(values[1].reason.code).toMatch(/entry_closed|member_not_found/);
  });
});
