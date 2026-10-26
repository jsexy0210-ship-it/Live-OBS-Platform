import Workspace from "../Workspace";
export default async function Page({ params, searchParams }: { params: Promise<{ itemId: string }>; searchParams: Promise<{ returnTo?: string; kind?: string }> }) {
  const q = await searchParams;
  return <Workspace key={"new"} view="item" itemId="new" kind={q.kind} returnTo={q.returnTo} />;
}
