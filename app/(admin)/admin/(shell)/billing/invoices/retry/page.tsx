"use client";
import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PageHead } from "../../../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../../../components/seller/States";
import { adminCan } from "../../../../../../../lib/server/authz/permissions";
import { adminApi } from "../../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../../_components/AdminShell";
import { InvoiceRetry } from "../../../../_components/InvoiceRetry";
import type { PaymentDetail } from "../../../../_components/payments";
import { listReturnTo, selectedIds } from "../../../../_components/selection";
function RetryDetail(){
 const search=useSearchParams(); const {me}=useAdmin(); const ids=useMemo(()=>selectedIds(search.get("ids")),[search]);
 const back=listReturnTo(search.get("returnTo"),"/admin/billing/invoices");
 const [state,setState]=useState<{payments:PaymentDetail[];missing:number}|"loading"|"error">("loading");
 const load=useCallback(async()=>{if(!ids)return; const rs=await Promise.all(ids.map(id=>adminApi<{payment:PaymentDetail}>(`/api/admin/payments/${id}`)));if(rs.some(r=>!r.ok&&r.status!==404))return setState("error");setState({payments:rs.flatMap(r=>r.ok?[r.data.payment]:[]),missing:rs.filter(r=>!r.ok).length});},[ids]);
 useEffect(()=>{void load();},[load]);
 return <><AdminTopbar crumb="구독·요금 › 청구·결제 › 재시도 상세"/><main className="main"><PageHead title="선택한 실패 청구 재시도" actions={<Link className="btn btn-out" href={back}>목록</Link>}/>
 {!adminCan(me.role,"billing.manage")?<p role="alert">최고관리자와 운영 담당만 다시 결제할 수 있습니다.</p>:!ids?<p role="alert">청구를 1~50건 선택해 주십시오.</p>:state==="loading"?<LoadingRows rows={3}/>:state==="error"?<ErrorState title="청구 상태를 확인하지 못했습니다." onRetry={()=>void load()}/>:<>{state.missing>0&&<p role="status">청구 {state.missing}건을 찾을 수 없습니다.</p>}<InvoiceRetry payments={state.payments} onDone={()=>void load()}/></>}
 </main></>;
}
export default function RetryDetailPage(){return <Suspense fallback={null}><RetryDetail/></Suspense>;}
