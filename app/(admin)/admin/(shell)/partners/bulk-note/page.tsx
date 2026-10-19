"use client";
import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../../components/seller/States";
import { adminCan } from "../../../../../../lib/server/authz/permissions";
import { AdminTopbar, useAdmin } from "../../../_components/AdminShell";
import { BulkNoteDialog, type BulkNoteResult } from "../../../_components/BulkNoteDialog";
import { adminApi } from "../../../_components/api";
import { listReturnTo, selectedIds } from "../../../_components/selection";
function BulkNotes() {
 const search = useSearchParams(); const router = useRouter(); const { me } = useAdmin();
 const ids = useMemo(() => selectedIds(search.get("ids")), [search]);
 const back = listReturnTo(search.get("returnTo"), "/admin/partners");
 const [names, setNames] = useState<string[] | null>(null);
 const [result, setResult] = useState<BulkNoteResult | null>(null);
 useEffect(() => { let live = true; setNames(null); if(ids) void Promise.all(ids.map(async id => { const r = await adminApi<{ seller: { shopName: string } }>(`/api/admin/sellers/${id}`); return r.ok ? r.data.seller.shopName : "조회할 수 없는 파트너스"; })).then(rows => { if(live) setNames(rows); }); return () => {live=false;}; }, [ids]);
 return <><AdminTopbar crumb="파트너스 › 선택 메모 상세" /><main className="main"><PageHead title="선택한 파트너스 메모" actions={<Link className="btn btn-out" href={back}>목록</Link>} />
 {!adminCan(me.role,"seller.moderate") ? <p role="alert">최고관리자와 운영 담당만 메모를 일괄로 남길 수 있습니다.</p> : !ids ? <p role="alert">파트너스를 1~50곳 선택해 주십시오.</p> : !names ? <LoadingRows rows={3} /> : <><section className="card pad-l"><h2>대상 {ids.length}곳</h2><ul>{names.map((name,i)=><li key={ids[i]}>{name}</li>)}</ul></section>
 {result ? <section className="card pad-l" role="status">{result.created}곳에 메모를 남겼습니다 · {result.failed}곳은 남기지 못했습니다.</section> : <BulkNoteDialog sellerIds={ids} fullPage onClose={()=>router.push(back)} onDone={setResult} />}</>}
 </main></>;
}
export default function BulkNotePage(){return <Suspense fallback={null}><BulkNotes /></Suspense>;}
