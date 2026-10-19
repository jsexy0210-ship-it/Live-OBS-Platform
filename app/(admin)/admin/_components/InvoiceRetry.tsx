"use client";
import { useState } from "react";
import { useConfirm } from "../../../../components/admin-ui";
import { adminApi, failMessage } from "./api";
import type { PaymentDetail } from "./payments";
const RETRY_REASON: Record<string, string> = {
  not_found: "청구를 찾을 수 없습니다",
  not_failed: "실패한 청구가 아닙니다",
  not_latest: "최신 청구가 아닙니다",
  not_retryable: "다시 결제할 수 없는 구독입니다",
  too_soon: "5분 안에 다시 시도했습니다",
  not_charged: "결제가 되지 않았습니다",
  charge_failed: "카드가 다시 거절됐습니다",
  charge_pending: "결제 결과를 기다리는 중입니다",
};

export function InvoiceRetry({ payments, onDone }: { payments: PaymentDetail[]; onDone: () => void }) {
 const {confirm} = useConfirm(); const [message,setMessage]=useState<string|null>(null); const [busy,setBusy]=useState(false);
 const eligible=payments.filter(p=>p.canRetry);
 const retry=async()=>{
  if(busy || !eligible.length || eligible.length > 50) return;
  setBusy(true); setMessage(null);
  try {
   const ok=await confirm({title:`실패한 청구 ${eligible.length}건을 다시 결제하시겠습니까?`,body:"등록된 카드로 지금 바로 결제가 시도됩니다 · 결과는 건별로 안내되고 로그 추적에 남습니다 · 아래에 표시한 재시도 가능 건만 대상입니다",confirmLabel:"다시 결제",danger:true,run:async()=>{
    const r=await adminApi<{results:{paymentId:string;ok:boolean;reason?:string}[];succeeded:number;failed:number}>("/api/admin/billing/invoices/retry",{method:"POST",json:{paymentIds:eligible.map(p=>p.id)}});
    if(!r.ok) return failMessage(r,"다시 결제하지 못했습니다. 결과를 확인한 뒤 다시 시도해 주십시오.");
    const bad=r.data.results.filter(x=>!x.ok);
    setMessage(`성공 ${r.data.succeeded}건 · 실패 ${r.data.failed}건${bad.length?` — ${bad.map(x=>`${payments.find(p=>p.id===x.paymentId)?.seller.shopName??"청구"}: ${RETRY_REASON[x.reason??""]??"처리하지 못했습니다"}`).join(" · ")}`:""}`);
   }});
   if(ok) onDone();
  } finally {setBusy(false);}
 };
 return <section className="card pad-l col" style={{gap:12}}><h2>다시 결제</h2><p>재시도 가능 {eligible.length}건 · 현재 상태로 다시 확인했습니다.</p><ul>{payments.map(p=><li key={p.id}>{p.seller.shopName} · {p.amount.toLocaleString("ko-KR")}원 · {p.canRetry?"재시도 가능":RETRY_REASON[p.retryUnavailableReason??""]??"다시 결제할 수 없음"}</li>)}</ul><button className="btn btn-out" style={{alignSelf:"flex-start"}} disabled={busy || !eligible.length || eligible.length>50} onClick={()=>void retry()}>다시 결제</button>{message&&<p role="status">{message}</p>}</section>;
}
