"use client";
import { Suspense, use } from "react";
import { useSearchParams } from "next/navigation";
import { RewardRetryOperations } from "../../../../../../../components/seller/RewardRetryOperations";
function Detail({ id }: { id: string }) { const query = useSearchParams(); return <RewardRetryOperations key={id} entryId={id} returnTo={query.get("returnTo")} />; }
export default function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = use(params); return <Suspense><Detail id={id} /></Suspense>; }
