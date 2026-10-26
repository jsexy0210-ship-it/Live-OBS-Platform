"use client";
import { Suspense, use } from "react";
import { useSearchParams } from "next/navigation";
import { ReturnOperations } from "../../../../../../components/seller/ReturnOperations";
function Detail({ id }: { id: string }) { const query = useSearchParams(); return <ReturnOperations key={id} id={id} returnTo={query.get("returnTo")} />; }
export default function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = use(params); return <Suspense><Detail id={id} /></Suspense>; }
