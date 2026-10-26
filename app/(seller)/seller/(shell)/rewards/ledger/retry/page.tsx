"use client";
import { Suspense, use } from "react";
import { useSearchParams } from "next/navigation";
import { RewardRetryOperations } from "../../../../../../../components/seller/RewardRetryOperations";
function Detail() { const query = useSearchParams(); return <RewardRetryOperations returnTo={query.get("returnTo")} />; }
export default function Page() { return <Suspense><Detail /></Suspense>; }
