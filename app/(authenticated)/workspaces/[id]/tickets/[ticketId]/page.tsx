import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { isModuleEnabled } from "@/lib/services/workspace.service";
import { TicketDetailClient } from "./ticket-detail-client";

type Props = { params: { id: string; ticketId: string } };

export default async function TicketDetailPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const on = await isModuleEnabled(
    params.id,
    "tickets",
    session.user.id,
    session.user.role,
  ).catch(() => {
    redirect("/workspaces");
  });
  if (!on) redirect(`/workspaces/${params.id}`);

  return (
    <TicketDetailClient
      workspaceId={params.id}
      ticketId={params.ticketId}
      currentUserId={session.user.id}
    />
  );
}
