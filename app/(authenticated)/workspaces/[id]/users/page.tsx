import { auth } from "@/lib/auth";
import { isModuleEnabled } from "@/lib/services/workspace.service";
import { redirect } from "next/navigation";
import { UsersModuleClient } from "./users-module-client";

type Props = { params: Promise<{ id: string }> };

export default async function UsersModulePage({ params }: Props) {
  const { id } = await params;
  const session = await auth();
  const on = await isModuleEnabled(
    id,
    "users",
    session!.user.id,
    session!.user.role,
  ).catch(() => {
    redirect("/workspaces");
  });
  if (!on) redirect(`/workspaces/${id}`);

  return <UsersModuleClient workspaceId={id} />;
}
