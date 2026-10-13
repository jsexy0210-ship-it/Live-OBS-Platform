import React from "react";
import { createRoot } from "react-dom/client";
import { PageHead } from "../../../components/admin-ui/PageHead";
import { ListHead, ListTable } from "../../../components/admin-ui/ListTable";

createRoot(document.getElementById("root")!).render(<main className="app c24 seller-app" style={{ padding: 16, minWidth: 0 }}>
  <PageHead title="주문 목록" description="검색 조건을 확인하고 선택한 주문을 처리합니다." actions={<button className="btn">주문 추가</button>} />
  <section className="au-list-section" style={{ marginTop: 16 }}>
    <div><input aria-label="검색어" placeholder="검색어 입력" /><input aria-label="읽기 전용" readOnly value="확정된 값" /></div>
    <ListHead total={2} actions={<button className="btn">선택 처리</button>} />
    <ListTable aria-label="주문 목록 표"><table className="tbl"><thead><tr><th>주문번호</th><th>상품</th><th>상태</th></tr></thead><tbody><tr><td>TEST-1</td><td>테스트 상품</td><td>대기</td></tr><tr><td>TEST-2</td><td>테스트 상품</td><td>완료</td></tr></tbody></table></ListTable>
  </section>
  <section style={{ marginTop: 40 }}><PageHead title="상세 화면" description="내용을 확인하고 수정할 수 있습니다." back="/seller/orders" actions={<button className="btn">저장</button>} /></section>
</main>);
