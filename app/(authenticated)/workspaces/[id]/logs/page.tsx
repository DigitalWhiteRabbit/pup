import { auth } from "@/lib/auth";
import { isModuleEnabled } from "@/lib/services/workspace.service";
import { redirect } from "next/navigation";
import { PlaceholderModule } from "@/components/PlaceholderModule";

type Props = { params: { id: string } };

export default async function LogsPage({ params }: Props) {
  const session = await auth();
  const on = await isModuleEnabled(
    params.id,
    "logs",
    session!.user.id,
    session!.user.role,
  ).catch(() => {
    redirect("/workspaces");
  });
  if (!on) redirect(`/workspaces/${params.id}`);
  return <PlaceholderModule moduleKey="logs" workspaceId={params.id} />;
}
