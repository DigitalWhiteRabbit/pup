import { auth } from "@/lib/auth";
import { isModuleEnabled } from "@/lib/services/workspace.service";
import { redirect } from "next/navigation";
import { UsersModuleClient } from "./users-module-client";

type Props = { params: { id: string } };

export default async function UsersModulePage({ params }: Props) {
  const session = await auth();
  const on = await isModuleEnabled(
    params.id,
    "users",
    session!.user.id,
    session!.user.role,
  ).catch(() => {
    redirect("/workspaces");
  });
  if (!on) redirect(`/workspaces/${params.id}`);

  return <UsersModuleClient workspaceId={params.id} />;
}
