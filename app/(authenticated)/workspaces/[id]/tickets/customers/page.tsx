import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { isModuleEnabled } from "@/lib/services/workspace.service";
import { CustomersClient } from "./customers-client";

type Props = { params: { id: string } };

export default async function CustomersPage({ params }: Props) {
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

  return <CustomersClient workspaceId={params.id} />;
}
