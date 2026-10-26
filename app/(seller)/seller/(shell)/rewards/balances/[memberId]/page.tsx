"use client";

import { Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { RewardAdjustment } from "../../../../../../../components/seller/RewardAdjustment";

function AdjustmentDetail() {
  const { memberId } = useParams<{ memberId: string }>();
  const query = useSearchParams();
  return <RewardAdjustment key={memberId} memberId={memberId} returnTo={query.get("returnTo")} />;
}

export default function AdjustmentDetailPage() { return <Suspense><AdjustmentDetail /></Suspense>; }
