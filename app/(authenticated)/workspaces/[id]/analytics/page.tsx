import { auth } from "@/lib/auth";
import { isModuleEnabled } from "@/lib/services/workspace.service";
import { redirect } from "next/navigation";
import { PlaceholderModule } from "@/components/PlaceholderModule";

type Props = { params: { id: string } };

export default async function AnalyticsPage({ params }: Props) {
  const session = await auth();
  const on = await isModuleEnabled(
    params.id,
    "analytics",
    session!.user.id,
    session!.user.role,
  ).catch(() => {
    redirect("/workspaces");
  });
  if (!on) redirect(`/workspaces/${params.id}`);

  // P1: previously redirected to workspace.externalAnalyticsUrl — an unvalidated
  // external redirect (open-redirect). Removed: always render the in-development
  // placeholder. The externalAnalyticsUrl field stays in the schema (unused)
  // pending a decision on how to surface it safely.
  return <PlaceholderModule moduleKey="analytics" workspaceId={params.id} />;
}
