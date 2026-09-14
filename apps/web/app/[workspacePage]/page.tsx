import { notFound } from "next/navigation";
import { OriginPostApp } from "@/components/originpost-app";
import { workspacePageSlugs } from "@/lib/workspace-route";

export const dynamicParams = false;

export function generateStaticParams() {
  return workspacePageSlugs.map((workspacePage) => ({ workspacePage }));
}

export default async function WorkspacePage({ params }: { params: Promise<{ workspacePage: string }> }) {
  const { workspacePage } = await params;
  if (!workspacePageSlugs.includes(workspacePage)) notFound();
  return <OriginPostApp />;
}
