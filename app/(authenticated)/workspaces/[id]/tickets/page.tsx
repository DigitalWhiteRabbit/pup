import { auth } from "@/lib/auth";
import { isModuleEnabled } from "@/lib/services/workspace.service";
import { redirect } from "next/navigation";
import { PlaceholderModule } from "@/components/PlaceholderModule";

type Props = { params: { id: string } };

export default async function TicketsPage({ params }: Props) {
  const session = await auth();
  const on = await isModuleEnabled(
    params.id,
    "tickets",
    session!.user.id,
    session!.user.role,
  ).catch(() => {
    redirect("/workspaces");
  });
  if (!on) redirect(`/workspaces/${params.id}`);
  return <PlaceholderModule moduleKey="tickets" workspaceId={params.id} />;
}
