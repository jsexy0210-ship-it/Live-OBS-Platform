"use client";
import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHead } from "../../../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../../../components/seller/States";
import { adminCan } from "../../../../../../../lib/server/authz/permissions";
import { adminApi, failMessage } from "../../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../../_components/AdminShell";
import { RejectApplicationDialog } from "../../../../_components/RejectApplicationDialog";
import { listReturnTo, selectedIds } from "../../../../_components/selection";
type Result={id:string;ok:boolean;message?:string;undoableUntil?:string;undone?:boolean};
function BulkApplications(){
 const search=useSearchParams(); const router=useRouter(); const {me}=useAdmin(); const ids=useMemo(()=>selectedIds(search.get("ids")),[search]);
 const rejecting=search.get("mode")==="reject"; const back=listReturnTo(search.get("returnTo"),"/admin/partners/applications");
 const [names,setNames]=useState<Record<string,string>|null>(null); const [results,setResults]=useState<Result[]|null>(null); const [busy,setBusy]=useState(false); const [error,setError]=useState<string|null>(null); const [now,setNow]=useState(Date.now);
 useEffect(()=>{let live=true;setNames(null);setResults(null);if(ids)void Promise.all(ids.map(async id=>{const r=await adminApi<{seller:{shopName:string}}>(`/api/admin/sellers/${id}`);return [id,r.ok?r.data.seller.shopName:"조회할 수 없는 신청"] as const;})).then(rows=>{if(live)setNames(Object.fromEntries(rows));});return()=>{live=false;};},[ids]);
 const remaining=results?results.filter(r=>!r.ok||r.undone).map(r=>r.id):ids??[];
 useEffect(()=>{if(!results?.some(r=>r.ok&&!r.undone&&r.undoableUntil&&new Date(r.undoableUntil).getTime()>Date.now()))return;const t=setInterval(()=>setNow(Date.now()),250);return()=>clearInterval(t);},[results]);
 const merge=(next:Result[])=>setResults(old=>old?old.map(r=>next.find(x=>x.id===r.id)??r):next);
 const approve=async()=>{if(busy||!remaining.length)return;setBusy(true);setError(null);const r=await adminApi<{results:Result[]}>("/api/admin/sellers/applications/bulk-approve",{method:"POST",json:{ids:remaining}});setBusy(false);if(!r.ok)return setError(failMessage(r,"선택 승인을 하지 못했습니다. 대상은 그대로입니다."));merge(r.data.results);setNow(Date.now());};
 const undo=async(id:string)=>{if(busy)return;setBusy(true);const r=await adminApi(`/api/admin/sellers/${id}/approve/undo`,{method:"POST",json:{}});setBusy(false);if(!r.ok){setError(failMessage(r,"승인을 되돌리지 못했습니다."));setResults(rs=>rs?.map(x=>x.id===id?{...x,undoableUntil:undefined}:x)??null);return;}setResults(rs=>rs?.map(x=>x.id===id?{...x,undone:true,undoableUntil:undefined}:x)??null);};
 return <><AdminTopbar crumb="파트너스 › 가입 신청 › 선택 처리 상세"/><main className="main"><PageHead title={rejecting?"선택 가입 신청 반려":"선택 가입 신청 승인"} actions={<Link className="btn btn-out" href={back}>목록</Link>}/>
 {!adminCan(me.role,"seller.moderate")?<p role="alert">최고관리자와 운영 담당만 처리할 수 있습니다.</p>:!ids?<p role="alert">가입 신청을 1~50건 선택해 주십시오.</p>:!names?<LoadingRows rows={3}/>:<><section className="card pad-l col" style={{gap:12}}><h2>대상 {ids.length}건</h2><ul>{ids.map(id=><li key={id}><Link href={`/admin/partners/applications/${id}?returnTo=${encodeURIComponent(back)}`}>{names[id]}</Link>{results?.find(r=>r.id===id)?.message}</li>)}</ul><p>이상 없는 신청만 선택 승인할 수 있습니다. 서버에서 현재 상태를 다시 확인하며 일부만 처리될 수 있습니다.</p>
 {error&&<p role="alert">{error}</p>}{results&&<div role="status">성공 {results.filter(r=>r.ok&&!r.undone).length}건 · 실패 {results.filter(r=>!r.ok).length}건 · 되돌림 {results.filter(r=>r.undone).length}건</div>}
 {results?.map(r=>r.ok&&!r.undone&&r.undoableUntil&&new Date(r.undoableUntil).getTime()>now?<button key={r.id} className="btn btn-out" disabled={busy} onClick={()=>void undo(r.id)}>{names[r.id]} 되돌리기 ({Math.max(0,Math.ceil((new Date(r.undoableUntil).getTime()-now)/1000))}초)</button>:null)}
 {!rejecting&&<button className="btn" style={{alignSelf:"flex-start"}} disabled={busy||!remaining.length} onClick={()=>void approve()}>{busy?"처리 중":results?"남은 신청 승인":"선택 승인"}</button>}</section>
 {rejecting&&remaining.length>0&&<RejectApplicationDialog key={remaining.join(",")} bulkIds={remaining} shopName={`선택한 ${remaining.length}건`} fullPage onClose={()=>router.push(back)} onDone={rs=>{if(rs)merge(rs);}} onStale={()=>setError("다른 곳에서 처리됐습니다. 대상 상태를 확인해 주십시오.")}/>}</>}
 </main></>;
}
export default function BulkApplicationPage(){return <Suspense fallback={null}><BulkApplications/></Suspense>;}
