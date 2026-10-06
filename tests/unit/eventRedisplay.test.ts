// 실제 service를 호출하는 단위 회귀시험. DB는 mock이며 native Prisma/PostgreSQL 통합과 구분한다.
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { executeEventSnapshot } from "../../lib/server/events/execution";
import { publishAudienceResult, redisplayAudienceResult } from "../../lib/server/events/service";
vi.mock("../../lib/server/events/execution", { spy: true });
function fixture() {
  const sellerId=randomUUID(),eventId=randomUUID(),roundId=randomUUID(),participants=[randomUUID(),randomUUID()];
  const rules={version:2,kind:"LADDER",winnerCount:1,testMode:true,settings:{allowDuplicateWinners:false,outcomeSlots:[{id:"slot-a",label:"결과 1"},{id:"slot-b",label:"결과 2"}]},previousWinnerIds:[]};
  const result={id:randomUUID(),roundId,testMode:true,winnerEntrantIds:[],execution:executeEventSnapshot({kind:"LADDER",winnerCount:1,settings:rules.settings,entrantIds:participants})};
  const round={id:roundId,result,rulesSnapshot:rules,entrantIds:participants};
  const publications: {id:string;roundId:string;requestKey:string;scope:string;participantId:string|null}[]=[];
  const audits: Record<string,unknown>[]=[];
  const tx={
    $queryRaw:vi.fn(async()=>[{at:new Date()}]),
    audienceEvent:{findFirst:vi.fn(async({where}:{where:{sellerId:string}})=>where.sellerId===sellerId?{id:eventId}:null)},
    audienceEventRound:{findFirst:vi.fn(async()=>round),create:vi.fn()},
    audienceEventResult:{create:vi.fn()},
    audienceEventPublication:{
      count:vi.fn(async()=>publications.length),
      findUnique:vi.fn(async({where}:{where:{sellerId_requestKey:{requestKey:string}}})=>publications.find(row=>row.requestKey===where.sellerId_requestKey.requestKey)??null),
      findMany:vi.fn(async()=>[...publications]),
      create:vi.fn(async({data}:{data:{roundId:string;requestKey:string;scope:string;participantId:string|null}})=>{const row={id:randomUUID(),...data};publications.push(row);return row;}),
    },
    auditLog:{count:vi.fn(async()=>0),findFirst:vi.fn(async({where}:{where:{after:{equals:string}}})=>audits.find(row=>(row.after as {requestKey?:string})?.requestKey===where.after.equals)??null),create:vi.fn(async({data}:{data:Record<string,unknown>})=>{audits.push(data);return{id:randomUUID()};})},
    rewardLedger:{create:vi.fn()},coupon:{create:vi.fn()},shipment:{create:vi.fn()},
  };
  const db={$transaction:async(callback:(value:typeof tx)=>Promise<unknown>)=>callback(tx)} as unknown as PrismaClient;
  const ctx={sellerId,actorType:"SELLER_USER" as const,actorId:randomUUID(),isOwner:true,permissions:[],readOnly:false};
  return {db,ctx,eventId,roundId,participants,result,round,publications,audits,tx};
}
describe("사다리 재표시 공개상태 보존 회귀",()=>{
  it("개별 공개 → 재표시·재시도는 미공개 슬롯을 공개하지 않고 RNG/회차/결과/지급 호출이 없다",async()=>{
    const f=fixture();
    await publishAudienceResult(f.db,f.ctx,f.eventId,{roundId:f.roundId,requestKey:randomUUID(),scope:"PARTICIPANT",participantId:f.participants[0]});
    const before=structuredClone(f.publications),key=randomUUID();vi.mocked(executeEventSnapshot).mockClear();
    for(let retry=0;retry<2;retry++) {
      const restored=await redisplayAudienceResult(f.db,f.ctx,f.eventId,{roundId:f.roundId,requestKey:key});
      expect(restored.publicationState).toEqual({all:false,participantIds:[f.participants[0]]});expect(restored.result).toBe(f.result);
    }
    expect(f.publications).toEqual(before);expect(f.tx.audienceEventPublication.create).toHaveBeenCalledTimes(1);
    expect(vi.mocked(executeEventSnapshot)).not.toHaveBeenCalled();
    for(const write of [f.tx.audienceEventRound.create,f.tx.audienceEventResult.create,f.tx.rewardLedger.create,f.tx.coupon.create,f.tx.shipment.create])expect(write).not.toHaveBeenCalled();
    expect(f.audits.filter(row=>row.action==="audience_event.redisplay")).toHaveLength(1);
  });
  it("아무 공개도 없는 재표시는 비공개 상태이며 명시 ALL 요청 뒤에만 전체 공개가 복원된다",async()=>{
    const f=fixture();
    expect((await redisplayAudienceResult(f.db,f.ctx,f.eventId,{roundId:f.roundId,requestKey:randomUUID()})).publicationState).toEqual({all:false,participantIds:[]});
    expect(f.publications).toHaveLength(0);
    await expect(publishAudienceResult(f.db,f.ctx,f.eventId,{roundId:f.roundId,requestKey:randomUUID()})).rejects.toMatchObject({code:"publication_scope_required"});
    await publishAudienceResult(f.db,f.ctx,f.eventId,{roundId:f.roundId,requestKey:randomUUID(),scope:"ALL"});
    expect((await redisplayAudienceResult(f.db,f.ctx,f.eventId,{roundId:f.roundId,requestKey:randomUUID()})).publicationState.all).toBe(true);
    expect(f.publications).toHaveLength(1);
  });
  it("미확정/다른 판매자/공개 인자를 담은 재표시는 거부한다",async()=>{
    const f=fixture();
    await expect(redisplayAudienceResult(f.db,{...f.ctx,sellerId:randomUUID()},f.eventId,{roundId:f.roundId,requestKey:randomUUID()})).rejects.toMatchObject({code:"not_found"});
    await expect(redisplayAudienceResult(f.db,f.ctx,f.eventId,{roundId:f.roundId,requestKey:randomUUID(),scope:"ALL"} as Parameters<typeof redisplayAudienceResult>[3])).rejects.toMatchObject({code:"invalid_request"});
    f.tx.audienceEventRound.findFirst.mockResolvedValueOnce({...f.round,result:null} as unknown as typeof f.round);
    await expect(redisplayAudienceResult(f.db,f.ctx,f.eventId,{roundId:f.roundId,requestKey:randomUUID()})).rejects.toMatchObject({code:"confirmed_result_required"});
  });
});
