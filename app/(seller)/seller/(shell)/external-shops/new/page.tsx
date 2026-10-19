"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ExternalShopOperations } from "../../../../../../components/seller/ExternalShopOperations";

function ExternalDetail() {
  const query = useSearchParams();
  return <ExternalShopOperations returnTo={query.get("returnTo")} />;
}

export default function ExternalDetailPage() { return <Suspense><ExternalDetail /></Suspense>; }
