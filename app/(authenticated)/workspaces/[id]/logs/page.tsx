import { auth } from "@/lib/auth";
import {
  isModuleEnabled,
  checkMembership,
} from "@/lib/services/workspace.service";
import { redirect } from "next/navigation";
import { LogsClient } from "./logs-client";

type Props = { params: { id: string } };

export default async function LogsPage({ params }: Props) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const membership = await checkMembership(params.id, session.user.id).catch(
    () => null,
  );
  if (!membership && session.user.role !== "ADMIN") {
    redirect("/workspaces");
  }

  const on = await isModuleEnabled(
    params.id,
    "logs",
    session.user.id,
    session.user.role,
  ).catch(() => {
    redirect("/workspaces");
  });
  if (!on) redirect(`/workspaces/${params.id}`);

  return <LogsClient workspaceId={params.id} />;
}
