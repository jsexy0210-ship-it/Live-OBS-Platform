import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { MEMBER_REFERENCE_POLICY } from "../../lib/server/buyers/memberData";
import { cancelAudienceEvent, createAudienceEvent, createNextAudienceRound, drawAudienceEvent, freezeAudienceEvent, publishAudienceResult, redisplayAudienceResult } from "../../lib/server/events/service";
describe("이벤트 운영 행위자는 구매자 참가자와 분리한다",()=>{
  it("신규 두 actorId 칸의 탈퇴 분류를 명시한다(공식 generated DMMF 검증과 별개)",()=>{
    for(const field of ["AudienceEventRound.actorId","AudienceEventPublication.actorId"])expect(MEMBER_REFERENCE_POLICY[field]).toMatchObject({policy:"anonymize",note:expect.stringContaining("BUYER 금지")});
  });
  it.each(["open","freeze","draw","next-round","publish","redisplay","cancel"])("%s는 구매자 실행 컨텍스트를 DB 호출 전에 거부한다",async(action)=>{
    const tx=vi.fn(),db={$transaction:tx} as unknown as PrismaClient;
    const ctx={sellerId:randomUUID(),actorType:"BUYER" as const,actorId:randomUUID(),isOwner:true,permissions:[],readOnly:false},id=randomUUID();
    const calls={open:()=>createAudienceEvent(db,ctx,{}),freeze:()=>freezeAudienceEvent(db,ctx,id),draw:()=>drawAudienceEvent(db,ctx,id),"next-round":()=>createNextAudienceRound(db,ctx,id,{}),publish:()=>publishAudienceResult(db,ctx,id,{}),redisplay:()=>redisplayAudienceResult(db,ctx,id,{}),cancel:()=>cancelAudienceEvent(db,ctx,id)};
    await expect(calls[action as keyof typeof calls]()).rejects.toMatchObject({status:403,code:"forbidden"});expect(tx).not.toHaveBeenCalled();
  });
});
