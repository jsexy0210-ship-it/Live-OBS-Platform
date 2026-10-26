"use client";

import { Suspense } from "react";
import { useSearchParams, useParams } from "next/navigation";
import { ExternalShopOperations } from "../../../../../../components/seller/ExternalShopOperations";

function ExternalDetail() {
  const { connectionId } = useParams<{ connectionId: string }>();
  const query = useSearchParams();
  return <ExternalShopOperations key={connectionId} connectionId={connectionId} returnTo={query.get("returnTo")} />;
}

export default function ExternalDetailPage() { return <Suspense><ExternalDetail /></Suspense>; }
