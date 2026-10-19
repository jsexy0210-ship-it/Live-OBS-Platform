import { describe, expect, it } from "vitest";
import { listReturnTo, selectedIds, selectionHref } from "../../app/(admin)/admin/_components/selection";
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12,"0")}`;
describe("관리자 상세 선택과 복귀", () => {
 it("현재 쪽과 무관한 50개 ID를 순서대로 복원한다",()=>{const ids=Array.from({length:50},(_,i)=>id(i));const href=selectionHref("/admin/partners/bulk-note",ids,"/admin/partners?q=abc&page=3");const p=new URL(href,"https://admin.invalid").searchParams;expect(selectedIds(p.get("ids"))).toEqual(ids);expect(listReturnTo(p.get("returnTo"),"/admin/partners")).toBe("/admin/partners?q=abc&page=3");});
 it("빈 선택·중복·잘못된 ID·51개는 처리 대상으로 만들지 않는다",()=>{for(const v of [null,"",`${id(1)},${id(1)}`,"wrong",Array.from({length:51},(_,i)=>id(i)).join(",")])expect(selectedIds(v)).toBeNull();});
 it("외부주소·다른 메뉴·유사 접두어로 복귀하지 않는다",()=>{for(const v of ["https://evil.invalid/admin/partners","//evil.invalid/admin/partners","/admin/accounts","/admin/partners-evil"])expect(listReturnTo(v,"/admin/partners")).toBe("/admin/partners");});
});
