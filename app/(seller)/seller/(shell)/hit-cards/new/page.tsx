"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { HitCardOperations } from "../../../../../../components/seller/HitCardOperations";

function HitCardNew() {
  const query = useSearchParams();
  return <HitCardOperations returnTo={query.get("returnTo")} />;
}

export default function Page() { return <Suspense><HitCardNew /></Suspense>; }
