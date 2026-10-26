"use client";

import { Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { HitCardOperations } from "../../../../../../components/seller/HitCardOperations";

function HitCardDetail() {
  const { hitCardId } = useParams<{ hitCardId: string }>();
  const query = useSearchParams();
  return <HitCardOperations key={hitCardId} cardId={hitCardId} returnTo={query.get("returnTo")} />;
}

export default function Page() { return <Suspense><HitCardDetail /></Suspense>; }
