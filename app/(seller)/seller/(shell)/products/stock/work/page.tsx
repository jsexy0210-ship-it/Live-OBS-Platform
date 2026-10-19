"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { StockWorkspace } from "../../../../../../../components/seller/StockWorkspace";
function Work() { const query = useSearchParams(); return <StockWorkspace key={query.get("selection") ?? "direct"} work selectionKey={query.get("selection")} returnTo={query.get("returnTo")} />; }
export default function Page() { return <Suspense><Work /></Suspense>; }
