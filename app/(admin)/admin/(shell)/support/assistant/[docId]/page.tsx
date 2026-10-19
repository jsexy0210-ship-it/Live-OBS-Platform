"use client";
import { useParams } from "next/navigation";
import { AssistantDocDetail } from "../../../../_components/AssistantDocDetail";
export default function DocPage() { const { docId } = useParams<{ docId: string }>(); return <AssistantDocDetail docId={docId} />; }
