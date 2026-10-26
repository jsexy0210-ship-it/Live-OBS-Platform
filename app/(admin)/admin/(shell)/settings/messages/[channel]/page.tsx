"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { PageHead } from "../../../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../../../components/seller/States";
import { useSmartBack } from "../../../../../../../lib/client/navigation";
import { adminCan } from "../../../../../../../lib/server/authz/permissions";
import { adminApi } from "../../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../../_components/AdminShell";
import { CHANNEL_LABEL, UNIT_PRICE_MAX, type ChannelPrice, type MessageSettings } from "../../../../_components/messageFees";
import { listReturnTo } from "../../../../_components/selection";
import { ValueDialog } from "../../../../_components/ValueDialog";

const LIST = "/admin/settings/messages";
export default function MessagePriceDetailPage() {
  const { channel } = useParams<{ channel: string }>();
  const { me } = useAdmin();
  const canEdit = adminCan(me.role, "billing.price");
  const router = useRouter();
  const [returnTo, setReturnTo] = useState(LIST);
  const smartBack = useSmartBack(returnTo);
  const leaveRef = useRef<((next?: () => void) => Promise<void>) | null>(null);
  const [state, setState] = useState<ChannelPrice | "loading" | "error" | "missing">("loading");
  const reqId = useRef(0);
  useEffect(() => setReturnTo(listReturnTo(new URLSearchParams(window.location.search).get("returnTo"), LIST)), []);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    setState("loading");
    const r = await adminApi<MessageSettings>("/api/admin/message-settings");
    if (id !== reqId.current) return;
    setState(r.ok ? r.data.prices.find(p => p.channel === channel) ?? "missing" : "error");
  }, [channel]);
  useEffect(() => { void load(); return () => { ++reqId.current; }; }, [load]);
  const done = () => router.push(returnTo);
  return <><AdminTopbar crumb="설정 › 발송 단가 › 상세" /><main className="main">
    <PageHead title="발송 단가 상세" back={returnTo} onBack={() => leaveRef.current ? leaveRef.current(smartBack) : smartBack()} actions={<Link className="btn btn-out" href={returnTo}>목록</Link>} />
    {typeof state === "string" ? state === "loading" ? <LoadingRows rows={2} /> : <ErrorState title={state === "missing" ? "발송 종류를 찾을 수 없습니다." : "발송 설정을 불러오지 못했습니다."} onRetry={() => void load()} /> : canEdit ? <ValueDialog key={state.channel} title={`${CHANNEL_LABEL[state.channel]} 단가 변경`} label="단가" unit="원" current={state.unitPrice} max={UNIT_PRICE_MAX} path={`/api/admin/message-prices/${state.channel}`} field="unitPrice" fullPage leaveRef={leaveRef} onClose={smartBack} onDone={done} /> : <section className="card pad-l"><h2>{CHANNEL_LABEL[state.channel]}</h2><p>현재 단가 {state.unitPrice.toLocaleString("ko-KR")}원 · 최고관리자만 바꿀 수 있습니다.</p></section>}
  </main></>;
}
