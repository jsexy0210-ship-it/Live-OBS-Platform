"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ShippingOperations } from "../../../../../../components/seller/ShippingOperations";

function SelectedShipments() {
  const query = useSearchParams();
  const ids = query.get("ids") ?? "";
  const action = query.get("action") === "deliver" ? "deliver" : "ship";
  return <ShippingOperations key={`${action}:${ids}`} ids={ids ? ids.split(",") : []} action={action} returnTo={query.get("returnTo")} />;
}

export default function SelectedShipmentPage() {
  return <Suspense><SelectedShipments /></Suspense>;
}
