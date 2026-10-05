import type { Metadata } from "next";
import { Terms } from "../../../components/public/Terms";

export const metadata: Metadata = { title: "이용약관 · ONQ", description: "파트너스(판매자) 이용약관이에요." };

export default function TermsPage() {
  return <Terms />;
}
