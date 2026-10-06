import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseDirectEntries, parsePastedEntries } from "../../lib/server/events/entryInput";
describe("공통 참가 직접입력/붙여넣기 서버 입력 계약",()=>{
  it("이름이 같은 직접 입력도 별개의 줄로 유지하며 기존 회원ID는 명시 입력만 받는다",()=>{
    const buyerMemberId=randomUUID();
    const value=parseDirectEntries({requestKey:randomUUID(),entries:[{displayName:"같은 이름"},{displayName:"같은 이름"},{buyerMemberId}]});
    expect(value.entries).toEqual([{displayName:"같은 이름"},{displayName:"같은 이름"},{buyerMemberId}]);expect(value.method).toBe("DIRECT_INPUT");
  });
  it("여러 줄의 CRLF/공백은 정규화하지만 같은 이름을 중복 제거하지 않는다",()=>{
    const value=parsePastedEntries({requestKey:randomUUID(),text:"  같은 이름 \r\n\n같은 이름\r다른 이름 "});
    expect(value.entries).toEqual([{displayName:"같은 이름"},{displayName:"같은 이름"},{displayName:"다른 이름"}]);expect(value.method).toBe("PASTE");
  });
  it("재시도 hash는 정규화한 의미와 입력 순서/종류를 사용한다",()=>{
    const requestKey=randomUUID();
    expect(parsePastedEntries({requestKey,text:" 가 \n나"}).requestHash).toBe(parsePastedEntries({requestKey,text:"가\r\n나\n"}).requestHash);
    expect(parsePastedEntries({requestKey,text:"가\n나"}).requestHash).not.toBe(parsePastedEntries({requestKey,text:"나\n가"}).requestHash);
    expect(parsePastedEntries({requestKey,text:"가"}).requestHash).not.toBe(parseDirectEntries({requestKey,entries:[{displayName:"가"}]}).requestHash);
  });
  it("임의 stableID/YouTube authorID/제어문자/빈 입력은 거부한다",()=>{
    for(const input of [{requestKey:randomUUID(),entries:[{displayName:"참가",authorChannelId:"UCwrong"}]},{requestKey:randomUUID(),entries:[{displayName:"참가",id:randomUUID()}]},{requestKey:randomUUID(),entries:[{displayName:"참\n가"}]},{requestKey:randomUUID(),entries:[]}])expect(()=>parseDirectEntries(input)).toThrow("invalid_entry_input");
    expect(()=>parsePastedEntries({requestKey:randomUUID(),text:" \n "})).toThrow("invalid_entry_input");
  });
  it("한 요청100줄·표시명100문자·같은 기존회원ID 반복을 엄격 검증한다",()=>{
    expect(()=>parsePastedEntries({requestKey:randomUUID(),text:Array(101).fill("참가").join("\n")})).toThrow("invalid_entry_input");
    expect(()=>parseDirectEntries({requestKey:randomUUID(),entries:[{displayName:"가".repeat(101)}]})).toThrow("invalid_entry_input");
    const id=randomUUID();expect(()=>parseDirectEntries({requestKey:randomUUID(),entries:[{buyerMemberId:id},{buyerMemberId:id}]})).toThrow("invalid_entry_input");
  });
});
