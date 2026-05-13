import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { GlobalChatClient } from "./global-chat-client";

export default async function GlobalChatPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <GlobalChatClient
      currentUserId={session.user.id}
      currentUserLogin={
        (session.user as unknown as { login?: string }).login ?? "user"
      }
    />
  );
}
