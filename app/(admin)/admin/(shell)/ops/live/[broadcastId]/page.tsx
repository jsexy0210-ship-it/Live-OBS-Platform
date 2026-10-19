"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PageHead } from "../../../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../../../components/seller/States";
import { adminCan } from "../../../../../../../lib/server/authz/permissions";
import { adminApi } from "../../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../../_components/AdminShell";
import { listReturnTo } from "../../../../_components/selection";
import { setFlash } from "../../../../_components/flash";
import { ForceEndDialog } from "../../../../_components/ForceEndDialog";
import type { LiveBroadcast } from "../../../../_components/ops";
export default function LiveDetailPage(){
 const {broadcastId}=useParams<{broadcastId:string}>(); const router=useRouter(); const {me}=useAdmin();
 const [returnTo,setReturnTo]=useState("/admin/ops/live");
 useEffect(()=>setReturnTo(listReturnTo(new URLSearchParams(window.location.search).get("returnTo"),"/admin/ops/live")),[]);
 const [state,setState]=useState<LiveBroadcast|"loading"|"error"|"missing">("loading");
 const load=useCallback(async()=>{setState("loading");const r=await adminApi<{broadcast:LiveBroadcast}>(`/api/admin/ops/live-broadcasts/${encodeURIComponent(broadcastId)}`);setState(r.ok?r.data.broadcast:r.status===404?"missing":"error");},[broadcastId]);
 useEffect(()=>{void load();},[load]);
 const back=()=>router.push(returnTo);
 return <><AdminTopbar crumb="운영 › 실시간 방송 › 상세"/><main className="main"><PageHead title="방송 상세" actions={<Link className="btn btn-out" href={returnTo}>목록</Link>}/>
 {typeof state==="string"?state==="loading"?<LoadingRows rows={3}/>:<ErrorState title={state==="missing"?"진행 중인 방송을 찾을 수 없습니다.":"방송을 불러오지 못했습니다."} onRetry={()=>void load()}/>:<><section className="card pad-l"><h2>{state.shopName}</h2><p>{state.title??"제목 없음"}</p><Link href={`/admin/partners/${state.sellerId}`}>파트너스 상세</Link></section>
 {adminCan(me.role,"seller.moderate")&&<ForceEndDialog broadcast={state} fullPage onClose={back} onDone={()=>{setFlash("방송을 종료했습니다");back();}} onStale={()=>{setFlash("이미 끝난 방송입니다");back();}}/>}</>}
 </main></>;
}
