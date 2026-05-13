import { auth } from "@/lib/auth";
import { isModuleEnabled } from "@/lib/services/workspace.service";
import { redirect } from "next/navigation";
import { ChatClient } from "./chat-client";

type Props = { params: { id: string } };

export default async function ChatPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");
  const on = await isModuleEnabled(
    params.id,
    "chat",
    session.user.id,
    session.user.role,
  ).catch(() => {
    redirect("/workspaces");
  });
  if (!on) redirect(`/workspaces/${params.id}`);
  return (
    <ChatClient
      workspaceId={params.id}
      currentUserId={session.user.id}
      currentUserLogin={
        (session.user as unknown as { login?: string }).login ?? "user"
      }
    />
  );
}
