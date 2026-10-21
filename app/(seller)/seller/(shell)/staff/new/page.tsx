import Workspace from "../Workspace";
export default async function Page({ params, searchParams }: { params: Promise<{ staffId: string }>; searchParams: Promise<{ returnTo?: string; operation?: string }> }) {
  const q = await searchParams;
  return <Workspace key={"new"} staffId="new" returnTo={q.returnTo} />;
}
