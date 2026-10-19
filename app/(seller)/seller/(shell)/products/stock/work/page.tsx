"use client";
import { Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { StockWorkspace } from "../../../../../../../components/seller/StockWorkspace";
function Work() { const query = useSearchParams(); const params = useParams<{ productId: string; optionId: string }>(); return <StockWorkspace work selectionKey={query.get("selection")} returnTo={query.get("returnTo")} />; }
export default function Page() { return <Suspense><Work /></Suspense>; }
