"use client";

import { Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { ShippingOperations } from "../../../../../../components/seller/ShippingOperations";

function Shipment() {
  const { orderId } = useParams<{ orderId: string }>();
  const query = useSearchParams();
  return <ShippingOperations key={orderId} ids={[orderId]} single returnTo={query.get("returnTo")} />;
}

export default function ShipmentPage() {
  return <Suspense><Shipment /></Suspense>;
}
