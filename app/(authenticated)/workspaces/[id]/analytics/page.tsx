import { auth } from "@/lib/auth";
import { isModuleEnabled } from "@/lib/services/workspace.service";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
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

  // Check if workspace has an external analytics URL configured
  const ws = await db.workspace.findUnique({
    where: { id: params.id },
    select: { externalAnalyticsUrl: true },
  });
  if (ws?.externalAnalyticsUrl) {
    redirect(ws.externalAnalyticsUrl);
  }

  return <PlaceholderModule moduleKey="analytics" workspaceId={params.id} />;
}
